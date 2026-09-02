import type { Backoff, CooldownStore, Logger, SimulateResult, SubmitOutcome } from '@repo/bot-kit'
import type { QuoteOutcome, SwapPlan } from '@repo/swaps'
import type { Address } from 'viem'

import { assertNever, lensKey, tryCatch } from '@repo/utils'

import type { BorrowerCandidate } from '../discovery/borrowers'
import type { MarketParams } from '../market'
import type { LiquidationPlan, PlanSkipReason } from '../sizing/plan'
import type { LensInput, LensOut } from '../state/lens.sol'

import { marketId } from '../market'
import { planWithReason } from '../sizing/plan'
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
 * A Blue market has exactly one collateral, so one position is one candidate and every identity is
 * per position — unlike `bots/midnight-liquidation`, whose `(slot, mode)` alternatives split the
 * middle sum in two. A new loop **exit** must join one of these sums; a new **attribute** of a
 * position that is still worked must not (it would double-count).
 *
 * On `complete: false` the `ok` identity is short by one: an aborting `submit` throws after `ok` was
 * counted and before either of its terms is.
 */
type TickCounters = {
  /** Lens inputs read this tick — the discovery universe. */
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
 * `warn` marks a reason that should not happen, so the line reads as a live assertion: `no_debt` and
 * `healthy` negate `isLiquidatable`, and a non-reverting zero oracle price is a market anomaly. The
 * other two are ordinary outcomes for a genuinely liquidatable position, so they stay at `info`.
 */
const LEVEL_BY_REASON: Record<PlanSkipReason, 'info' | 'warn'> = {
  no_debt: 'warn',
  healthy: 'warn',
  zero_price: 'warn',
  no_collateral: 'info',
  seize_rounds_to_zero: 'info'
}

/**
 * One tick: enumerate the API-discovered (market, borrower) universe, read the liquidation lens
 * fresh for the whole batch (one deployless `eth_call`), and for each liquidatable position build a
 * seize-exact plan, resolve its swap, simulate the real `exec_606BaXt`, and — when the simulation is
 * `ok` and the position is not already in flight — broadcast it via `submit`. Pending-queue upkeep
 * (`queue.onBlock`) is NOT driven here: the runner runs it as an independent per-block maintenance
 * phase so it survives a discovery/lens failure in this tick. Deps are injected so the tick is
 * unit-testable without a chain, API, or signer.
 *
 * Discovery failure is tolerated: a transient error is logged (`discover.error`) and the tick proceeds
 * with zero new candidates. The lens reads every candidate fresh on-chain, so discovery is a coverage
 * source, never a correctness dependency — API indexing lag is coverage latency only.
 *
 * `tick.end` is emitted even when a position aborts the tick — with `complete: false`, so partial
 * counters can never be mistaken for a genuinely idle tick. See {@link TickCounters} for the
 * counter identities.
 */
export async function runTick(deps: {
  discover: () => Promise<BorrowerCandidate[]>
  /** Chain head the runner just polled — the queue's `submittedAtBlock`. */
  chainHead: bigint
  readLens: (pairs: LensInput[]) => Promise<Map<string, LensOut>>
  /**
   * Fetches ONE executable swap for a liquidatable position from its configured venue (Uniswap is
   * local; aggregators make a single API call). `no_config` → skip with `config.no_swap_path` (no
   * backoff); `failed` → skip and back the position off.
   */
  quoteFor: (plan: LiquidationPlan, out: LensOut, label: string) => Promise<QuoteOutcome>
  simulate: (args: {
    market: MarketParams
    borrower: Address
    plan: LiquidationPlan
    swapPlan: SwapPlan
  }) => Promise<SimulateResult>
  /**
   * Broadcasts a plan via the pending queue (builds the exec tx, derives fees, tracks the nonce).
   * Resolves whether a transaction actually went out: ONLY `sent: true` may clear the
   * position's backoff or count as `submitted`. A `sent: false` outcome carries why, and the two
   * reasons are not interchangeable — see {@link SubmitOutcome}. Throws when a send claimed a nonce but produced no hash — the tick aborts by
   * design, so the signer's cursor rollback is not raced.
   */
  submit: (args: {
    market: MarketParams
    borrower: Address
    plan: LiquidationPlan
    swapPlan: SwapPlan
    blockNumber: bigint
    label: string
  }) => Promise<SubmitOutcome>
  /** Per-position exponential backoff suppressing repeated quote/simulate failures (rate-limit defense). */
  backoff: Backoff
  /**
   * Opt-in per-position cooldown, complementary to `backoff`: a fixed wall-clock window suppressing
   * re-quoting a position whose last attempt produced no submittable tx. Disabled by default
   * (`POSITION_LIQUIDATION_COOLDOWN_MS=0`), in which case `shouldSkip` is always false.
   */
  cooldown: CooldownStore
  /** Labels (`${id}:${borrower}`) already in flight — skipped to avoid re-submitting each block. */
  inflightLabels: () => ReadonlySet<string>
  logger: Logger
}): Promise<TickCounters> {
  const {
    discover,
    chainHead,
    readLens,
    quoteFor,
    simulate,
    submit,
    backoff,
    cooldown,
    inflightLabels,
    logger
  } = deps

  // 1. Discover the (marketParams, borrower) universe → lens inputs. The lens re-derives the id from
  //    params on-chain, so no `caller`/gate is threaded (Blue is permissionless). A transient
  //    discovery failure is non-fatal: log it and proceed with zero candidates so the pending queue
  //    (confirmations / fee bumps) maintained below is still driven this block.
  const { data: candidates, error: discoverError } = await tryCatch(discover())
  if (discoverError) logger.warn('discover.error', { error: discoverError.message })
  const pairs: LensInput[] = (candidates ?? []).map(candidate => ({
    params: candidate.marketParams,
    borrower: candidate.borrower
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

  // 3. Compose liquidatability off-chain → plan → quote → simulate → submit. `inflight` is captured
  //    once; discovery yields distinct (market, borrower) pairs, so no label repeats within a tick.
  const inflight = inflightLabels()
  let complete = false
  try {
    for (const pair of pairs) {
      const id = marketId(pair.params)
      const label = lensKey(id, pair.borrower)
      const out = lensOut.get(label)
      if (!out || !isLiquidatable(out)) continue
      counters.liquidatable += 1

      // Backpressure: a tx for this position is already pending — don't re-plan/simulate/submit it
      // every block while it confirms. No log: the queue already narrates this label end to end
      // (`tx.sent` → `tx.confirmed` / `tx.reverted` / `tx.dropped`).
      if (inflight.has(label)) {
        counters.inflightSkipped += 1
        continue
      }

      // A sizing skip is not a failure (see `PlanOutcome`): no backoff, no cooldown, just the reason.
      const { plan: liquidationPlan, reason } = planWithReason(planInputFromLens(out))
      if (!liquidationPlan) {
        counters.planSkipped += 1
        logger[LEVEL_BY_REASON[reason]]('plan.skipped', {
          id: label,
          marketId: id,
          borrower: pair.borrower,
          reason
        })
        continue
      }
      counters.planned += 1
      logger.info('plan.built', {
        id: label,
        marketId: id,
        borrower: pair.borrower,
        seizedAssets: liquidationPlan.seizedAssets
      })

      // Opt-in cooldown (complementary to backoff): a position whose last attempt produced no
      // submittable tx is skipped without re-quoting until its wall-clock window elapses. No-op when
      // disabled (POSITION_LIQUIDATION_COOLDOWN_MS=0).
      if (cooldown.shouldSkip(label)) {
        counters.cooledDown += 1
        logger.info('cooldown.skip', { id: label, marketId: id, borrower: pair.borrower })
        continue
      }
      // Suppress positions that keep failing to quote/simulate — bounds API + RPC usage under a
      // backlog, since executable quotes are spent only on positions not currently backed off.
      if (backoff.shouldSkip(label, chainHead)) {
        counters.backoffSkipped += 1
        continue
      }
      const outcome = await quoteFor(liquidationPlan, out, label)
      if (outcome.kind === 'no_config') {
        counters.noSwapPath += 1
        cooldown.mark(label)
        logger.info('config.no_swap_path', { id: label, marketId: id, borrower: pair.borrower })
        continue
      }
      if (outcome.kind === 'failed') {
        counters.quoteFailed += 1
        backoff.record(label, chainHead)
        cooldown.mark(label)
        continue
      }
      const swapPlan = outcome.plan

      const result = await simulate({
        market: out.params,
        borrower: pair.borrower,
        plan: liquidationPlan,
        swapPlan
      })
      const fields = { id: label, marketId: id, borrower: pair.borrower }
      switch (result.status) {
        case 'ok':
          counters.ok += 1
          logger.info('simulate.ok', fields)
          break
        case 'revert':
          counters.reverted += 1
          // Back off: a sim revert (stale quote, transient unliquidatability, oracle drift) shouldn't
          // re-quote + re-simulate this position every block.
          backoff.record(label, chainHead)
          cooldown.mark(label)
          logger.warn('simulate.revert', { ...fields, reason: result.reason })
          break
        default:
          assertNever(result.status)
      }

      // ok-only gate: broadcast only a fully-simulated, swap-funded liquidation. Any revert — not
      // liquidatable, swap slippage, repay shortfall — isn't a fundable plan, so skip it.
      if (result.status === 'ok') {
        const outcome = await submit({
          market: out.params,
          borrower: pair.borrower,
          plan: liquidationPlan,
          swapPlan,
          blockNumber: chainHead,
          label
        })
        if (outcome.sent) {
          backoff.clear(label)
          counters.submitted += 1
        } else {
          // Nothing was broadcast, so the position's failure history stands: clearing backoff here is
          // what let a failing position reset to attempt 1 and re-quote every other block.
          counters.notSent += 1
          // A rejected send is a fact about THIS position, and backoff is the only thing stopping the next
          // block from re-quoting, re-simulating and re-sending it — reaching this line at all means any
          // earlier entry had already expired, so leaving it untouched suppresses nothing. A queue-wide
          // refusal says nothing about the position, so it records nothing.
          // Blue keeps backoff on every rejected send, including an execution revert, because its
          // liquidation incentive is static — unlike midnight, which exempts that case. See
          // docs/decisions/TIB-2026-08-28-midnight-send-shortfall-classification.md.
          if (outcome.reason === 'send_failed') backoff.record(label, chainHead)
        }
      }
    }
    complete = true
  } finally {
    logger.info('tick.end', { ...counters, complete })
  }
  return counters
}
