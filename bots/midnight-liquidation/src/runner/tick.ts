import type { Backoff, CooldownStore, Logger, SimulateResult, SubmitOutcome } from '@repo/bot-kit'
import type { QuoteOutcome, SwapPlan } from '@repo/swaps'
import type { Address } from 'viem'

import { assertNever, lensKey, tryCatch } from '@repo/utils'
import { formatUnits } from 'viem'

import type { BorrowerCandidate } from '../discovery/borrowers'
import type { Market } from '../execution/encode-call'
import type { LiquidationPlan, PlanSkipReason } from '../sizing/plan'
import type { LensInput, LensOut } from '../state/lens.sol'

import { USD_PRICE_SCALE_DECIMALS } from '../discovery/token-prices'
import { isBadDebtRealization, planSurplus, planWithReason } from '../sizing/plan'
import { isLiquidatable, planInputFromLens } from './eligibility'
import { assessProfitability } from './profitability'
import { rankByUsdSurplus } from './ranking'

/**
 * Per-tick outcome tally, emitted as `tick.end`, ordered as the pipeline runs. On a tick that ran to
 * completion (`complete: true`) these identities hold, so a stage added without a counter breaks a
 * sum instead of silently dropping a position:
 *
 * ```text
 * pairs        >= liquidatable
 * liquidatable === inflightSkipped + planSkipped + planned
 * planned      === cooledDown + backoffSkipped + noSwapPath + quoteFailed + quoteUnprofitable + ok + reverted
 * ok           === submitted + notSent
 * ```
 *
 * A new loop **exit** must join one of these sums; a new **attribute** of a position that is still
 * worked must not (it would double-count). Any future pre-quote skip therefore belongs in the
 * `planned` sum, and any future plan-stage skip rides `planSkipped`. `unpriced` is an attribute: an
 * unpriced candidate is still worked, just ordered last, so it deliberately joins no sum.
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
  /**
   * Quoted successfully, but the route could not cover the repay `liquidate` would pull. An economic
   * skip, not a failure: deliberately no backoff and no cooldown, because both sides of the comparison
   * move on a ten-second scale — the LIF ramp lifts break-even while route cost is itself volatile —
   * so this outcome says almost nothing about the next attempt.
   */
  quoteUnprofitable: number
  ok: number
  reverted: number
  /** Broadcast: the queue reported a transaction actually went out. */
  submitted: number
  /** The queue returned without broadcasting (a send failure, or a queue-wide refusal). */
  notSent: number
  /**
   * Planned candidates whose loan token had no usable USD price, so they were ordered last rather than
   * ranked. An attribute of a worked position, not a loop exit — it joins no identity. A persistently
   * high value means the price snapshot is not covering the loan tokens we actually liquidate.
   */
  unpriced: number
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
  seize_rounds_to_zero: 'info',
  // Unliquidatable in normal mode rather than transient: it clears only when the oracle moves or the
  // position matures into post-maturity mode, where the RCF cap does not apply.
  writeoff_below_max_debt: 'info',
  // Group property, not a per-position one: headroom is `(lif - 1)/lif`, so every candidate sharing a
  // (maturity, maxLif, chosen mode) group is skipped together. At `info` that is one line per position
  // per block — the shape that gave the 31 Jul post-mortem hundreds of identical warnings.
  insufficient_headroom: 'debug'
}

/** One candidate that produced a plan in phase A, carrying its score so phase B can be ordered. */
type SizedCandidate = {
  pair: LensInput
  label: string
  out: LensOut
  plan: LiquidationPlan
  /** Oracle-only surplus in loan units — see {@link planSurplus}. Logged for forensics. */
  surplus: bigint
  /** {@link SizedCandidate.surplus} in USD at `10 ** USD_PRICE_SCALE_DECIMALS`; `null` when unpriced. */
  surplusUsd: bigint | null
}

/**
 * Phase A of a tick: turn the fresh lens batch into sized, scored candidates. Filters to positions the
 * chain says are liquidatable and not already in flight, sizes each one, and scores it by oracle
 * surplus converted to USD.
 *
 * **Deliberately synchronous, and the type signature is the enforcement.** `await` here would add
 * latency to exactly the maturity burst the ordering exists to win, and — less obviously — it would
 * break the ranking's internal consistency: the price snapshot is replaced wholesale by an independent
 * refresh loop, so yielding mid-phase would score some candidates against one snapshot and the rest
 * against the next. Because this function is not `async`, both hazards are compile errors rather than
 * review comments. Keep it that way; if a future stage genuinely needs I/O, it belongs in phase B.
 *
 * Side effect: increments `counters` in place (`liquidatable`, `inflightSkipped`, `planSkipped`,
 * `planned`, `unpriced`) and emits `plan.skipped` for each position sizing rejected. A sizing skip
 * records neither backoff nor cooldown — see {@link PlanOutcome}.
 */
