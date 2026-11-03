import type { PrepareOutcome, PrepareRequest } from '@repo/controller'
import type { Logger, SimulateResult } from '@repo/kit'
import type { QuoteOutcome, SwapPlan } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import { formatUnits } from 'viem'

import type { Market } from './execution/encode-call'
import type { PositionReading, Pricing, Readings, Sizing, SizingOptions } from './liquidation'
import type { LiquidationPlan } from './sizing/plan'
import type { LensOut } from './state/lens.sol'
import type { TickStats } from './stats'

import { MAX_PRESELECTED_CANDIDATES_PER_POSITION } from './constants'
import { USD_PRICE_SCALE_DECIMALS } from './discovery/token-prices'
import {
  isLive,
  nativeValueAt,
  routeCostOf,
  sellsNothing,
  sizePosition,
  usdValueAt
} from './liquidation'
import { assessProfitability } from './runner/profitability'
import { rankByNetUsdSurplus, scoreNetOfRouteCost } from './runner/ranking'
import {
  capCandidates,
  isBadDebtRealization,
  MAX_PLAN_CANDIDATES_PER_POSITION,
  MAX_PROBED_CANDIDATES_PER_POSITION,
  planSurplus
} from './sizing/plan'

export type PrepareDeps = Readonly<{
  executor: Address
  sizing: SizingOptions
  /** Surplus over break-even a quoted route must clear, in bps of the repay. */
  minSurplusBps: number
  quoteFor: (plan: LiquidationPlan, out: LensOut, label: string) => Promise<QuoteOutcome>
  encode: (market: Market, borrower: Address, plan: LiquidationPlan, swap: SwapPlan | null) => Hex
  simulate: (data: Hex) => Promise<SimulateResult>
  /**
   * What sending `data` takes at `baseFee`: `l1Data`, an OP-stack chain's data fee charged beside
   * gas, and the first bid the kernel signs under a spend bound (`firstBid` in `@repo/kit`), whose
   * gas falls short of `gasLimit` when that bound cannot fund it.
   */
  feesFor: (data: Hex) => Promise<
    Readonly<{
      l1Data: bigint
      baseFee: bigint
      gasLimit: bigint
      firstBid: (spendWei: bigint) => Readonly<{ maxFeePerGas: bigint; gas: bigint }>
    }>
  >
  /** The chain's wrapped native token, whose USD price converts a liquidation's profit to wei. */
  nativeToken: Address
  /** How long a prepared liquidation's quote authorizes its send: `Config.sendLifeMs`. */
  validForMs: number
  now: () => number
  stats: TickStats
  logger: Logger
}>

type Candidate = Readonly<{ plan: LiquidationPlan; surplus: bigint; surplusUsd: bigint | null }>

/** What one alternative's attempt says about the position. */
type Verdict =
  | Readonly<{ kind: 'sent'; data: Hex; maxSpendWei?: bigint }>
  | Readonly<{ kind: 'retry' }>
  | Readonly<{ kind: 'backoff'; reason?: 'gas_unaffordable' }>
  | Readonly<{ kind: 'skip'; reason: 'no_swap_path' | 'no_surplus' | 'reverted' }>

type PreselectReason = 'probe_cap' | 'position_cap' | 'fall_through_bound'

/**
 * A position's alternatives as a preparation works them: those cut before costing and after
 * ranking, then every kept one in rank order with whether it is attempted, and how many were
 * attempted before it.
 */
const attemptsOf = (sizing: Sizing, pricing: Pricing, now: number) => {
  const sized = sizing.plans.map((plan): Candidate => {
    const surplus = planSurplus(plan)
    return { plan, surplus, surplusUsd: usdValueAt(pricing, sizing.loanToken, surplus, now) }
  })
  const swapFree = (candidate: Candidate) => candidate.plan.swapFree
  const probed = capCandidates(sized, swapFree, MAX_PROBED_CANDIDATES_PER_POSITION)
  const costed = probed.map(candidate => {
    const cost = routeCostOf(candidate.plan, sizing, pricing, now)
    return {
      ...candidate,
      label: '',
      routeCostUsd:
        cost === null ? null : usdValueAt(pricing, sizing.loanToken, cost.shortfall, now),
      routeCostBps: cost === null ? null : cost.bps
    }
  })
  const scored = rankByNetUsdSurplus(scoreNetOfRouteCost(costed))
  const kept = capCandidates(scored, swapFree, MAX_PLAN_CANDIDATES_PER_POSITION)
  const reserved = kept.find(swapFree)
  let tried = 0
  const window = kept.map((candidate, index) => {
    const attempted =
      !candidate.costed || tried < MAX_PRESELECTED_CANDIDATES_PER_POSITION || candidate === reserved
    const entry = { candidate, rank: index + 1, attempted, attempts: tried }
    if (attempted) tried += 1
    return entry
  })
  return {
    sized,
    probeCut: sized.filter(candidate => !probed.includes(candidate)),
    positionCut: scored.filter(candidate => !kept.includes(candidate)),
    window
  }
}

