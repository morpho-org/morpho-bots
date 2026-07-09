import type { Backoff, Logger, SimulateResult } from '@repo/bot-kit'
import type { QuoteOutcome, Swap } from '@repo/swaps'
import type { Address } from 'viem'

import { assertNever, tryCatch } from '@repo/utils'

import type { BorrowerCandidate } from '../discovery/borrowers'
import type { Market } from '../execution/encode-call'
import type { LiquidationPlan } from '../sizing/plan'
import type { LensInput, LensOut } from '../state/lens.sol'

import { isBadDebtRealization, plan } from '../sizing/plan'
import { lensKey } from '../state/lens.sol'
import { isLiquidatable, planInputFromLens } from './eligibility'

/** Blocks our rindexer may trail the chain head before we warn that coverage is degraded. */
const MAX_RINDEXER_LAG_BLOCKS = 30n

type TickCounters = {
  pairs: number
  liquidatable: number
  planned: number
  noSwapPath: number
  quoteFailed: number
  backoffSkipped: number
  ok: number
  reverted: number
  submitted: number
}

/**
 * One tick: log a rindexer-freshness signal, enumerate the indexed (id, borrower) universe, read the
 * liquidation lens fresh for the whole batch (one deployless `eth_call`), and for each liquidatable
 * position build a plan, resolve its swap step, simulate the real `exec_606BaXt`, and — when the
 * simulation is `ok` and the position is not already in flight — broadcast it via `submit`. Finally
 * drive the pending queue's `onBlock`. Deps are injected so the tick is unit-testable without a
 * chain, Postgres, or signer.
 *
 * No staleness skip: the lens reads every candidate fresh on-chain, so rindexer lag is coverage
 * latency, never a correctness issue — we emit `rindexer.lag` for observability and always proceed.
 */
