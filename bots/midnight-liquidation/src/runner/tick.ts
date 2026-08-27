import type { Backoff, CooldownStore, Logger, SimulateResult } from '@repo/bot-kit'
import type { QuoteOutcome, SwapPlan } from '@repo/swaps'
import type { Address } from 'viem'

import { assertNever, lensKey, tryCatch } from '@repo/utils'

import type { BorrowerCandidate } from '../discovery/borrowers'
import type { Market } from '../execution/encode-call'
import type { LiquidationPlan, PlanSkipReason } from '../sizing/plan'
import type { LensInput, LensOut } from '../state/lens.sol'

import { isBadDebtRealization, planWithReason } from '../sizing/plan'
import { isLiquidatable, planInputFromLens } from './eligibility'

/**
 * Per-tick outcome tally, emitted as `tick.end`, ordered as the pipeline runs. On a tick that ran to
 * completion (`complete: true`) these identities hold, so a stage added without a counter breaks a
 * sum instead of silently dropping a position:
 *
 * ```text
 * pairs        >= liquidatable
 * liquidatable === inflightSkipped + planSkipped + planned
 * planned      === cooledDown + backoffSkipped + noSwapPath + quoteFailed + ok + reverted
 * ok           === submitted + notSent
 * ```
 *
 * A new loop **exit** must join one of these sums; a new **attribute** of a position that is still
 * worked must not (it would double-count). Any future pre-quote skip therefore belongs in the
 * `planned` sum, and any future plan-stage skip rides `planSkipped`.
 *
 * On `complete: false` the last identity is short by one: an aborting `submit` throws after `ok` was
 * counted.
 */
type TickCounters = {
  /** Lens inputs read this tick — the post-whitelist discovery universe. */
  pairs: number
  /** Positions the chain says are liquidatable at this block. A market gauge, not a bot decision. */
  liquidatable: number
  /**
   * Skipped because a tx for this label is in flight. The queue's backpressure set also holds labels
   * that SETTLED within `settledCooldownBlocks`, so this can be non-zero while the queue is empty.
   */
  inflightSkipped: number
  /** Skipped because sizing produced no plan — see the `plan.skipped` event for the reason. */
  planSkipped: number
  planned: number
  cooledDown: number
  backoffSkipped: number
  noSwapPath: number
  quoteFailed: number
  ok: number
  reverted: number
  /** Broadcast: the queue reported a transaction actually went out. */
  submitted: number
  /** The queue returned without broadcasting (a send failure, or a queue-wide refusal). */
  notSent: number
}

/**
 * Log level per skip reason. The first three negate `isLiquidatable`, so reaching them means we
 * planned a position the chain does not consider liquidatable — the line reads as a live assertion.
 * The rest are ordinary outcomes for a genuinely liquidatable position, so they stay at `info`.
 *
 * A reason that fires identically for every candidate in a group belongs at `debug`: one line per
 * position per block is how the 31 Jul post-mortem ended up with hundreds of identical warnings to
 * wade through.
 */
const LEVEL_BY_REASON: Record<PlanSkipReason, 'debug' | 'info' | 'warn'> = {
  no_debt: 'warn',
  locked: 'warn',
  healthy_pre_maturity: 'warn',
  cap_not_positive: 'info',
  nothing_to_seize: 'info',
  seize_rounds_to_zero: 'info'
}

/**
 * One tick: enumerate the over-inclusive (id, borrower) candidate universe from discovery, read the
 * liquidation lens fresh for the whole batch (one deployless `eth_call`), and for each liquidatable
 * position build a plan, resolve its swap step, simulate the real `exec_606BaXt`, and — when the
 * simulation is `ok` and the position is not already in flight — broadcast it via `submit`.
 * Pending-queue upkeep (`queue.onBlock`) is NOT driven here: the runner runs it as an independent
 * per-block maintenance phase so it survives a discovery/lens failure in this tick. Deps are injected
 * so the tick is unit-testable without a chain, a discovery endpoint, or a signer.
 *
 * Discovery failure is tolerated: a transient error is logged (`discover.error`) and the tick proceeds
 * with zero new candidates. The lens reads every candidate fresh on-chain, so discovery is a coverage
 * source, never a correctness dependency.
 *
 * `tick.end` is emitted even when a position aborts the tick — with `complete: false`, so partial
 * counters can never be mistaken for a genuinely idle tick. See {@link TickCounters} for the
 * counter identities.
 */