const expiredIn = <T>(readings: Readings<T>, now: number) =>
  Object.values(readings).filter(reading => reading.status === 'present' && !isLive(reading, now))
    .length

/**
 * Prepares one position from the reading its request captured: sizes every `(slot, mode)`
 * alternative, orders them net of route cost off the curves the graph holds, as the bid does, reading
 * any price, route or curve past its expiry as absent, and works down that order
 * through quote, profitability and simulation, answering with the first that passes. A failed quote
 * or simulation backs the position off unless another alternative was only short of its ramping
 * incentive; a write-off's own revert never does, since it sells nothing.
 */
export const preparePosition = async (
  request: PrepareRequest<PositionReading>,
  pricing: Pricing,
  deps: PrepareDeps
): Promise<PrepareOutcome> => {
  const { marketId, borrower, out } = request.input
  const label = request.key
  const position = { id: label, marketId, borrower }
  const decline = (reason: string, backoff: boolean): PrepareOutcome => ({
    ok: false,
    reason,
    backoff
  })
  const sizing = sizePosition(request.input, deps.sizing)
  const { plans } = sizing
  if (plans.length === 0) return decline('no_plan', false)

  const now = deps.now()
  const expired = {
    prices: expiredIn(pricing.prices, now),
    routes: expiredIn(pricing.routes, now),
    curves: expiredIn(pricing.curves, now)
  }
  if (expired.prices + expired.routes + expired.curves > 0)
    deps.logger.warn('pricing.expired', { ...position, ...expired })
  const { sized, probeCut, positionCut, window } = attemptsOf(sizing, pricing, now)
  deps.stats.add({
    candidates: sized.length,
    unpriced: sized.filter(candidate => candidate.surplusUsd === null).length
  })
  const preselected = (
    dropped: readonly Candidate[],
    reason: PreselectReason,
    extra: Readonly<Record<string, number>> = {}
  ) => {
    deps.stats.add({ preselectSkipped: dropped.length })
    for (const { plan } of dropped)
      deps.logger.info('preselect.skipped', {
        ...position,
        collateralIndex: plan.collateralIndex,
        postMaturityMode: plan.postMaturityMode,
        reason,
        ...extra
      })
  }
  preselected(probeCut, 'probe_cap')
  preselected(positionCut, 'position_cap')

  let backoff: 'failed' | 'gas_unaffordable' | undefined
  let retry = false
  let skipped: 'no_swap_path' | 'no_surplus' | 'reverted' = 'no_swap_path'
  let firmCalls = 0
  let firmCallsUnknown = 0
  const weiOf = (units: bigint) =>
    nativeValueAt(pricing, { token: sizing.loanToken, units, native: deps.nativeToken }, now)
  try {
    for (const { candidate, rank, attempted, attempts } of window) {
      const { plan } = candidate
      if (!attempted) {
        preselected([candidate], 'fall_through_bound', { rank, attempts })
        continue
      }
      deps.logger.info('plan.built', {
        ...position,
        rank,
        collateralIndex: plan.collateralIndex,
        seizedAssets: plan.seizedAssets,
        repaidUnits: plan.repaidUnits,
        postMaturityMode: plan.postMaturityMode,
        surplus: candidate.surplus,
        surplusUsd:
          candidate.surplusUsd === null
            ? null
            : formatUnits(candidate.surplusUsd, USD_PRICE_SCALE_DECIMALS),
        routeCostBps: candidate.routeCostBps,
        netUsd:
          candidate.netUsd === null ? null : formatUnits(candidate.netUsd, USD_PRICE_SCALE_DECIMALS)
      })
      const fields = {
        ...position,
        collateralIndex: plan.collateralIndex,
        postMaturityMode: plan.postMaturityMode
      }
      const { verdict, calls } = await attempt(
        candidate,
        out,
        { borrower, label, fields, weiOf },
        deps
      )
      if (calls === undefined) firmCallsUnknown += 1
      else firmCalls += calls
      if (verdict.kind === 'sent')
        return {
          ok: true,
          validUntil: deps.now() + deps.validForMs,
          ...(onRamp(plan) && { exemptFromBackoff: RAMP_EXEMPT }),
          ...(verdict.maxSpendWei !== undefined && { maxSpendWei: verdict.maxSpendWei }),
          steps: [
            {
              kind: 'tx',
              payload: { kind: 'tx', to: deps.executor, data: verdict.data, value: 0n }
            }
          ]
        }
      if (verdict.kind === 'backoff' && backoff !== 'failed') backoff = verdict.reason ?? 'failed'
      if (verdict.kind === 'retry') retry = true
      if (verdict.kind === 'skip' && skipped !== 'reverted') skipped = verdict.reason
    }
    if (retry) return decline('unprofitable', false)
    return backoff ? decline(backoff, true) : decline(skipped, false)
  } finally {
    deps.stats.add({ firmCalls, firmCallsUnknown })
  }
}

