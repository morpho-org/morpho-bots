import type { KeyRecord } from '@repo/engine'
import type { PairCurve, Venue, VenuePair } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import { task } from '@repo/controller'
import { curveIsTrusted, selectFromCurve, venuePairKey } from '@repo/swaps'
import { mulDivDown } from '@repo/utils'
import { getAddress, parseUnits } from 'viem'

import type { PricedToken } from './discovery/token-prices'
import type { LiquidationPlan, PlanSkip } from './sizing/plan'
import type { LensOut } from './state/lens.sol'

import { usdValueOf } from './discovery/token-prices'
import { expectedLoanOut } from './execution/swap-step'
import { planInputFromLens } from './runner/eligibility'
import { rankByNetUsdSurplus, scoreNetOfRouteCost } from './runner/ranking'
import {
  capCandidates,
  isBadDebtRealization,
  MAX_PROBED_CANDIDATES_PER_POSITION,
  planCandidates,
  planSurplus
} from './sizing/plan'

/** One liquidatable position as the world read it, at one block of the kernel's chain. */
export type PositionReading = Readonly<{
  marketId: Hex
  borrower: Address
  out: LensOut
  block: number
}>

export type SizingOptions = Readonly<{ seizeCapMarginBps: number; headroomFloorBps: number }>

/**
 * Every `(slot, mode)` alternative a position could be liquidated through, best gross surplus
 * first, why the others could not be sized, the token every alternative repays and each slot's
 * collateral token, and the block the reading was taken at.
 */
export type Sizing = Readonly<{
  plans: readonly LiquidationPlan[]
  skips: readonly PlanSkip[]
  loanToken: Address
  collateralTokens: readonly Address[]
  block: number
}>

export const sizePosition = (
  { out, block }: Pick<PositionReading, 'out' | 'block'>,
  options: SizingOptions
): Sizing => ({
  ...planCandidates(planInputFromLens(out), options),
  loanToken: out.market.loanToken,
  collateralTokens: out.market.collateralParams.map(collateral => collateral.token),
  block
})

/**
 * The pair a collateral sells through for a loan token, keyed by {@link routeKeyOf}. `null` when no
 * pair can be priced at an arbitrary size: an excluded collateral, a sell path that ends in the loan
 * token, or an unwrap chain only a size-dependent resolve can name, which the firm quote handles.
 */
export type RouteLevel = Readonly<{ pair: VenuePair | null; resolvedAt: number }>

export const routeKeyOf = (collateral: Address, loan: Address) => venuePairKey({ collateral, loan })

/** Readings by key, as a keyed level holds them; each counts only while present and unexpired. */
export type Readings<T> = Readonly<Record<string, KeyRecord<T>>>

/** What pricing a position's routes reads: token prices, routes and curves, and the enabled venues. */
export type Pricing = Readonly<{
  prices: Readings<PricedToken>
  routes: Readings<RouteLevel>
  curves: Readings<PairCurve>
  venues: readonly Venue[]
}>

/** Whether `reading` is present with an expiry still ahead of `now`; one with none never is. */
export const isLive = <T>(reading: KeyRecord<T> | undefined, now: number) =>
  reading?.status === 'present' && reading.expiry !== undefined && now < reading.expiry

const liveAt = <T>(readings: Readings<T>, key: string, now: number): T | undefined => {
  const reading = Object.hasOwn(readings, key) ? readings[key] : undefined
  return reading?.status === 'present' && isLive(reading, now) ? reading.value : undefined
}

const pick = <T>(readings: Readings<T>, keys: readonly string[]): Readings<T> =>
  Object.fromEntries(
    keys.flatMap(key => (Object.hasOwn(readings, key) ? [[key, readings[key]!] as const] : []))
  )

/**
 * The readings of `pricing` a position as `out` read it can price against, expired ones included:
 * its loan token's and the `native` token's prices, its activated collaterals' routes, and the
 * curves of the pairs those routes name.
 */
export const pricingOf = (
  out: Pick<LensOut, 'market' | 'collaterals'>,
  pricing: Pricing,
  native: Address
): Pricing => {
  const { market } = out
  const routes = pick(
    pricing.routes,
    out.collaterals.flatMap(({ index }) => {
      const token = market.collateralParams[index]?.token
      return token ? [routeKeyOf(token, market.loanToken)] : []
    })
  )
  const pairs = Object.values(routes).flatMap(route =>
    route.status === 'present' && route.value.pair ? [venuePairKey(route.value.pair)] : []
  )
  return {
    prices: pick(pricing.prices, [getAddress(market.loanToken), getAddress(native)]),
    routes,
    curves: pick(pricing.curves, pairs),
    venues: pricing.venues
  }
}