export async function runTick(deps: {
  discover: () => Promise<BorrowerCandidate[]>
  /** Chain head the runner just polled — the queue's `submittedAtBlock`. */
  chainHead: bigint
  /** The Executor singleton — the `liquidate` msg.sender whose gate the lens checks. */
  caller: Address
  /** Headroom (bps) shaved off a cap-binding seize for one-block oracle-drift; passed to sizing. */
  seizeCapMarginBps: number
  readLens: (pairs: LensInput[]) => Promise<Map<string, LensOut>>
  /**
   * Fetches ONE executable swap for a liquidatable position from its configured venue (Uniswap is
   * local; aggregators make a single API call). `no_config` → skip with `config.no_swap_path` (no
   * backoff); `failed` → skip and back the position off.
   */
  quoteFor: (plan: LiquidationPlan, out: LensOut, label: string) => Promise<QuoteOutcome>
  simulate: (args: {
    market: Market
    borrower: Address
    plan: LiquidationPlan
    swapPlan: SwapPlan | null
  }) => Promise<SimulateResult>
  /**
   * Broadcasts a plan via the pending queue (builds the exec tx, derives fees, tracks the nonce).
   * Resolves whether a transaction actually went out: ONLY `true` may clear the position's backoff or
   * count as `submitted`. Throws when a send claimed a nonce but produced no hash — the tick aborts
   * by design, so the signer's cursor rollback is not raced.
   */
  submit: (args: {
    market: Market
    borrower: Address
    plan: LiquidationPlan
    swapPlan: SwapPlan | null
    blockNumber: bigint
    label: string
  }) => Promise<boolean>
  /** Per-position exponential backoff suppressing repeated quote/simulate failures (rate-limit defense). */
  backoff: Backoff
  /**
   * Opt-in per-position cooldown, complementary to `backoff`: a fixed wall-clock window suppressing
   * re-attempting a position whose last attempt produced no submittable tx (bad-debt realizations
   * included). Disabled by default (`POSITION_LIQUIDATION_COOLDOWN_MS=0`) — `shouldSkip` always false.
   */
  cooldown: CooldownStore
  /** Labels (`${id}:${borrower}`) already in flight — skipped to avoid re-submitting each block. */
  inflightLabels: () => ReadonlySet<string>
  logger: Logger
}): Promise<TickCounters> {
  const {
    discover,
    chainHead,
    caller,
    seizeCapMarginBps,
    readLens,
    quoteFor,
    simulate,
    submit,
    backoff,
    cooldown,
    inflightLabels,
    logger
  } = deps

  // 1. Discover the over-inclusive (id, borrower) universe → lens inputs (caller = the Executor
  // singleton). A transient discovery failure is non-fatal: log it and proceed with zero candidates
  // so the pending queue (confirmations / fee bumps) below is still driven this block.
  const { data: candidates, error: discoverError } = await tryCatch(discover())
  if (discoverError) logger.warn('discover.error', { error: discoverError.message })
  const pairs: LensInput[] = (candidates ?? []).map(candidate => ({
    id: candidate.marketId,
    borrower: candidate.borrower,
    caller
  }))

  // 2. Read the lens fresh for the whole batch in one deployless eth_call.
  const lensOut = await readLens(pairs)
  logger.info('lens.read', { pairs: pairs.length, returned: lensOut.size })

  const counters: TickCounters = {
    pairs: pairs.length,
    liquidatable: 0,
    inflightSkipped: 0,
    planSkipped: 0,
    planned: 0,
    cooledDown: 0,
    backoffSkipped: 0,
    noSwapPath: 0,
    quoteFailed: 0,
    ok: 0,
    reverted: 0,
    submitted: 0,
    notSent: 0
  }

  // 3. Compose liquidatability off-chain → plan → simulate → submit. `inflight` is captured once;
  // discovery yields distinct (id, borrower) pairs, so no label repeats within a single tick.
  const inflight = inflightLabels()
  let complete = false
  try {
    for (const pair of pairs) {
      const label = lensKey(pair.id, pair.borrower)
      const out = lensOut.get(label)
      if (!out || !isLiquidatable(out)) continue
      counters.liquidatable += 1

      // Backpressure: a tx for this position is already pending — don't re-plan/simulate/submit it
      // every block while it confirms.
      if (inflight.has(label)) {
        counters.inflightSkipped += 1
        continue
      }

      const outcome = planWithReason(planInputFromLens(out), { seizeCapMarginBps })
      if (outcome.plan === null) {
        // Deliberately no backoff and no cooldown: a sizing skip is not a failure, and several
        // reasons clear on their own as chain time advances (see PlanOutcome).
        counters.planSkipped += 1
        logger[LEVEL_BY_REASON[outcome.reason]]('plan.skipped', {
          marketId: pair.id,
          borrower: pair.borrower,
          reason: outcome.reason
        })
        continue
      }
      const liquidationPlan = outcome.plan
      counters.planned += 1
      logger.info('plan.built', {
        marketId: pair.id,
        borrower: pair.borrower,
        collateralIndex: liquidationPlan.collateralIndex,
        seizedAssets: liquidationPlan.seizedAssets,
        repaidUnits: liquidationPlan.repaidUnits,
        postMaturityMode: liquidationPlan.postMaturityMode
      })

      // Opt-in cooldown (complementary to backoff): a position whose last attempt produced no
      // submittable tx is skipped until its wall-clock window elapses — bad-debt realizations included,
      // so a repeatedly-reverting one also backs off. No-op when disabled
      // (POSITION_LIQUIDATION_COOLDOWN_MS=0).
      if (cooldown.shouldSkip(label)) {
        counters.cooledDown += 1
        logger.info('cooldown.skip', { marketId: pair.id, borrower: pair.borrower })
        continue
      }

      // The swap funds repay/seize liquidations. Pure bad-debt realization transfers no assets, so it
      // deliberately skips quoting and executes as a no-callback `liquidate`.
      let swapPlan: SwapPlan | null = null
      if (!isBadDebtRealization(liquidationPlan)) {
        // Suppress positions that keep failing to quote/simulate — bounds API + RPC usage under a
        // backlog, since executable quotes are spent only on positions not currently backed off.
        if (backoff.shouldSkip(label, chainHead)) {
          counters.backoffSkipped += 1
          continue
        }
        const quote = await quoteFor(liquidationPlan, out, label)
        if (quote.kind === 'no_config') {
          counters.noSwapPath += 1
          cooldown.mark(label)
          logger.info('config.no_swap_path', {
            marketId: pair.id,
            borrower: pair.borrower,
            collateralIndex: liquidationPlan.collateralIndex
          })
          continue
        }
        if (quote.kind === 'failed') {
          counters.quoteFailed += 1
          backoff.record(label, chainHead)
          cooldown.mark(label)
          continue
        }
        swapPlan = quote.plan
      }

      const result = await simulate({
        market: out.market,
        borrower: pair.borrower,
        plan: liquidationPlan,
        swapPlan
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
          cooldown.mark(label)
          logger.warn('simulate.revert', { ...fields, reason: result.reason })
          break
        default:
          assertNever(result.status)
      }

      // ok-only gate (Amendment §10): broadcast only a fully-simulated, swap-funded liquidation. Any
      // revert — not-liquidatable, swap slippage, repay shortfall — isn't a fundable plan, so skip it.
      if (result.status === 'ok') {
        const sent = await submit({
          market: out.market,
          borrower: pair.borrower,
          plan: liquidationPlan,
          swapPlan,
          blockNumber: chainHead,
          label
        })
        if (sent) {
          backoff.clear(label)
          counters.submitted += 1
        } else {
          // No broadcast happened, so the position's failure history stands: clearing backoff here is
          // what let a failing position reset to attempt 1 and re-quote every other block. Not
          // recording backoff either — a queue refusal says nothing about this position.
          counters.notSent += 1
        }
      }
    }
    complete = true
  } finally {
    logger.info('tick.end', { ...counters, complete })
  }
  return counters
}
