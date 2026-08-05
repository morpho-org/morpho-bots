import type {
  Backoff,
  BlockSampler,
  CooldownStore,
  Logger,
  SimulateResult,
  SubmitOutcome
} from '@repo/bot-kit'
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
 * Per-tick outcome tally, emitted as `tick.end`. Ordered as the pipeline runs, and exhaustive by
 * construction: for a tick that finished (`complete: true` on the event) these identities hold, so a
 * future stage added without a counter shows up as a broken sum rather than a silent drop.
 *
 *   pairs       >= liquidatable
 *   liquidatable === inflightSkipped + planSkipped + planned
 *   planned      === cooledDown + backoffSkipped + noSwapPath + quoteFailed + ok + reverted
 *   ok           === submitted + notSent
 *
 * They do NOT hold when `complete` is `false`: an aborting `submit` throws after `ok` was counted but
 * before `submitted`/`notSent`, so the last identity is short by one.
 */
type TickCounters = {
  /** Lens inputs read this tick — the discovery universe. */
  pairs: number
  /** Positions the chain says are liquidatable at this block. A market gauge, not a bot decision. */
  liquidatable: number
  /**
   * Skipped because a tx for this label is already in flight. Note the queue's backpressure set also
   * holds labels whose tx SETTLED within `settledCooldownBlocks`, so this can be non-zero while the
   * queue itself is empty.
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
 * `warn` marks a reason that should be impossible, so it reads as a live assertion rather than noise:
 * `no_debt`/`healthy` are the exact negation of `isLiquidatable`, and a non-reverting zero oracle
 * price is a market anomaly. The dust reasons are ordinary and stay `info`.
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
 * Every exit from the per-position loop increments exactly one counter, and `tick.end` is emitted even
 * when a position aborts the tick — with `complete: false`, so partial counters can never be mistaken
 * for a genuinely idle tick.
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
   * Reports whether a transaction actually went out: ONLY `kind: 'sent'` may clear the position's
   * backoff. Throws when a send fails after claiming a nonce — the tick aborts by design, so the
   * signer's cursor rollback is not raced.
   */
  submit: (args: {
    market: MarketParams
    borrower: Address
    plan: LiquidationPlan
    swapPlan: SwapPlan
    blockNumber: bigint
    label: string
  }) => Promise<SubmitOutcome>
  /** Per-position exponential backoff suppressing repeated quote/simulate/send failures (rate-limit defense). */
  backoff: Backoff
  /**
   * Opt-in per-position cooldown, complementary to `backoff`: a fixed wall-clock window suppressing
   * re-quoting a position whose last attempt produced no broadcast tx. Disabled by default
   * (`POSITION_LIQUIDATION_COOLDOWN_MS=0`), in which case `shouldSkip` is always false.
   */
  cooldown: CooldownStore
  /**
   * Bounds how often the per-position `plan.skipped` diagnostic is emitted. Asked at most once per
   * tick and only when there is something to explain, so a quiet stretch never consumes the window:
   * the first skip after any gap is always reported, and a persistent one settles to a single burst
   * per cadence. All lines in a burst share one `chainHead`, so they read as one coherent snapshot.
   */
  planSkipSampler: BlockSampler
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
    planSkipSampler,
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
  // `returned` is always `pairs` (the batch lens maps every input row); `invalid` is the informative
  // one — it counts rows the lens zeroed (unknown market, reverting oracle), which would otherwise be
  // indistinguishable from a healthy position in `pairs - liquidatable`.
  let invalid = 0
  for (const out of lensOut.values()) if (!out.valid) invalid += 1
  logger.info('lens.read', { pairs: pairs.length, returned: lensOut.size, invalid })

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
  // Resolved lazily on the first skip of the tick and reused for the rest, so one tick emits either a
  // full snapshot of the blocker set or nothing — never a staggered subset.
  let explainSkips: boolean | null = null

  const processPairs = async () => {
    for (const pair of pairs) {
      const id = marketId(pair.params)
      const label = lensKey(id, pair.borrower)
      const out = lensOut.get(label)
      if (!out || !isLiquidatable(out)) continue
      counters.liquidatable += 1

      // Backpressure: a tx for this position is already pending — don't re-plan/simulate/submit it
      // every block while it confirms. No log: the queue already narrates this label's whole
      // lifecycle (`tx.sent` → `tx.confirmed`/`tx.reverted`/`tx.dropped`) under the same key.
      if (inflight.has(label)) {
        counters.inflightSkipped += 1
        continue
      }

      const planInput = planInputFromLens(out)
      const planOutcome = planWithReason(planInput)
      if (planOutcome.kind === 'skip') {
        counters.planSkipped += 1
        explainSkips ??= planSkipSampler.claim(chainHead)
        if (explainSkips) {
          // Spread the inputs AND the derived trace so the line is a closed causal chain — an
          // operator can replay sizing from it without re-deriving anything. `marketId`/`borrower`
          // last so a future `PlanInput` field can never shadow them.
          logger[LEVEL_BY_REASON[planOutcome.reason]]('plan.skipped', {
            ...planInput,
            ...planOutcome.trace,
            reason: planOutcome.reason,
            marketId: id,
            borrower: pair.borrower
          })
        }
        continue
      }

      const liquidationPlan = planOutcome.plan
      counters.planned += 1
      logger.info('plan.built', {
        marketId: id,
        borrower: pair.borrower,
        seizedAssets: liquidationPlan.seizedAssets
      })

      // Opt-in cooldown (complementary to backoff): a position whose last attempt produced no
      // broadcast tx is skipped without re-quoting until its wall-clock window elapses. No-op when
      // disabled (POSITION_LIQUIDATION_COOLDOWN_MS=0).
      if (cooldown.shouldSkip(label)) {
        counters.cooledDown += 1
        logger.info('cooldown.skip', { marketId: id, borrower: pair.borrower })
        continue
      }
      // Suppress positions that keep failing to quote/simulate/send — bounds API + RPC usage under a
      // backlog, since executable quotes are spent only on positions not currently backed off.
      if (backoff.shouldSkip(label, chainHead)) {
        counters.backoffSkipped += 1
        continue
      }
      const quote = await quoteFor(liquidationPlan, out, label)
      if (quote.kind === 'no_config') {
        counters.noSwapPath += 1
        cooldown.mark(label)
        logger.info('config.no_swap_path', { marketId: id, borrower: pair.borrower })
        continue
      }
      if (quote.kind === 'failed') {
        counters.quoteFailed += 1
        backoff.record(label, chainHead)
        cooldown.mark(label)
        continue
      }
      const swapPlan = quote.plan

      const result = await simulate({
        market: out.params,
        borrower: pair.borrower,
        plan: liquidationPlan,
        swapPlan
      })
      const fields = { marketId: id, borrower: pair.borrower }
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
      if (result.status !== 'ok') continue

      const sendOutcome = await submit({
        market: out.params,
        borrower: pair.borrower,
        plan: liquidationPlan,
        swapPlan,
        blockNumber: chainHead,
        label
      })
      if (sendOutcome.kind === 'sent') {
        backoff.clear(label)
        counters.submitted += 1
        continue
      }
      counters.notSent += 1
      // Only a per-position send failure earns a backoff. `send_aborted`, `nonce_hole` and
      // `nonce_sync_failed` are queue-WIDE refusals that reject every send this tick, so backing off
      // here would suppress positions that did nothing wrong — for 2, 4, 8… blocks after the latch
      // itself has cleared. The queue has already logged which exit it took.
      if (sendOutcome.reason === 'submit_failed') {
        backoff.record(label, chainHead)
        cooldown.mark(label)
      }
    }
  }

  // Emit counters even when a position aborts the tick (a hashless send after the nonce was claimed
  // throws by design). Without `complete` an aborted tick's partial counters are indistinguishable
  // from a genuinely idle one. `ensureError` preserves the instance, so rethrowing keeps `TxSendError`
  // intact for the runner's `tick.error` decode.
  const { error } = await tryCatch(processPairs())
  logger.info('tick.end', { ...counters, complete: !error })
  if (error) throw error
  return counters
}
