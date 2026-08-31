import type { Backoff, CooldownStore, Logger, SimulateResult, SubmitOutcome } from '@repo/bot-kit'
import type { QuoteOutcome, SwapPlan, VenueCostEstimate, VenuePair } from '@repo/swaps'
import type { Address } from 'viem'

import { venuePairKey } from '@repo/swaps'
import { assertNever, lensKey, tryCatch } from '@repo/utils'
import { formatUnits } from 'viem'

import type { BorrowerCandidate } from '../discovery/borrowers'
import type { Market } from '../execution/encode-call'
import type { LiquidationPlan, PlanSkipReason } from '../sizing/plan'
import type { LensInput, LensOut } from '../state/lens.sol'
import type { RevertStreakStore } from './revert-streak'

import { MAX_PRESELECTED_CANDIDATES_PER_POSITION } from '../constants'
import { USD_PRICE_SCALE_DECIMALS } from '../discovery/token-prices'
import { expectedLoanOut } from '../execution/swap-step'
import {
  capCandidates,
  isBadDebtRealization,
  MAX_PLAN_CANDIDATES_PER_POSITION,
  MAX_PROBED_CANDIDATES_PER_POSITION,
  planCandidates,
  planSurplus
} from '../sizing/plan'
import { isLiquidatable, planInputFromLens } from './eligibility'
import { assessProfitability } from './profitability'
import { rankByNetUsdSurplus, scoreNetOfRouteCost } from './ranking'

