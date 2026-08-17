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

// A 0 target is reachable (an APY bound at/below the curve's minimum rate, or an aggregate borrow
// that rounds to zero) and `wDivDown(_, 0n)` would throw, erroring the whole vault every pass.
// Depositing toward 0% utilization is unachievable and a 0-utilization market has nothing a
// withdrawal target constrains, so both size to 0.
const getWithdrawalToUtilization = (state: MarketState, targetUtilization: bigint): bigint =>
  targetUtilization === 0n
    ? 0n
    : MathLib.wMulDown(
        state.totalSupplyAssets,
        MathLib.WAD - MathLib.wDivDown(getUtilization(state), targetUtilization)
      )

const getDepositToUtilization = (state: MarketState, targetUtilization: bigint): bigint =>
  targetUtilization === 0n
    ? 0n
    : MathLib.wMulDown(
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
 * Remaining deposit headroom under one cap id, measured from `basis` — the id's effective post-leg
 * allocation. The adapter trues `allocation(id)` up to the market's ACCRUED position on every
 * touch, so `basis` must include accrual drift, not the stored allocation alone. A relative cap of
 * exactly WAD is the contract's "no relative constraint" sentinel (`allocateInternal` skips the
 * relative check entirely), never a binding 100%-of-totalAssets ceiling.
 */
export const getCapHeadroom = (
  cap: CapState,
  basis: bigint,
  totalAssets: bigint,
  capBufferPercent: number
): bigint => {
  const buffer = percentToWad(capBufferPercent)
  const bufferedAbsolute = MathLib.wMulDown(cap.absolute, buffer)
  const absoluteHeadroom = bufferedAbsolute > basis ? bufferedAbsolute - basis : 0n
  if (cap.relative === MathLib.WAD) return absoluteHeadroom
  const bufferedRelative = MathLib.wMulDown(MathLib.wMulUp(totalAssets, cap.relative), buffer)
  const relativeHeadroom = bufferedRelative > basis ? bufferedRelative - basis : 0n
  return MathLib.min(absoluteHeadroom, relativeHeadroom)
}

// The allocation true-up an allocate/deallocate leg applies to every id it touches: the accrued
// position minus the stored allocation (never negative — accrual only grows a position).
const accrualDrift = (marketData: VaultV2MarketData): bigint =>
  MathLib.max(0n, marketData.vaultAssets - marketData.cap.allocation)

/**
 * Assets allocatable into a market before its utilization would fall below `targetUtilization`,
 * bounded by the market cap id's remaining headroom measured from the ACCRUED position (what
 * `allocation(id)` becomes the moment the leg executes). Callers must only invoke this for markets
 * whose current utilization is above the target; adapter-level and collateral-level ceilings are
 * applied separately via {@link createDepositPools}.
 */
export const getDepositableAmount = (
  marketData: VaultV2MarketData,
  totalAssets: bigint,
  targetUtilization: bigint,
  capBufferPercent: number
): bigint =>
  MathLib.min(
    getDepositToUtilization(marketData.state, targetUtilization),
    getCapHeadroom(
      marketData.cap,
      MathLib.max(marketData.cap.allocation, marketData.vaultAssets),
      totalAssets,
      capBufferPercent
    )
  )

/**
 * Shared deposit ceilings above the per-market caps: the adapter-level ("this") cap id and one pool
 * per collateral cap id. Each pool's basis is the stored aggregate `allocation(id)` plus every
 * member market's accrual drift (a touched market trues its drift into all three ids; counting
 * untouched markets' drift too is safely conservative). Strategies credit their deallocation legs
 * back via {@link creditPools} — the contract executes deallocations first, so that capacity is
 * genuinely free — and draw allocation legs through {@link takeFromPools}, so a plan can never
 * exceed an aggregate cap.
 */
type DepositPools = {
  adapter: bigint
  byCollateral: Map<Address, bigint>
}

export const createDepositPools = (
  vaultData: VaultV2Data,
  capBufferPercent: number
): DepositPools => {
  const totalDrift = vaultData.marketsData.reduce((acc, m) => acc + accrualDrift(m), 0n)
  const driftByCollateral = new Map<Address, bigint>()
  for (const marketData of vaultData.marketsData) {
    const key = getAddress(marketData.params.collateralToken)
    driftByCollateral.set(key, (driftByCollateral.get(key) ?? 0n) + accrualDrift(marketData))
  }
  return {
    adapter: getCapHeadroom(
      vaultData.adapterCap,
      vaultData.adapterCap.allocation + totalDrift,
      vaultData.totalAssets,
      capBufferPercent
    ),
    byCollateral: new Map(
      Object.entries(vaultData.collateralCaps).map(([token, cap]) => [
        getAddress(token),
        getCapHeadroom(
          cap,
          cap.allocation + (driftByCollateral.get(getAddress(token)) ?? 0n),
          vaultData.totalAssets,
          capBufferPercent
        )
      ])
    )
  }
}

/** Credits capacity freed by a deallocation leg (executed before every allocation leg). */
export const creditPools = (
  pools: DepositPools,
  collateralToken: Address,
  amount: bigint
): void => {
  const key = getAddress(collateralToken)
  pools.adapter += amount
  pools.byCollateral.set(key, (pools.byCollateral.get(key) ?? 0n) + amount)
}

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