/**
 * A post-maturity swap's incentive ramps with time, so its send-stage revert says nothing about the
 * next block and holds it only to the next head (TIB-2026-08-28, decision 3). A swap-free slot or a
 * write-off sells nothing, so it cannot fall short of the ramp.
 */
const onRamp = (plan: LiquidationPlan) => plan.postMaturityMode && !sellsNothing(plan)
const RAMP_EXEMPT = ['reverted'] as const

type AttemptContext = Readonly<{
  borrower: Address
  label: string
  fields: Readonly<Record<string, unknown>>
  /** Loan units in wei of the native token, or `null` while either price is unknown. */
  weiOf: (units: bigint) => bigint | null
}>

/**
 * The fee ceiling of a simulated alternative expected to clear `profit` loan units: that profit in
 * wei less its L1 data fee, or none while it cannot be priced, which leaves the policy ceiling. A
 * ceiling whose first bid cannot keep its whole gas limit or meet the current base fee backs the
 * position off instead, unless the plan is on the ramp, whose profit grows by the block.
 */
const spendFor = async (
  plan: LiquidationPlan,
  profit: bigint,
  data: Hex,
  { weiOf, fields }: AttemptContext,
  deps: PrepareDeps
): Promise<Verdict> => {
  const profitWei = weiOf(profit)
  if (profitWei === null) {
    deps.logger.warn('gas.unpriced', fields)
    return { kind: 'sent', data }
  }
  const fees = await deps.feesFor(data)
  const maxSpendWei = profitWei - fees.l1Data
  const bid = fees.firstBid(maxSpendWei)
  if (bid.gas >= fees.gasLimit && bid.maxFeePerGas >= fees.baseFee)
    return { kind: 'sent', data, maxSpendWei }
  deps.stats.add({ gasUnaffordable: 1 })
  deps.logger.info('gas.unaffordable', {
    ...fields,
    profitWei,
    l1DataWei: fees.l1Data,
    baseFee: fees.baseFee,
    bidMaxFeePerGas: bid.maxFeePerGas,
    bidGas: bid.gas,
    gasLimit: fees.gasLimit
  })
  return onRamp(plan) ? { kind: 'retry' } : { kind: 'backoff', reason: 'gas_unaffordable' }
}

/** Quotes, checks and simulates one alternative. */
const attempt = async (
  { plan, surplus, surplusUsd }: Candidate,
  out: LensOut,
  context: AttemptContext,
  deps: PrepareDeps
): Promise<Readonly<{ verdict: Verdict; calls: number | undefined }>> => {
  const { borrower, label, fields } = context
  const writeOff = isBadDebtRealization(plan)
  if (!writeOff && (surplus <= 0n || (surplusUsd !== null && surplusUsd <= 0n))) {
    deps.stats.add({ noSurplus: 1 })
    deps.logger.info('plan.no_surplus', { ...fields, surplus })
    return { verdict: { kind: 'skip', reason: 'no_surplus' }, calls: 0 }
  }
  let swap: SwapPlan | null = null
  let profit = surplus
  let calls: number | undefined = 0
  if (!writeOff) {
    const quote = await deps.quoteFor(plan, out, label)
    calls = quote.firmCalls
    if (quote.kind === 'no_config') {
      deps.stats.add({ noSwapPath: 1 })
      deps.logger.info('config.no_swap_path', fields)
      return { verdict: { kind: 'skip', reason: 'no_swap_path' }, calls }
    }
    if (quote.kind === 'failed') {
      if (quote.reason === 'floor_unmet') {
        deps.stats.add({ quoteUnprofitable: 1 })
        return { verdict: { kind: 'retry' }, calls }
      }
      deps.stats.add({ quoteFailed: 1 })
      return { verdict: { kind: 'backoff' }, calls }
    }
    const economics = assessProfitability({
      plan,
      swapPlan: quote.plan,
      minSurplusBps: deps.minSurplusBps
    })
    if (!economics.viable) {
      deps.stats.add({ quoteUnprofitable: 1 })
      deps.logger.info('quote.unprofitable', {
        ...fields,
        requiredRepay: economics.requiredRepay,
        requiredThreshold: economics.requiredThreshold,
        achievableOut: economics.achievableOut,
        shortfallBps: economics.shortfallBps,
        minSurplusBps: deps.minSurplusBps
      })
      return { verdict: { kind: 'retry' }, calls }
    }
    swap = quote.plan
    profit = economics.achievableOut - economics.requiredRepay
  }
  const data = deps.encode(out.market, borrower, plan, swap)
  const result = await deps.simulate(data)
  if (result.status === 'ok') {
    deps.stats.add({ ok: 1 })
    deps.logger.info('simulate.ok', fields)
    const verdict = writeOff
      ? ({ kind: 'sent', data } as const)
      : await spendFor(plan, profit, data, context, deps)
    return { verdict, calls }
  }
  deps.stats.add({ reverted: 1 })
  deps.logger.warn('simulate.revert', { ...fields, reason: result.reason })
  return { verdict: writeOff ? { kind: 'skip', reason: 'reverted' } : { kind: 'backoff' }, calls }
}