/**
 * Per-tick outcome tally, emitted as `tick.end`, ordered as the pipeline runs. On a tick that ran to
 * completion (`complete: true`) these identities hold, so a stage added without a counter breaks a
 * sum instead of silently dropping a position:
 *
 * ```text
 * pairs        >= liquidatable
 * liquidatable === inflightSkipped + planSkipped + planned          (per POSITION)
 * candidates   === cooledDown + backoffSkipped + siblingSkipped + preselectSkipped
 *                  + noSwapPath + quoteFailed + quoteUnprofitable + ok + reverted   (per CANDIDATE)
 * ok           === submitted + notSent
 * notSent      === sendRefused + sendReverted + sendRejected
 * ```
 *
 * **The two middle identities count different things**, because one position can yield several
 * candidates — one per activated collateral slot and mode. Everything up to sizing is per position;
 * everything phase B works is per candidate, since that is what a quote and a simulation are spent on.
 * `candidates >= planned`, with equality only when every position had exactly one activated slot in
 * exactly one open mode (a matured-and-unhealthy slot is sized in both).
 *
 * A new loop **exit** must join one of these sums; a new **attribute** of a position that is still
 * worked must not (it would double-count). Any future pre-quote skip therefore belongs in the
 * `candidates` sum, and any future plan-stage skip rides `planSkipped`. `unpriced` is an attribute: an
 * unpriced candidate is still worked, just ordered last, so it deliberately joins no sum.
 *
 * On `complete: false` the `ok` identity is short by one: an aborting `submit` throws after `ok` was
 * counted. The `notSent` decomposition still holds, since that throw increments none of its four terms.
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
  /**
   * Skipped because sizing produced no plan for ANY `(slot, mode)` candidate — see the `plan.skipped`
   * events, each carrying the `collateralIndex` it belongs to, for the per-candidate reasons.
   */
  planSkipped: number
  planned: number
  /**
   * `(slot, mode)` candidates phase A produced across all planned positions. Exceeds `planned` on a
   * multi-collateral position, and on a matured-and-unhealthy one (sized in both open modes). The head
   * of the per-candidate identity — phase B iterates whatever `preselectSkipped` did not drop.
   */
  candidates: number
  cooledDown: number
  backoffSkipped: number
  /**
   * Candidates dropped because an earlier, higher-ranked candidate for the SAME position already
   * broadcast this tick. One `liquidate` per position per tick — its siblings are alternatives, not
   * additional work.
   */
  siblingSkipped: number
  /**
   * Candidates dropped by preselection, before any venue call was spent on them, in three places that
   * share one counter because all are the same verdict — "this position's better alternatives already
   * had their turn" — each distinguished by the `reason` on its `preselect.skipped` line:
   *
   * - `probe_cap` — beyond {@link MAX_PROBED_CANDIDATES_PER_POSITION} on the GROSS ordering, dropped
   *   before its route was even resolved. The one cap applied blind, because it is what bounds the
   *   indicative probe traffic that learning the cost would cost.
   * - `position_cap` — beyond `MAX_PLAN_CANDIDATES_PER_POSITION` on the FINAL net-of-route-cost
   *   ordering. Sizing used to truncate silently on gross surplus, before route cost could reorder;
   *   it now returns every candidate and the drop is both later and visible.
   * - `fall_through_bound` — the position had already spent
   *   `MAX_PRESELECTED_CANDIDATES_PER_POSITION` attempts this tick.
   *
   * **A `cooledDown`, `backoffSkipped` or `siblingSkipped` candidate does NOT consume the bound**, and
   * the reason is not symmetry: the bound exists to cap HTTP calls per position, and a suppressed
   * candidate spends none. Both suppression stores are keyed by POSITION and neither is written until
   * the tick's `finally`, so their verdict is constant across a position's candidates within one tick —
   * were they to consume the bound, a cooled-down position would report its first candidates as
   * `cooledDown` and the rest as `preselectSkipped`, splitting one verdict across two counters.
   *
   * The bound also never drops a position's best swap-free candidate, which is exempt however late it
   * ranks: it is the only kind guaranteed to be fundable, so its worst case is one wasted attempt while
   * dropping it can forfeit the position (see {@link capCandidates}). It is likewise never applied to a
   * position whose route costs are unknown, since the ordering it would cut is then only gross surplus.
   */
  preselectSkipped: number
  noSwapPath: number
  quoteFailed: number
  /**
   * Quoted successfully, but the route could not cover the repay `liquidate` would pull. Two producers,
   * counted together because they are the same verdict at different strictness: the quoting layer
   * refusing every venue whose GUARANTEED output misses break-even (`floor_unmet`), and
   * {@link assessProfitability} refusing an EXPECTED output under the configured threshold.
   *
   * An economic skip, not a failure: deliberately no backoff and no cooldown, because both sides of the
   * comparison move on a ten-second scale — the LIF ramp lifts break-even while route cost is itself
   * volatile — so this outcome says almost nothing about the next attempt.
   */
  quoteUnprofitable: number
  ok: number
  reverted: number
  /** Broadcast: the queue reported a transaction actually went out. */
  submitted: number
  /** The queue returned without broadcasting (a send failure, or a queue-wide refusal). */
  notSent: number
  /**
   * A queue-wide refusal (aborted send latch, failed nonce sync, nonce hole) that would have refused
   * any position, so it is held against none — see {@link SubmitOutcome}.
   */
  sendRefused: number
  /**
   * The node declined THIS plan with an on-chain execution revert. An economic outcome post-maturity,
   * counted separately from {@link TickCounters.sendRejected} because it deliberately does not extend
   * the position's suppression window: every one observed on 2026-08-28 was a min-out shortfall against
   * whichever pool the aggregator routed through, and the LIF ramp lifts break-even on a wall-clock
   * scale, so it says nothing about the next block.
   *
   * **Not folded into `quoteUnprofitable`**, however similar the verdict reads: that counter sits in the
   * per-candidate `candidates` sum and this candidate was already counted there as `ok`, so sharing it
   * would break that identity by one for every execution-reverted send.
   */
  sendReverted: number
  /** The send machinery failed (nonce, funds, RPC) — nothing was learned about the plan, so it backs off. */
  sendRejected: number
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
  // A rate, not a per-position quantity: headroom is `(lif - 1)/lif`, so every candidate sharing a
  // (maturity, maxLif, mode) group evaluates identically. At `info` that is one line per position per
  // block — the shape that gave the 31 Jul post-mortem hundreds of identical warnings. Doubly so now
  // that a matured-and-unhealthy slot emits a post-maturity candidate that is EXPECTED to be gated
  // early in its ramp while the normal-mode one proceeds.
  insufficient_headroom: 'debug'
}

