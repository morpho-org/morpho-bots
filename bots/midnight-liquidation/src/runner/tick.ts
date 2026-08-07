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
import type { Market } from '../execution/encode-call'
import type { LiquidationPlan, PlanSkipReason } from '../sizing/plan'
import type { LensInput, LensOut } from '../state/lens.sol'

import { isBadDebtRealization, planWithReason } from '../sizing/plan'
import { isLiquidatable, planInputFromLens } from './eligibility'

/**
 * Per-tick outcome tally, emitted as `tick.end`, ordered as the pipeline runs. For a tick that
 * finished (`complete: true`) these identities hold, so a stage added without a counter breaks a sum
 * instead of silently dropping a position:
 *
 *   pairs       >= liquidatable
 *   liquidatable === inflightSkipped + planSkipped + planned
 *   planned      === cooledDown + backoffSkipped + noSwapPath + quoteFailed + ok + reverted
 *   ok           === submitted + notSent
 *
 * On `complete: false` the last is short by one: an aborting `submit` throws after `ok` was counted.
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
 * `warn` marks a reason that should be unreachable — the first three negate `isLiquidatable`, and
 * `cap_not_positive` means the RCF numerator went negative — so the line reads as a live assertion.
 */
const LEVEL_BY_REASON: Record<PlanSkipReason, 'info' | 'warn'> = {
  no_debt: 'warn',
  locked: 'warn',
  healthy_pre_maturity: 'warn',
  cap_not_positive: 'warn',
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
 * Every exit from the per-position loop increments exactly one counter, and `tick.end` is emitted even
 * when a position aborts the tick — with `complete: false`, so partial counters can never be mistaken
 * for a genuinely idle tick.
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
   * Reports whether a transaction actually went out: ONLY `kind: 'sent'` may clear the position's
   * backoff. Throws when a send fails after claiming a nonce — the tick aborts by design, so the
   * signer's cursor rollback is not raced.
   */
  submit: (args: {
    market: Market
    borrower: Address
    plan: LiquidationPlan
    swapPlan: SwapPlan | null
    blockNumber: bigint
    label: string
  }) => Promise<SubmitOutcome>
  /** Per-position exponential backoff suppressing repeated quote/simulate/send failures (rate-limit defense). */
  backoff: Backoff
  /**
   * Opt-in per-position cooldown, complementary to `backoff`: a fixed wall-clock window suppressing
   * re-attempting a position whose last attempt produced no broadcast tx (bad-debt realizations
   * included). Disabled by default (`POSITION_LIQUIDATION_COOLDOWN_MS=0`) — `shouldSkip` always false.
   */
  cooldown: CooldownStore
  /**
   * Bounds how often the per-position `plan.skipped` diagnostic is emitted. Asked at most once per
   * tick, so every line in a burst shares one `chainHead` and reads as a single snapshot.
   */
  planSkipSampler: BlockSampler
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
    planSkipSampler,
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
  // `returned` always equals `pairs` (the batch lens maps every input row); `invalid` is the
  // informative one — a row the lens zeroed (unknown market, reverting oracle) would otherwise be
  // indistinguishable from a healthy position inside `pairs - liquidatable`.
  const invalid = [...lensOut.values()].filter(out => !out.valid).length
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

  // 3. Compose liquidatability off-chain → plan → simulate → submit. `inflight` is captured once;
  // discovery yields distinct (id, borrower) pairs, so no label repeats within a single tick.
  const inflight = inflightLabels()
  // Resolved on the first skip and reused, so a tick emits the whole blocker set or none of it.
  let explainSkips: boolean | null = null

  const processPairs = async () => {
    for (const pair of pairs) {
      const label = lensKey(pair.id, pair.borrower)
      const out = lensOut.get(label)
      if (!out || !isLiquidatable(out)) continue
      counters.liquidatable += 1

      // Backpressure: don't re-plan/simulate/submit while a tx confirms. No log — the queue already
      // narrates this label end to end (`tx.sent` → `tx.confirmed`/`tx.reverted`/`tx.dropped`).
      if (inflight.has(label)) {
        counters.inflightSkipped += 1
        continue
      }

      const planInput = planInputFromLens(out)
      const outcome = planWithReason(planInput, { seizeCapMarginBps })
      if (outcome.kind === 'skip') {
        counters.planSkipped += 1
        explainSkips ??= planSkipSampler.claim(chainHead)
        if (explainSkips) {
          // Inputs AND derived trace, so sizing replays from this one line. `marketId`/`borrower`
          // last, so a future `PlanInput` field can never shadow them.
          logger[LEVEL_BY_REASON[outcome.reason]]('plan.skipped', {
            ...planInput,
            ...outcome.trace,
            marginBps: seizeCapMarginBps,
            reason: outcome.reason,
            marketId: pair.id,
            borrower: pair.borrower
          })
        }
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
      // broadcast tx is skipped until its wall-clock window elapses — bad-debt realizations included,
      // so a repeatedly-reverting one also backs off. No-op when disabled
      // (POSITION_LIQUIDATION_COOLDOWN_MS=0).
      if (cooldown.shouldSkip(label)) {
        counters.cooledDown += 1
        logger.info('cooldown.skip', { marketId: pair.id, borrower: pair.borrower })
        continue
      }

      // Suppress positions that keep failing to quote/simulate/send — bounds API + RPC usage under a
      // backlog. Checked for EVERY plan, bad-debt realizations included: they skip quoting but still
      // cost a simulation and a send, so a repeatedly-failing one must back off too.
      if (backoff.shouldSkip(label, chainHead)) {
        counters.backoffSkipped += 1
        continue
      }

      // The swap funds repay/seize liquidations. Pure bad-debt realization transfers no assets, so it
      // deliberately skips quoting and executes as a no-callback `liquidate`.
      let swapPlan: SwapPlan | null = null
      if (!isBadDebtRealization(liquidationPlan)) {
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

      // ok-only gate: broadcast only a fully-simulated, swap-funded liquidation. Any revert — not
      // liquidatable, swap slippage, repay shortfall — isn't a fundable plan, so skip it.
      if (result.status !== 'ok') continue

      const sendOutcome = await submit({
        market: out.market,
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
      // Only a per-position send failure earns a backoff. The other reasons are queue-WIDE refusals
      // that reject every send this tick, so backing off here would suppress positions that did
      // nothing wrong, for 2, 4, 8… blocks after the latch itself cleared.
      if (sendOutcome.reason === 'submit_failed') {
        backoff.record(label, chainHead)
        cooldown.mark(label)
      }
    }
  }

  // Emit counters even when a position aborts the tick (a hashless send after the nonce was claimed
  // throws by design) — without `complete`, partial counters look exactly like an idle tick.
  // `tryCatch` preserves the error instance, so the rethrow keeps `TxSendError` intact downstream.
  const { error } = await tryCatch(processPairs())
  if (counters.planSkipped === 0) planSkipSampler.reset()
  logger.info('tick.end', { ...counters, complete: !error })
  if (error) throw error
  return counters
}
