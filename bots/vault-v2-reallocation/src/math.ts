import type { Address } from 'viem'

import { AdaptiveCurveIrmLib, MathLib } from '@morpho-org/blue-sdk'
import { getAddress, parseUnits } from 'viem'

import type { CapState, MarketState, VaultV2Data, VaultV2MarketData } from './vault-data'

const SECONDS_PER_YEAR = 60n * 60n * 24n * 365n

/** Converts a human percentage (e.g. `4.25`) to its WAD-scaled fraction. */
export const percentToWad = (percent: number): bigint => parseUnits(percent.toString(), 16)

/** WAD-scaled `totalBorrowAssets / totalSupplyAssets`; 0 for an empty market. */
export const getUtilization = (state: MarketState): bigint =>
  state.totalSupplyAssets === 0n
    ? 0n
    : MathLib.wDivDown(state.totalBorrowAssets, state.totalSupplyAssets)

const getWithdrawalToUtilization = (state: MarketState, targetUtilization: bigint): bigint =>
  MathLib.wMulDown(
    state.totalSupplyAssets,
    MathLib.WAD - MathLib.wDivDown(getUtilization(state), targetUtilization)
  )

const getDepositToUtilization = (state: MarketState, targetUtilization: bigint): bigint =>
  MathLib.wMulDown(
    state.totalSupplyAssets,
    MathLib.wDivDown(getUtilization(state), targetUtilization) - MathLib.WAD
  )

/**
 * Assets deallocatable from a market before its utilization would exceed `targetUtilization`,
 * bounded by the adapter's own position. Callers must only invoke this for markets whose current
 * utilization is below the target.
 */
export const getWithdrawableAmount = (
  marketData: VaultV2MarketData,
  targetUtilization: bigint
): bigint =>
  MathLib.min(
    getWithdrawalToUtilization(marketData.state, targetUtilization),
    marketData.vaultAssets
  )

/**
 * Remaining deposit headroom under one cap id: min of the buffered absolute cap and the buffered
 * relative cap (fraction of `totalAssets`) minus the id's on-chain `allocation` — the value the
 * contract enforces both caps against (accrued position assets drift above it as interest accrues).
 */
export const getCapHeadroom = (
  cap: CapState,
  totalAssets: bigint,
  capBufferPercent: number
): bigint => {
  const buffer = percentToWad(capBufferPercent)
  const bufferedAbsolute = MathLib.wMulDown(cap.absolute, buffer)
  const absoluteHeadroom =
    bufferedAbsolute > cap.allocation ? bufferedAbsolute - cap.allocation : 0n
  const bufferedRelative = MathLib.wMulDown(MathLib.wMulUp(totalAssets, cap.relative), buffer)
  const relativeHeadroom =
    bufferedRelative > cap.allocation ? bufferedRelative - cap.allocation : 0n
  return MathLib.min(absoluteHeadroom, relativeHeadroom)
}

/**
 * Assets allocatable into a market before its utilization would fall below `targetUtilization`,
 * bounded by the market cap id's remaining headroom ({@link getCapHeadroom}). Callers must only
 * invoke this for markets whose current utilization is above the target; adapter-level and
 * collateral-level ceilings are applied separately via {@link createDepositPools}.
 */
export const getDepositableAmount = (
  marketData: VaultV2MarketData,
  totalAssets: bigint,
  targetUtilization: bigint,
  capBufferPercent: number
): bigint =>
  MathLib.min(
    getDepositToUtilization(marketData.state, targetUtilization),
    getCapHeadroom(marketData.cap, totalAssets, capBufferPercent)
  )

/**
 * Shared deposit ceilings above the per-market caps: the adapter-level ("this") cap id and one pool
 * per collateral cap id, all enforced on-chain against `allocation(id)`. Strategies draw legs
 * through {@link takeFromPools} so a plan can never exceed an aggregate cap.
 */
type DepositPools = {
  adapter: bigint
  byCollateral: Map<Address, bigint>
}

export const createDepositPools = (
  vaultData: VaultV2Data,
  capBufferPercent: number
): DepositPools => ({
  adapter: getCapHeadroom(vaultData.adapterCap, vaultData.totalAssets, capBufferPercent),
  byCollateral: new Map(
    Object.entries(vaultData.collateralCaps).map(([token, cap]) => [
      getAddress(token),
      getCapHeadroom(cap, vaultData.totalAssets, capBufferPercent)
    ])
  )
})

/** Clamps `amount` to the adapter and collateral pools, decrements both, and returns the clamp. */
export const takeFromPools = (
  pools: DepositPools,
  collateralToken: Address,
  amount: bigint
): bigint => {
  const key = getAddress(collateralToken)
  const collateralPool = pools.byCollateral.get(key) ?? 0n
  const taken = MathLib.min(amount, MathLib.min(pools.adapter, collateralPool))
  pools.adapter -= taken
  pools.byCollateral.set(key, collateralPool - taken)
  return taken
}

/**
 * Converts a WAD-scaled APY to the equivalent per-second rate, approximating `ln(1 + apy)` with the
 * first three Taylor terms (the inverse of {@link rateToApy}).
 */
export const apyToRate = (apy: bigint): bigint => {
  const firstTerm = apy
  const secondTerm = MathLib.wMulDown(firstTerm, firstTerm)
  const thirdTerm = MathLib.wMulDown(secondTerm, firstTerm)
  const apr = firstTerm - secondTerm / 2n + thirdTerm / 3n
  return apr / SECONDS_PER_YEAR
}

/** Compounds a per-second rate to a WAD-scaled APY (Blue's wTaylorCompounded). */
export const rateToApy = (rate: bigint): bigint => MathLib.wTaylorCompounded(rate, SECONDS_PER_YEAR)

/** Utilization at which the AdaptiveCurveIRM yields `rate`, given the market's `rateAtTarget`. */
export const rateToUtilization = (rate: bigint, rateAtTarget: bigint): bigint =>
  AdaptiveCurveIrmLib.getUtilizationAtBorrowRate(rate, rateAtTarget)

/**
 * Instantaneous AdaptiveCurveIRM rate at `utilization`, given the market's `rateAtTarget`.
 * Utilization is clamped to WAD — above 100% (bad-debt states) the curve's max rate applies.
 */
export const utilizationToRate = (utilization: bigint, rateAtTarget: bigint): bigint =>
  AdaptiveCurveIrmLib.getBorrowRate(MathLib.min(utilization, MathLib.WAD), rateAtTarget, 0n)
    .endBorrowRate