/**
 * One `(position, collateral slot, mode)` candidate that produced a plan in phase A, carrying its
 * score so phase B can be ordered.
 *
 * A position with several activated collaterals contributes SEVERAL entries sharing one `label`, and
 * they are alternatives: phase B works down the ranking and submits at most one per position. That is
 * why `label`-keyed state (in-flight, backoff, cooldown) is applied per position rather than per
 * entry — see the phase B preamble in {@link runTick}.
 */
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
 * chain says are liquidatable and not already in flight, sizes each of a position's activated
 * collateral slots, and scores every resulting plan by oracle surplus converted to USD.
 *
 * Emits one candidate PER PLAN, not per position, so a multi-collateral position enters phase B as
 * several ranked alternatives.
 *
 * **Deliberately synchronous, and the type signature is the enforcement.** `await` here would add
 * latency to exactly the maturity burst the ordering exists to win, and — less obviously — it would
 * break the ranking's internal consistency: the price snapshot is replaced wholesale by an independent
 * refresh loop, so yielding mid-phase would score some candidates against one snapshot and the rest
 * against the next. Because this function is not `async`, both hazards are compile errors rather than
 * review comments. Keep it that way; a stage that genuinely needs I/O belongs in {@link prepareRoutes}
 * (phase A.5), which runs once over the whole sized batch rather than per position.
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
    const { plans, skips } = planCandidates(input, { seizeCapMarginBps, headroomFloorBps })

    // Per-CANDIDATE reasons: with several activated collaterals — or one matured-and-unhealthy slot
    // in both open modes — some candidates can skip while others size, so these are reported even when
    // the position was planned. `collateralIndex` is what makes them attributable; without it a
    // position emitting several reasons cannot be read. A threshold decision also carries the numbers
    // behind it, including the LIF and mode actually rejected: `maxLif` and chain time do NOT identify
    // them, because a matured-and-unhealthy slot is sized in BOTH modes and they are gated separately.
    for (const { reason, collateralIndex, headroom } of skips) {
      logger[LEVEL_BY_REASON[reason]]('plan.skipped', {
        marketId: pair.id,
        borrower: pair.borrower,
        collateralIndex,
        reason,
        ...(headroom
          ? {
              headroomBps: headroom.bps,
              headroomFloorBps,
              lif: headroom.lif,
              postMaturityMode: headroom.postMaturityMode,
              secondsSinceMaturity: out.blockTimestamp - out.market.maturity
            }
          : {})
      })
    }

    // `planSkipped` and `planned` stay PER POSITION so the `tick.end` identities still balance
    // against `liquidatable`: a position is skipped only when no slot at all could be sized.
    if (plans.length === 0) {
      counters.planSkipped += 1
      continue
    }
    counters.planned += 1
    for (const plan of plans) {
      const surplus = planSurplus(plan)
      const surplusUsd = usdValueOf(out.market.loanToken, surplus)
      if (surplusUsd === null) counters.unpriced += 1
      sized.push({ pair, label, out, plan, surplus, surplusUsd })
    }
  }
  return sized
}

/** The pair a candidate's seize is actually sold through, and the worst-case amount of it. */
type PreparedRoute = { pair: VenuePair; amountIn: bigint }

/**
 * What phase A.5 learned about one candidate's route. `unknown` is not an error state to recover from:
 * it is the fail-open signal that this candidate — and therefore its whole position — must be ordered
 * on gross surplus, exactly as before the probe curve existed. `no_route` is the opposite: a candidate
 * that provably sells nothing, and so costs zero rather than being unpriced.
 */
type RouteState =
  | { kind: 'no_route' }
  | { kind: 'route'; route: PreparedRoute }
  | { kind: 'unknown' }

/**
 * The probe-curve seam phase A.5 drives. Bundled because all three parts address ONE cache:
 * `resolveRoute` says which pair a candidate refers to, `warmRoute` fills it, `routeCost` reads it.
 */
type TickRouting = {
  /**
   * The POST-unwrap `(collateral, loan)` pair this candidate's seize will be sold through, or `null`
   * when there is no pair to probe — no collateral slot, an operator-excluded collateral, or a sell
   * path that already ends in the loan token. `null` is treated as unknown cost rather than as free:
   * only sizing's `swapFree` flag asserts that no route is needed.
   *
   * Async, which is the entire reason phase A.5 exists — see {@link sizeCandidates}.
   */
  resolveRoute: (plan: LiquidationPlan, out: LensOut) => Promise<PreparedRoute | null>
  /**
   * Fills the probe cache for one pair. A cold refresh is one indicative venue call per ladder rung per
   * venue on the isolated probe client, so it is driven only for pairs that have a sized candidate.
   * Contractually idempotent + staleness-gated, so a warm pair costs nothing.
   */
  warmRoute: (pair: VenuePair) => Promise<void>
  /** Best-first interpolated estimates from the cache; `[]` while the pair is cold. Pure/synchronous. */
  routeCost: (
    pair: VenuePair,
    amountIn: bigint,
    referenceAmountOut: bigint
  ) => readonly VenueCostEstimate[]
}