/** The USD value of `units` of `token` at `now`; `null` while its price is unknown or expired. */
export const usdValueAt = (pricing: Pricing, token: Address, units: bigint, now: number) =>
  usdValueOf(liveAt(pricing.prices, getAddress(token), now), units)

/**
 * `units` of `token` in wei of `native`, the chain's wrapped native token, through their USD prices
 * at `now`; `null` while either is unknown or expired.
 */
export const nativeValueAt = (
  pricing: Pricing,
  { token, units, native }: Readonly<{ token: Address; units: bigint; native: Address }>,
  now: number
) => {
  const usd = usdValueAt(pricing, token, units, now)
  const price = liveAt(pricing.prices, getAddress(native), now)
  if (usd === null || !price || price.priceE8 <= 0n) return null
  return mulDivDown(usd, parseUnits('1', price.decimals), price.priceE8)
}

/** A swap-free slot and a write-off sell nothing, so they cost nothing. */
export const sellsNothing = (plan: LiquidationPlan) => plan.swapFree || isBadDebtRealization(plan)

/** The alternatives whose routes are worth learning, best gross first. */
export const probedPlans = (sizing: Pick<Sizing, 'plans'>) =>
  capCandidates(sizing.plans, plan => plan.swapFree, MAX_PROBED_CANDIDATES_PER_POSITION)

/** The pair an alternative sells through while its route is live at `now`; `null` otherwise. */
export const pairOf = (
  plan: LiquidationPlan,
  sizing: Pick<Sizing, 'loanToken' | 'collateralTokens'>,
  routes: Readings<RouteLevel>,
  now: number
): VenuePair | null => {
  const token = sizing.collateralTokens[plan.collateralIndex]
  return (token && liveAt(routes, routeKeyOf(token, sizing.loanToken), now)?.pair) ?? null
}

/**
 * An alternative's route cost in loan units off its pair's stored curve at the alternative's own
 * size, read at `now` through the same trust check quoting uses: `0` for one that sells nothing,
 * `null` while its route or curve is unknown, expired, untrusted or unreferenced.
 */
export const routeCostOf = (
  plan: LiquidationPlan,
  sizing: Pick<Sizing, 'loanToken' | 'collateralTokens'>,
  pricing: Pricing,
  now: number
): Readonly<{ shortfall: bigint; bps: number }> | null => {
  if (sellsNothing(plan)) return { shortfall: 0n, bps: 0 }
  const pair = pairOf(plan, sizing, pricing.routes, now)
  const curve = pair && liveAt(pricing.curves, venuePairKey(pair), now)
  if (!curve) return null
  const reference = expectedLoanOut(plan)
  const estimates = selectFromCurve(curve, plan.seizedAssets, reference, now)
  const [best] = estimates
  if (!curveIsTrusted(estimates, pricing.venues) || !best || best.costBps === null) return null
  return {
    shortfall: reference > best.estimatedOut ? reference - best.estimatedOut : 0n,
    bps: best.costBps
  }
}

/** Ranks an unpriced position below every reachable score, as the tick ordered unpriced last. */
const UNRANKED_BID = -(2n ** 256n)

/**
 * A position's bid at `now`: its best alternative's USD surplus net of route cost, scored as a
 * preparation scores them. It falls open to gross surplus for the whole position when any
 * alternative's route cost is unknown or unpriced, and it orders positions without ever gating one.
 */
export const positionBid = (sizing: Sizing, pricing: Pricing, now: number): bigint => {
  const value = (units: bigint) => usdValueAt(pricing, sizing.loanToken, units, now)
  const scored = scoreNetOfRouteCost(
    probedPlans(sizing).map(plan => {
      const cost = routeCostOf(plan, sizing, pricing, now)
      return {
        label: '',
        surplusUsd: value(planSurplus(plan)),
        routeCostUsd: cost === null ? null : value(cost.shortfall)
      }
    })
  )
  return rankByNetUsdSurplus(scored)[0]?.netUsd ?? UNRANKED_BID
}

/**
 * The task a position's sizing wants: a bad-debt write-off, or a liquidation. Each backs off on its
 * own, so a position backed off for failed swaps still realizes its bad debt.
 */
export const taskOf = (sizing: Sizing | undefined): 'writeoff' | 'liquidate' =>
  sizing?.plans.some(isBadDebtRealization) ? 'writeoff' : 'liquidate'

/** A position takes one liquidation at a time, whichever of its alternatives that is. */
export const positionConflicts = (position: string) => ({ writes: [`position:${position}`] })

/** The act a position wants, ranked by its bid: the task its sizing names. */
export const liquidationTask = (
  { bid, task: name }: Readonly<{ bid: bigint; task: 'writeoff' | 'liquidate' }>,
  position: string
) =>
  task(name, {
    priority: bid,
    conflicts: positionConflicts(position)
  })
