import { AdaptiveCurveIrmLib, MathLib, SECONDS_PER_YEAR } from '@morpho-org/blue-sdk'
import { wholePercentToWAD } from '@repo/utils'

import type { MarketState, VaultMarketData } from './vault-data'

const WAD_PER_BIP_SCALE = 1_000_000_000n

/**
 * Deposit legs stop just short of each market's supply cap: the cap is scaled by this factor before
 * computing headroom, absorbing interest accrual between read and mined execution (a deposit that
 * lands exactly at cap would revert on any accrual).
 */
export const CAP_BUFFER_WAD = wholePercentToWAD(99.99)

/** Converts a WAD-scaled fraction to (fractional, signed) bips. */
export const wadToBips = (wad: bigint): number => Number(wad / WAD_PER_BIP_SCALE) / 1e5

// `MarketUtils.getUtilization` returns MAX_UINT_256 when supply is 0 and borrow is not; sizing math
// downstream needs the 0 guard instead.
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

// A 0 target means "deposit until utilization reaches 0%", which no finite deposit achieves — and
// `wDivDown(_, 0n)` would throw, erroring the whole vault every pass.
const getDepositToUtilization = (state: MarketState, targetUtilization: bigint): bigint =>
  targetUtilization === 0n
    ? 0n
    : MathLib.wMulDown(
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
  MathLib.min(
    getWithdrawalToUtilization(marketData.state, targetUtilization),
    marketData.vaultAssets
  )

/**
 * Assets depositable into a market before its utilization would fall below `targetUtilization`,
 * bounded by the vault's remaining headroom under `cap` scaled by the WAD `capBufferWad`. Callers
 * must only invoke this for markets whose current utilization is above the target.
 */
export const getDepositableAmount = (
  marketData: VaultMarketData,
  targetUtilization: bigint,
  capBufferWad: bigint
): bigint => {
  const remainingCap = MathLib.zeroFloorSub(
    MathLib.wMulDown(marketData.cap, capBufferWad),
    marketData.vaultAssets
  )
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
