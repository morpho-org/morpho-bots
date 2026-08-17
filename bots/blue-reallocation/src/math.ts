import { AdaptiveCurveIrmLib, MathLib } from '@morpho-org/blue-sdk'
import { parseUnits } from 'viem'

import type { MarketState, VaultMarketData } from './vault-data'

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
 * Assets withdrawable from a market before its utilization would exceed `targetUtilization`,
 * bounded by the vault's own position. Callers must only invoke this for markets whose current
 * utilization is below the target.
 */
export const getWithdrawableAmount = (
  marketData: VaultMarketData,
  targetUtilization: bigint
): bigint =>
  MathLib.min(getWithdrawalToUtilization(marketData.state, targetUtilization), marketData.vaultAssets)

/**
 * Assets depositable into a market before its utilization would fall below `targetUtilization`,
 * bounded by the vault's remaining headroom under `cap * capBufferPercent`. Callers must only
 * invoke this for markets whose current utilization is above the target.
 */
export const getDepositableAmount = (
  marketData: VaultMarketData,
  targetUtilization: bigint,
  capBufferPercent: number
): bigint => {
  const bufferedCap = MathLib.wMulDown(marketData.cap, percentToWad(capBufferPercent))
  const remainingCap =
    bufferedCap > marketData.vaultAssets ? bufferedCap - marketData.vaultAssets : 0n
  return MathLib.min(getDepositToUtilization(marketData.state, targetUtilization), remainingCap)
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