/**
 * Phase A.5: resolve the route every sized candidate would sell through, then start warming those
 * pairs' probe curves so the ranking can price them.
 *
 * It is its own phase for two reasons. Phase A cannot await (see {@link sizeCandidates}), and `maintain`
 * cannot host this at all: it receives only a block number, so it would have to redo discovery and the
 * lens read to learn which pairs matter, it is awaited before every tick so probing there delays exactly
 * the time-critical work, and its failures surface as `queue.maintenance_failed`. The pair is not even
 * known before sizing — the unwrap chain decides which token is finally sold.
 *
 * **The warm is started, never awaited.** A cold sweep is one indicative call per rung per venue, which
 * at the venues' ~1 rps is seconds of wall clock — spent inside the maturity burst this ordering exists
 * to win, and before any quote runs. So it warms for the NEXT tick and this tick reads whatever the
 * cache already holds: a first tick falls open to gross ordering and the curve converges within a tick
 * or two. `VenueSelector.refresh` dedupes an in-flight sweep, so neither the next tick nor the quoting
 * layer's own refresh can double-probe a pair being warmed.
 *
 * **Pairs are deduplicated before anything is warmed**, keyed exactly as the probe cache keys them, so
 * several slots on one pair — or several positions in one market — trigger one sweep; and no pair
 * without a sized candidate is ever probed. A candidate that needs no route at all (a swap-free slot, a
 * bad-debt write-off) resolves nothing and warms nothing.
 *
 * Failure is non-fatal in both stages: an unresolved candidate is left `unknown` and a failed warm
 * simply leaves the curve cold, which fails the affected positions open to gross-surplus ordering.
 *
 * Side effects: emits `route.unresolved` per failure, `probe.warm_failed` asynchronously per failed
 * sweep, and `probe.warmed` when there was a pair to warm.
 */
const prepareRoutes = async (deps: {
  sized: readonly SizedCandidate[]
  routing: TickRouting
  logger: Logger
}): Promise<Map<SizedCandidate, RouteState>> => {
  const { sized, routing, logger } = deps
  const states = new Map<SizedCandidate, RouteState>()
  const pairs = new Map<string, VenuePair>()

  for (const candidate of sized) {
    // Two shapes need no route, and they must not be costed as `unknown`: that is a per-POSITION
    // fail-open signal (see {@link RouteState}), so reporting it here would drop a whole write-off
    // position back to gross ordering. A write-off also never reaches `quoteFor` at all — phase B
    // gates it on the same predicate — so resolving its unwraps would be an HTTP call spent on a
    // route nothing will ever sell through.
    if (candidate.plan.swapFree || isBadDebtRealization(candidate.plan)) {
      states.set(candidate, { kind: 'no_route' })
      continue
    }
    const resolved = await tryCatch(routing.resolveRoute(candidate.plan, candidate.out))
    if (resolved.error) {
      logger.warn('route.unresolved', {
        marketId: candidate.pair.id,
        borrower: candidate.pair.borrower,
        collateralIndex: candidate.plan.collateralIndex,
        detail: resolved.error.message
      })
    }
    const route = resolved.data ?? null
    states.set(candidate, route ? { kind: 'route', route } : { kind: 'unknown' })
    if (route) pairs.set(venuePairKey(route.pair), route.pair)
  }

  for (const pair of pairs.values()) {
    // Invoked INSIDE the thunk so a synchronous throw from `warmRoute` becomes a caught rejection
    // rather than escaping this loop and aborting the tick.
    void tryCatch((async () => routing.warmRoute(pair))()).then(({ error }) => {
      if (error) {
        logger.warn('probe.warm_failed', {
          collateral: pair.collateral,
          loan: pair.loan,
          detail: error.message
        })
      }
    })
  }
  if (pairs.size > 0) logger.info('probe.warmed', { pairs: pairs.size, candidates: sized.length })
  return states
}

/** A sized candidate priced against the probe curve — the input {@link scoreNetOfRouteCost} ranks. */
type CostedCandidate = SizedCandidate & {
  routeCostUsd: bigint | null
  /** The leading venue's cost against the oracle. Reported for forensics; the USD figure is scored. */
  routeCostBps: number | null
}