export async function runTick(deps: {
  discover: () => Promise<BorrowerCandidate[]>
  /** rindexer's indexed head (Postgres); `null`/throw → lag unknown, we proceed. */
  syncedBlock: () => Promise<bigint | null>
  /** Chain head the runner just polled — lag reference + the queue's `submittedAtBlock`. */
  chainHead: bigint
  /** The Executor singleton — the `liquidate` msg.sender whose gate the lens checks. */
  caller: Address
  /** Headroom (bps) shaved off a cap-binding seize for one-block oracle-drift; passed to `plan()`. */
  seizeCapMarginBps: number
  readLens: (pairs: LensInput[]) => Promise<Map<string, LensOut>>
  /**
   * Fetches ONE executable swap for a liquidatable position from its configured venue (Uniswap is
   * local; aggregators make a single API call). `no_config` → skip with `config.no_swap_path` (no
   * backoff); `failed` → skip and back the position off.
   */
  quoteFor: (plan: LiquidationPlan, out: LensOut) => Promise<QuoteOutcome>
  simulate: (args: {
    market: Market
    borrower: Address
    plan: LiquidationPlan
    swap: Swap | null
  }) => Promise<SimulateResult>
  /** Broadcasts a plan via the pending queue (builds the exec tx, derives fees, tracks the nonce). */
  submit: (args: {
    market: Market
    borrower: Address
    plan: LiquidationPlan
    swap: Swap | null
    blockNumber: bigint
    label: string
  }) => Promise<void>
  /** Per-position exponential backoff suppressing repeated quote/simulate failures (rate-limit defense). */
  backoff: Backoff
  /** Confirmations / stuck-detection / fee-bumps for already-pending txs. */
  pendingOnBlock: (blockNumber: bigint) => Promise<void>
  /** Labels (`${id}:${borrower}`) already in flight — skipped to avoid re-submitting each block. */
  inflightLabels: () => ReadonlySet<string>
  logger: Logger
}): Promise<TickCounters> {
  const {
    discover,
    syncedBlock,
    chainHead,
    caller,
    seizeCapMarginBps,
    readLens,
    quoteFor,
    simulate,
    submit,
    backoff,
    pendingOnBlock,
    inflightLabels,
    logger
  } = deps

  // 1. rindexer-freshness signal — observability only (see the note above; we never skip).
  // tryCatch resolves `data` to null on a thrown query; `syncedBlock` also returns null when the
  // head is unknown — both mean "lag unknown".
  const { data: synced } = await tryCatch(syncedBlock())
  if (synced === null) {
    logger.warn('rindexer.lag', { reason: 'unknown', chainHead })
  } else {
    const lag = chainHead > synced ? chainHead - synced : 0n
    if (lag > MAX_RINDEXER_LAG_BLOCKS) logger.warn('rindexer.lag', { chainHead, synced, lag })
    else logger.debug('rindexer.lag', { chainHead, synced, lag })
  }

  // 2. Discover the (id, borrower) universe → lens inputs (caller = the Executor singleton).
  const candidates = await discover()
  const pairs: LensInput[] = candidates.map(candidate => ({
    id: candidate.marketId,
    borrower: candidate.borrower,
    caller
  }))

  // 3. Read the lens fresh for the whole batch in one deployless eth_call.
  const lensOut = await readLens(pairs)
  logger.info('lens.read', { pairs: pairs.length, returned: lensOut.size })

  const counters: TickCounters = {
    pairs: pairs.length,
    liquidatable: 0,
    planned: 0,
    noSwapPath: 0,
    quoteFailed: 0,
    backoffSkipped: 0,
    ok: 0,
    reverted: 0,
    submitted: 0
  }

  // 4. Compose liquidatability off-chain → plan → simulate → submit. `inflight` is captured once;
  // discovery yields distinct (id, borrower) pairs, so no label repeats within a single tick.
  const inflight = inflightLabels()
  for (const pair of pairs) {
    const label = lensKey(pair.id, pair.borrower)
    const out = lensOut.get(label)
    if (!out || !isLiquidatable(out)) continue
    counters.liquidatable += 1

    // Backpressure: a tx for this position is already pending — don't re-plan/simulate/submit it
    // every block while it confirms.
    if (inflight.has(label)) continue

    const liquidationPlan = plan(planInputFromLens(out), { seizeCapMarginBps })
    if (!liquidationPlan) continue
    counters.planned += 1
    logger.info('plan.built', {
      marketId: pair.id,
      borrower: pair.borrower,
      collateralIndex: liquidationPlan.collateralIndex,
      seizedAssets: liquidationPlan.seizedAssets,
      repaidUnits: liquidationPlan.repaidUnits,
      postMaturityMode: liquidationPlan.postMaturityMode
    })

    // The swap funds repay/seize liquidations. Pure bad-debt realization transfers no assets, so it
    // deliberately skips quoting and executes as a no-callback `liquidate`.
    let swap: Swap | null = null
    if (!isBadDebtRealization(liquidationPlan)) {
      // Suppress positions that keep failing to quote/simulate — bounds API + RPC usage under a
      // backlog, since executable quotes are spent only on positions not currently backed off.
      if (backoff.shouldSkip(label, chainHead)) {
        counters.backoffSkipped += 1
        continue
      }
      const outcome = await quoteFor(liquidationPlan, out)
      if (outcome.kind === 'no_config') {
        counters.noSwapPath += 1
        logger.info('config.no_swap_path', {
          marketId: pair.id,
          borrower: pair.borrower,
          collateralIndex: liquidationPlan.collateralIndex
        })
        continue
      }
      if (outcome.kind === 'failed') {
        counters.quoteFailed += 1
        backoff.record(label, chainHead)
        continue
      }
      swap = outcome.swap
    }

    const result = await simulate({
      market: out.market,
      borrower: pair.borrower,
      plan: liquidationPlan,
      swap
    })
    const fields = { marketId: pair.id, borrower: pair.borrower }
    switch (result.status) {
      case 'ok':
        counters.ok += 1
        logger.info('simulate.ok', fields)
        break
      case 'revert':
        counters.reverted += 1
        // Back off: a sim revert (stale quote, transient unliquidatability) shouldn't re-quote +
        // re-simulate this position every block.
        backoff.record(label, chainHead)
        logger.warn('simulate.revert', { ...fields, reason: result.reason })
        break
      default:
        assertNever(result.status)
    }

    // ok-only gate (Amendment §10): broadcast only a fully-simulated, swap-funded liquidation. Any
    // revert — not-liquidatable, swap slippage, repay shortfall — isn't a fundable plan, so skip it.
    if (result.status === 'ok') {
      await submit({
        market: out.market,
        borrower: pair.borrower,
        plan: liquidationPlan,
        swap,
        blockNumber: chainHead,
        label
      })
      backoff.clear(label)
      counters.submitted += 1
    }
  }

  // 5. Confirmations / stuck-detection / fee-bumps for the pending set (incl. prior ticks).
  await pendingOnBlock(chainHead)

  logger.info('tick.end', { ...counters })
  return counters
}