const sizeCandidates = (deps: {
  pairs: readonly LensInput[]
  lensOut: Map<string, LensOut>
  inflight: ReadonlySet<string>
  seizeCapMarginBps: number
  headroomFloorBps: number
  usdValueOf: (loanToken: Address, loanUnits: bigint) => bigint | null
  counters: TickCounters
  logger: Logger
}): SizedCandidate[] => {
  const {
    pairs,
    lensOut,
    inflight,
    seizeCapMarginBps,
    headroomFloorBps,
    usdValueOf,
    counters,
    logger
  } = deps
  const sized: SizedCandidate[] = []
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

    const input = planInputFromLens(out)
    const outcome = planWithReason(input, { seizeCapMarginBps, headroomFloorBps })
    if (outcome.plan === null) {
      counters.planSkipped += 1
      logger[LEVEL_BY_REASON[outcome.reason]]('plan.skipped', {
        marketId: pair.id,
        borrower: pair.borrower,
        reason: outcome.reason
      })
      continue
    }
    counters.planned += 1
    const surplus = planSurplus(input, outcome.plan)
    const surplusUsd = usdValueOf(out.market.loanToken, surplus)
    if (surplusUsd === null) counters.unpriced += 1
    sized.push({ pair, label, out, plan: outcome.plan, surplus, surplusUsd })
  }
  return sized
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
  /**
   * Surplus over break-even a quoted route must clear to be simulated, in bps of the plan's
   * contract-derived repay. `0` is pure break-even — both sides then come from the contract's own
   * formula with no tuned value, so the gate can only reject plans that would have reverted.
   */
  minSurplusBps: number
  /** Lower bound (bps) on swap execution cost; passed to sizing. `0` disables the headroom gate. */
  headroomFloorBps: number
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
   * Resolves whether a transaction actually went out: ONLY `sent: true` may clear the
   * position's backoff or count as `submitted`. A `sent: false` outcome carries why, and the two
   * reasons are not interchangeable — see {@link SubmitOutcome}. Throws when a send claimed a nonce but produced no hash — the tick aborts
   * by design, so the signer's cursor rollback is not raced.
   */
  submit: (args: {
    market: Market
    borrower: Address
    plan: LiquidationPlan
    swapPlan: SwapPlan | null
    blockNumber: bigint
    label: string
  }) => Promise<SubmitOutcome>
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
  /**
   * USD value of a loan-token amount at `10 ** USD_PRICE_SCALE_DECIMALS`, or `null` when unpriced.
   * Synchronous by contract: it reads an out-of-band snapshot and must never perform I/O, because
   * awaiting a price before planning would add latency to exactly the maturity burst this ordering
   * exists to win. Ranking only — never a gate on whether to attempt a liquidation.
   */
  usdValueOf: (loanToken: Address, loanUnits: bigint) => bigint | null
  logger: Logger
}): Promise<TickCounters> {
  const {
    discover,
    chainHead,
    caller,
    seizeCapMarginBps,
    headroomFloorBps,
    minSurplusBps,
    readLens,
    quoteFor,
    simulate,
    submit,
    backoff,
    cooldown,
    inflightLabels,
    usdValueOf,
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
    quoteUnprofitable: 0,
    ok: 0,
    reverted: 0,
    submitted: 0,
    notSent: 0,
    unpriced: 0
  }

  // 3. Phase A — sizing only, and synchronous by construction (see `sizeCandidates`). `inflight` is
  // captured once; discovery yields distinct (id, borrower) pairs, so no label repeats in one tick.
  const sized = sizeCandidates({
    pairs,
    lensOut,
    inflight: inflightLabels(),
    seizeCapMarginBps,
    headroomFloorBps,
    usdValueOf,
    counters,
    logger
  })

  // 4. Phase B — the expensive serial stages (one quote and one simulation each), worked in descending
  // expected-USD-profit order so the most valuable position gets the contested early seconds rather
  // than whichever borrower sorts first by address.
  let complete = false
  try {
    let rank = 0
    for (const { pair, label, out, plan: liquidationPlan, surplus, surplusUsd } of rankByUsdSurplus(
      sized
    )) {
      rank += 1
      // Emitted here, per candidate, rather than batched in phase A: the timestamp sequence of these
      // lines IS the record of what the bot worked and in what order, which is how the 31 Jul maturity
      // was reconstructed at all.
      logger.info('plan.built', {
        marketId: pair.id,
        borrower: pair.borrower,
        rank,
        collateralIndex: liquidationPlan.collateralIndex,
        seizedAssets: liquidationPlan.seizedAssets,
        repaidUnits: liquidationPlan.repaidUnits,
        postMaturityMode: liquidationPlan.postMaturityMode,
        surplus,
        surplusUsd: surplusUsd === null ? null : formatUnits(surplusUsd, USD_PRICE_SCALE_DECIMALS)
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

        // Economic gate, before spending a simulation: `liquidate` ends by pulling its own re-derived
        // repay from the Executor, which approves only its live balance — so a route short of that
        // repay reverts as an allowance error instead of reporting a shortfall.
        const economics = assessProfitability({
          plan: liquidationPlan,
          swapPlan: quote.plan,
          minSurplusBps
        })
        if (!economics.viable) {
          // No backoff, no cooldown — see `quoteUnprofitable` on TickCounters. Quote volume is bounded
          // by the pre-quote headroom gate in sizing, not by suppressing a position that may be one
          // block of LIF ramp away from being fundable.
          counters.quoteUnprofitable += 1
          logger.info('quote.unprofitable', {
            marketId: pair.id,
            borrower: pair.borrower,
            requiredRepay: economics.requiredRepay,
            achievableOut: economics.achievableOut,
            shortfallBps: economics.shortfallBps
          })
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
        const outcome = await submit({
          market: out.market,
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