/**
 * Prices each candidate's route off the warm curve, in the SAME USD scale as its surplus so the two are
 * subtractable. A candidate that sells nothing costs zero by construction — a `swapFree` slot, or a
 * bad-debt write-off, which trades no assets at all.
 *
 * Everything else fails open to `null` (see {@link RouteState}) — a cold pair (`[]`), a `clamped`
 * estimate taken from a ladder end rather than between two rungs, no oracle reference, or an unpriced
 * loan token. Cost is floored at zero: a venue quoting above the oracle is a stale oracle, never a
 * bonus to score (see {@link VenueCostEstimate.costBps}).
 *
 * Reads only the LEADING venue's estimate, because that is the venue the quoting layer will try first.
 * Pure: {@link TickRouting.routeCost} is a cache lookup, cheap enough for the protocol's ceiling of 16
 * collateral slots in two modes.
 */
const costRoutes = (deps: {
  sized: readonly SizedCandidate[]
  states: Map<SizedCandidate, RouteState>
  routing: TickRouting
  usdValueOf: (loanToken: Address, loanUnits: bigint) => bigint | null
}): CostedCandidate[] =>
  deps.sized.map(candidate => {
    const uncosted = { ...candidate, routeCostUsd: null, routeCostBps: null }
    const state = deps.states.get(candidate) ?? { kind: 'unknown' as const }
    if (state.kind === 'no_route') return { ...candidate, routeCostUsd: 0n, routeCostBps: 0 }
    if (state.kind === 'unknown') return uncosted

    const reference = expectedLoanOut(candidate.plan)
    const best = deps.routing.routeCost(state.route.pair, state.route.amountIn, reference)[0]
    if (!best || best.clamped || best.costBps === null) return uncosted
    const shortfall = reference > best.estimatedOut ? reference - best.estimatedOut : 0n
    return {
      ...candidate,
      routeCostUsd: deps.usdValueOf(candidate.out.market.loanToken, shortfall),
      routeCostBps: best.costBps
    }
  })

/**
 * Truncates each POSITION's alternatives to `limit` over the ordering it is given, preserving that
 * ordering for the survivors and reporting what it dropped.
 *
 * Applied twice per tick, at two different limits, and the order of operations is the point. The final
 * {@link MAX_PLAN_CANDIDATES_PER_POSITION} cap must run over the NET ordering: capping on gross surplus
 * — as sizing did — can discard the candidate that wins once route cost is charged, and nothing
 * downstream can recover it. The earlier {@link MAX_PROBED_CANDIDATES_PER_POSITION} cap has to run on
 * gross, because it is what bounds learning the cost at all; it is looser precisely so the net ordering
 * still has room to reorder into the final cap.
 */
