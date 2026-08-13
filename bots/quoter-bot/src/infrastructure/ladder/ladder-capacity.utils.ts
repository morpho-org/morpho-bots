import type { Hex } from 'viem'

/** Inputs required to derive replacement-aware ladder inventory capacities. */
type LadderCapacityParameters = {
  marketId: Hex
  balance: bigint
  currentCredit: bigint
  otherMarketCredit: bigint
  creditSaleCapacityAssets: bigint
  targetMarketExposureAssets: bigint
  maximumTotalExposureAssets: bigint
  reservations: readonly { id: Hex; marketIds: readonly Hex[]; assets: bigint }[]
}

/**
 * Derives market and aggregate ladder capacity without double-reserving replaced groups.
 * This is a pure projection with no side effects. Callers must provide validated, non-negative
 * balances, credits, limits, and reservations; malformed or negative inputs are not rejected.
 * @param parameters - Wallet balance, accrued credit, active reservations, and exposure limits.
 * @returns Fresh side, market, and total capacities.
 */
export const calculateLadderCapacities = (parameters: LadderCapacityParameters) => {
  const reserved = parameters.reservations.reduce((sum, item) => sum + item.assets, 0n)
  const marketReserved = parameters.reservations
    .filter(item => item.marketIds.includes(parameters.marketId))
    .reduce((sum, item) => sum + item.assets, 0n)
  const unreservedCash = parameters.balance > reserved ? parameters.balance - reserved : 0n
  const currentExposure = parameters.currentCredit + parameters.otherMarketCredit + reserved
  const totalLendRoom =
    parameters.maximumTotalExposureAssets > currentExposure
      ? parameters.maximumTotalExposureAssets - currentExposure
      : 0n
  const currentMarketExposure = parameters.currentCredit + marketReserved
  const marketLendRoom =
    parameters.targetMarketExposureAssets > currentMarketExposure
      ? parameters.targetMarketExposureAssets - currentMarketExposure
      : 0n
  const lendRoom = totalLendRoom < marketLendRoom ? totalLendRoom : marketLendRoom
  const cash = unreservedCash < lendRoom ? unreservedCash : lendRoom
  const credit =
    parameters.currentCredit < parameters.creditSaleCapacityAssets
      ? parameters.currentCredit
      : parameters.creditSaleCapacityAssets
  const market = cash + credit
  const total = totalLendRoom + credit
  return {
    lowerRateCapacityAssets: credit,
    higherRateCapacityAssets: cash,
    targetMarketCapacityAssets: market,
    maximumTotalCapacityAssets: total
  }
}