const capPerPosition = <T extends { label: string; plan: LiquidationPlan }>(
  ranked: readonly T[],
  limit: number
): { kept: T[]; dropped: T[] } => {
  const byLabel = new Map<string, T[]>()
  for (const candidate of ranked) {
    const group = byLabel.get(candidate.label)
    if (group) group.push(candidate)
    else byLabel.set(candidate.label, [candidate])
  }
  const keep = new Set<T>()
  for (const group of byLabel.values()) {
    for (const candidate of capCandidates(group, entry => entry.plan.swapFree, limit)) {
      keep.add(candidate)
    }
  }
  return {
    kept: ranked.filter(candidate => keep.has(candidate)),
    dropped: ranked.filter(candidate => !keep.has(candidate))
  }
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
 * Between sizing and that expensive work sits phase A.5 ({@link prepareRoutes}), which resolves the
 * pairs the sized candidates actually sell through and starts (never awaits) warming their probe
 * curves, so the ordering can charge each candidate its route cost instead of ranking on the oracle
 * alone. A tick whose curve is not yet warm falls open to gross ordering rather than waiting for it.
 *
 * `tick.end` is emitted even when a position aborts the tick — with `complete: false`, so partial
 * counters can never be mistaken for a genuinely idle tick. See {@link TickCounters} for the
 * counter identities; it also carries `firmCalls` / `firmCallsUnknown` and `durationMs`, which are the
 * two figures a maturity's retry period is actually set by.
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
   * backoff); `failed` → skip, backing the position off unless the reason is the economic
   * `floor_unmet`.
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
   * position's backoff or count as `submitted`. A `sent: false` outcome carries why, and the three
   * cases are not interchangeable — see {@link SubmitOutcome} and the submit branch below. Throws when
   * a send claimed a nonce but produced no hash — the tick aborts by design, so the signer's cursor
   * rollback is not raced.
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
  /**
   * Watches consecutive execution-reverted sends per position and reports a streak that has run too
   * long. Pure telemetry — it suppresses nothing (see {@link RevertStreakStore}).
   */
  revertStreaks: RevertStreakStore
  /** Labels (`${id}:${borrower}`) already in flight — skipped to avoid re-submitting each block. */
  inflightLabels: () => ReadonlySet<string>
  /**
   * USD value of a loan-token amount at `10 ** USD_PRICE_SCALE_DECIMALS`, or `null` when unpriced.
   * Synchronous by contract: it reads an out-of-band snapshot and must never perform I/O, because
   * awaiting a price before planning would add latency to exactly the maturity burst this ordering
   * exists to win. Ranking only — never a gate on whether to attempt a liquidation.
   */
  usdValueOf: (loanToken: Address, loanUnits: bigint) => bigint | null
  /**
   * The probe-curve seam phase A.5 drives, so candidates can be ordered net of what their route costs
   * rather than on the oracle alone. Every part of it fails open — see {@link prepareRoutes}.
   */
  routing: TickRouting
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
    revertStreaks,
    inflightLabels,
    usdValueOf,
    routing,
    logger
  } = deps
  const startedAt = performance.now()

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
    candidates: 0,
    cooledDown: 0,
    backoffSkipped: 0,
    siblingSkipped: 0,
    preselectSkipped: 0,
    noSwapPath: 0,
    quoteFailed: 0,
    quoteUnprofitable: 0,
    ok: 0,
    reverted: 0,
    submitted: 0,
    notSent: 0,
    sendRefused: 0,
    sendReverted: 0,
    sendRejected: 0,
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

  counters.candidates = sized.length

  const skipPreselected = (
    dropped: readonly { pair: LensInput; plan: LiquidationPlan }[],
    reason: 'probe_cap' | 'position_cap'
  ) => {
    counters.preselectSkipped += dropped.length
    for (const candidate of dropped) {
      logger.info('preselect.skipped', {
        marketId: candidate.pair.id,
        borrower: candidate.pair.borrower,
        collateralIndex: candidate.plan.collateralIndex,
        postMaturityMode: candidate.plan.postMaturityMode,
        reason
      })
    }
  }

  // 4. Bound the probe fan-out BEFORE resolving anything, on the gross ordering — this is the one cap
  // that must be applied blind, because it is what bounds learning the cost. It is looser than the
  // final cap so the net ordering below still has a superset to reorder within.
  const { kept: probeable, dropped: overProbeBound } = capPerPosition(
    sized,
    MAX_PROBED_CANDIDATES_PER_POSITION
  )
  skipPreselected(overProbeBound, 'probe_cap')

  // 5. Phase A.5 — the async step between sizing and the expensive work: resolve each candidate's
  // route and start warming the (deduplicated) probe curves for those pairs only. The warm is NOT
  // awaited; this tick reads whatever the cache already holds (see {@link prepareRoutes}).
  const states = await prepareRoutes({ sized: probeable, routing, logger })

  // 6. Rank net of route cost, THEN truncate. Both halves matter: charging the route makes a swap-free
  // slot beat a nominally larger swap slot the incentive cannot fund, and capping afterwards means the
  // net winner is no longer discarded before it was ever compared.
  const scored = rankByNetUsdSurplus(
    scoreNetOfRouteCost(costRoutes({ sized: probeable, states, routing, usdValueOf }))
  )
  const { kept, dropped } = capPerPosition(scored, MAX_PLAN_CANDIDATES_PER_POSITION)
  skipPreselected(dropped, 'position_cap')

  // A position's best swap-free candidate is exempt from the fall-through bound below, however late it
  // ranks — `kept` is in rank order, so the first one is the best. See `preselectSkipped`.
  const reserved = new Map<string, (typeof kept)[number]>()
  for (const candidate of kept) {
    if (candidate.plan.swapFree && !reserved.has(candidate.label)) {
      reserved.set(candidate.label, candidate)
    }
  }
  const attempts = new Map<string, number>()

  // 7. Phase B — the expensive serial stages (one quote and one simulation each), worked in descending
  // expected-USD-profit order so the most valuable candidate gets the contested early seconds rather
  // than whichever borrower sorts first by address.
  //
  // A position's candidates are ALTERNATIVES, so failing one falls through to the next in rank order.
  // That is why the two suppression stores are written after the loop rather than inside it:
  // `backoff.record(label, chainHead)` sets `until = chainHead + baseBlocks` while `shouldSkip(label,
  // chainHead)` tests `chainHead < until`, so recording mid-loop would suppress this position's own
  // remaining candidates in the very same tick — silently reducing fall-through to a single attempt.
  // Deferring also keeps the ranking global: candidates stay interleaved across positions rather than
  // being grouped to make the bookkeeping work.
  const submittedLabels = new Set<string>()
  const pendingBackoff = new Set<string>()
  // Positions an execution-reverted send exempts from `pendingBackoff` — see the `executionRevert`
  // arm for why the exemption has to be a latch.
  const backoffExempt = new Set<string>()
  const pendingCooldown = new Set<string>()
  let complete = false
  // Firm venue calls this tick, `null` while no quote reported any: an absent `firmCalls` is unknown,
  // not zero (see {@link QuoteOutcome.firmCalls}), so `firmCallsUnknown` is what says whether the sum
  // is complete. The pair of them, with `durationMs`, is what the next maturity's retry period is set
  // against — the budget is HTTP calls per candidate, not candidates worked.
  let firmCalls: number | null = null
  let firmCallsUnknown = 0
  try {
    let rank = 0
    for (const candidate of kept) {
      const { pair, label, out, plan: liquidationPlan, surplus, surplusUsd } = candidate
      rank += 1
      // One liquidation per position per tick: a higher-ranked sibling already went out, and these
      // alternatives would each be a second `liquidate` against the same debt.
      if (submittedLabels.has(label)) {
        counters.siblingSkipped += 1
        continue
      }
      // Bounded fall-through: this position's better alternatives already spent their attempts, and
      // beyond the bound the ordering says this one loses on cost rather than merely sorting late. Only
      // applied where that ordering is trustworthy, and never to the reserved swap-free candidate.
      const spent = attempts.get(label) ?? 0
      if (
        candidate.costed &&
        spent >= MAX_PRESELECTED_CANDIDATES_PER_POSITION &&
        reserved.get(label) !== candidate
      ) {
        counters.preselectSkipped += 1
        logger.info('preselect.skipped', {
          marketId: pair.id,
          borrower: pair.borrower,
          collateralIndex: liquidationPlan.collateralIndex,
          postMaturityMode: liquidationPlan.postMaturityMode,
          rank,
          attempts: spent,
          reason: 'fall_through_bound'
        })
        continue
      }
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
        surplusUsd: surplusUsd === null ? null : formatUnits(surplusUsd, USD_PRICE_SCALE_DECIMALS),
        // The two terms the ordering compared, so a rank can be re-derived from the log line alone.
        routeCostBps: candidate.routeCostBps,
        netUsd:
          candidate.netUsd === null ? null : formatUnits(candidate.netUsd, USD_PRICE_SCALE_DECIMALS)
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
      const needsSwap = !isBadDebtRealization(liquidationPlan)
      // Suppress positions that keep failing to quote/simulate — bounds API + RPC usage under a
      // backlog, since executable quotes are spent only on positions not currently backed off.
      if (needsSwap && backoff.shouldSkip(label, chainHead)) {
        counters.backoffSkipped += 1
        continue
      }
      // Past every suppression gate, so this candidate is about to spend venue and/or simulation work:
      // the one place the fall-through bound is consumed.
      attempts.set(label, spent + 1)

      let swapPlan: SwapPlan | null = null
      if (needsSwap) {
        const quote = await quoteFor(liquidationPlan, out, label)
        if (typeof quote.firmCalls === 'number') firmCalls = (firmCalls ?? 0) + quote.firmCalls
        else firmCallsUnknown += 1
        if (quote.kind === 'no_config') {
          counters.noSwapPath += 1
          pendingCooldown.add(label)
          logger.info('config.no_swap_path', {
            marketId: pair.id,
            borrower: pair.borrower,
            collateralIndex: liquidationPlan.collateralIndex,
            postMaturityMode: liquidationPlan.postMaturityMode
          })
          continue
        }
        if (quote.kind === 'failed') {
          // An economic refusal is not a failure signal: every venue's guaranteed output missed the
          // break-even repay, which is the normal state of the early LIF ramp and clears on its own as
          // the incentive grows. Backing off here would sample the ramp exponentially and skip the
          // contested block where the position first becomes fundable — see `quoteUnprofitable`. The
          // quoting layer already logged `quote.floor_unmet` per venue with the numbers.
          if (quote.reason === 'floor_unmet') {
            counters.quoteUnprofitable += 1
            continue
          }
          counters.quoteFailed += 1
          pendingBackoff.add(label)
          pendingCooldown.add(label)
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
          // `requiredThreshold` and `minSurplusBps` are both here on purpose: with a nonzero buffer
          // the route can clear `requiredRepay` and still be rejected, and an operator cannot tell
          // which rule fired without seeing the bar that was applied.
          logger.info('quote.unprofitable', {
            marketId: pair.id,
            borrower: pair.borrower,
            collateralIndex: liquidationPlan.collateralIndex,
            postMaturityMode: liquidationPlan.postMaturityMode,
            requiredRepay: economics.requiredRepay,
            requiredThreshold: economics.requiredThreshold,
            achievableOut: economics.achievableOut,
            shortfallBps: economics.shortfallBps,
            minSurplusBps
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
      // `collateralIndex` and `postMaturityMode` identify WHICH candidate this was: several entries
      // per position share a (marketId, borrower), so without them two attempts on one position are
      // indistinguishable in the log join.
      const fields = {
        marketId: pair.id,
        borrower: pair.borrower,
        collateralIndex: liquidationPlan.collateralIndex,
        postMaturityMode: liquidationPlan.postMaturityMode
      }
      switch (result.status) {
        case 'ok':
          counters.ok += 1
          logger.info('simulate.ok', fields)
          break
        case 'revert':
          counters.reverted += 1
          // Back off: a sim revert (stale quote, transient unliquidatability) shouldn't re-quote +
          // re-simulate this position every block.
          pendingBackoff.add(label)
          pendingCooldown.add(label)
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
          submittedLabels.add(label)
          backoff.clear(label)
          revertStreaks.reset(label)
          // A broadcast settles the position for this tick, so a lower-ranked sibling's earlier
          // failure must not still suppress it: this candidate succeeded where that one didn't.
          pendingBackoff.delete(label)
          pendingCooldown.delete(label)
          counters.submitted += 1
        } else {
          // Nothing was broadcast, so the position's failure history stands: `backoff.clear` stays gated
          // on a real broadcast, because clearing it here is what let a failing position reset to attempt
          // 1 and re-quote every other block.
          counters.notSent += 1
          if (outcome.reason === 'refused') {
            // Queue-wide — it would have refused any position. So it arms nothing, and it does not break
            // the revert streak either: nothing was sent, so the chain said nothing about this plan.
            counters.sendRefused += 1
          } else if (outcome.executionRevert) {
            counters.sendReverted += 1
            // The chain declined this plan at this block. Post-maturity that is an economic verdict on a
            // ramping incentive, not a fact about the next block, so it must not extend the window.
            // A LATCH, not a delete, because `pendingBackoff` is keyed by POSITION and the exemption has
            // to hold whatever order this position's siblings ran in: unlike a broadcast, an execution
            // revert does not enter `submittedLabels`, so the next-ranked candidate still runs and can
            // arm the entry AFTER this one — a delete would only survive when the reverted send happened
            // to be the position's last event of the tick. `pendingCooldown` is deliberately left armed:
            // it is a flat, default-off window an operator opts into to throttle a position class, so
            // lifting it is an operator's call rather than an inference from one sibling's outcome.
            backoffExempt.add(label)
            // No throttle on this path, so a persistent estimator-only revert (expired route deadline,
            // malformed calldata, a gate that keeps closing) would re-quote forever without progressing.
            // Reported, never suppressed — see RevertStreakStore.
            const streak = revertStreaks.record(label, outcome.selector)
            // Only the crossing, so one stuck position is one warn per streak rather than one per tick
            // (two, when both its siblings revert) for as long as it stays stuck.
            if (streak.escalate === 'crossed') {
              logger.warn('send.revert_streak', {
                marketId: pair.id,
                borrower: pair.borrower,
                reverts: streak.count,
                durationMs: streak.durationMs,
                selector: streak.selector ?? null,
                selectorConstant: streak.selectorConstant
              })
            }
          } else {
            counters.sendRejected += 1
            // The send machinery failed (nonce, funds, RPC): a fact about this position that says nothing
            // about the chain's view of the plan, so it arms backoff and ends the streak.
            pendingBackoff.add(label)
            revertStreaks.reset(label)
          }
        }
      }
    }
    complete = true
  } finally {
    // Suppression applied once per position, after every candidate has had its turn (see the phase B
    // preamble). In the `finally` so an aborting `submit` still records what the tick learned.
    for (const label of pendingCooldown) cooldown.mark(label)
    for (const label of pendingBackoff) {
      if (!backoffExempt.has(label)) backoff.record(label, chainHead)
    }
    logger.info('tick.end', {
      ...counters,
      firmCalls,
      firmCallsUnknown,
      durationMs: Math.round(performance.now() - startedAt),
      complete
    })
  }
  return counters
}
