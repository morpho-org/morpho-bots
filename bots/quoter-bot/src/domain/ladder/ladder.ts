import type { Hex } from 'viem'

import { isBytes32 } from '../bytes32'
import { CROSS_BOOK_CLEARANCE_BPS } from '../cross-book'
import { LadderConfigurationError } from './ladder-configuration.error'

const WEIGHT_SCALE_BPS = 10_000n
const bigintAbs = (value: bigint) => (value < 0n ? -value : value)
const bigintMin = (left: bigint, right: bigint) => (left < right ? left : right)
const bigintMax = (left: bigint, right: bigint) => (left > right ? left : right)

/**
 * Highest supported rung count per ladder side.
 * @remarks A two-sided ladder at this limit creates 1,024 offers, a height-10 tree. This remains
 * comfortably below Midnight SDK 1.2.0's height-20 tree limit while bounding local allocation.
 */
const MAX_LADDER_RUNG_COUNT = 512
const MAX_MONITOR_INTERVAL_SECONDS = 2_147_483

/** Static shape, inventory and offer floors, cadence, and hard rate range for one ladder market. */
export type LadderConfig = {
  marketId: Hex
  quotePremiumBps: bigint
  spreadBps: bigint
  stepBps: bigint
  rungCount: number
  sizeSkewBps: bigint
  lowerRateBudgetAssets: bigint
  higherRateBudgetAssets: bigint
  targetMarketExposureAssets: bigint
  maximumTotalExposureAssets: bigint
  minimumOfferAssets: bigint
  groupMode: 'shared-rung' | 'per-book'
  loopIntervalSeconds: number
  movementToleranceBps: bigint
  minimumRateBps: bigint
  maximumRateBps: bigint
}

/**
 * Fresh inventory by rate side plus exposure-increasing lend capacity for one ladder market.
 * @remarks Lower-rate capacity is accrued credit for reduce-only sells. Higher-rate capacity is
 * available loan-token balance and allowance for lend buys; target and total capacities cap only
 * that higher-rate exposure-increasing side. `bootstrapBuyRateBps` is the highest live own
 * bootstrap-buy rate; sells quote at least {@link CROSS_BOOK_CLEARANCE_BPS} below it so the ladder
 * cannot cross the own bootstrap offer.
 */
export type LadderMarketState = {
  lowerRateCapacityAssets?: bigint
  higherRateCapacityAssets?: bigint
  targetMarketCapacityAssets?: bigint
  maximumTotalCapacityAssets?: bigint
  bootstrapBuyRateBps?: bigint
}

/** One exact domain rung before protocol-specific tick and buy/sell conversion. */
export type LadderRung = {
  index: number
  rateBps: bigint
  assets: bigint
}

/** Complete desired lower/higher quote set at one retained or fresh center. */
export type LadderQuoteSet = {
  marketId: Hex
  centerRateBps: bigint
  referenceObservationId?: string
  groupMode: LadderConfig['groupMode']
  lower: readonly LadderRung[]
  higher: readonly LadderRung[]
}

type LadderOfferCapInput = Pick<LadderQuoteSet, 'groupMode' | 'lower' | 'higher'>

/**
 * Resolves the protocol `maxAssets` written onto every ladder offer.
 * @param quote - Group mode and per-rung allocations for both rate sides.
 * @returns One cap per rung, preserving side and rung order.
 * @remarks Pure and browser-safe. In `shared-rung`, an offer cap equals that rung's allocation. In
 * `per-book`, every offer on a side carries the side-wide allocation sum because consumption is
 * shared by the side's protocol group.
 */
export const offerMaxAssetsByRung = (quote: LadderOfferCapInput) => {
  const resolveSide = (rungs: readonly LadderRung[]) => {
    if (quote.groupMode === 'shared-rung') return rungs.map(rung => rung.assets)
    const sideTotal = rungs.reduce((total, rung) => total + rung.assets, 0n)
    return rungs.map(() => sideTotal)
  }
  return { lower: resolveSide(quote.lower), higher: resolveSide(quote.higher) }
}

type GenerateLadderParameters = {
  config: LadderConfig
  referenceRateBps: bigint
  capacities?: LadderMarketState
  retainedCenterRateBps?: bigint
}

const minimum = (values: readonly bigint[]) => values.reduce(bigintMin)

const positive = (value: bigint, field: string) => {
  if (value <= 0n) throw new LadderConfigurationError(field, 'must be positive')
}

const nonnegative = (value: bigint, field: string) => {
  if (value < 0n) throw new LadderConfigurationError(field, 'must not be negative')
}

const safePositive = (value: number, field: string) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new LadderConfigurationError(field, 'must be a positive safe integer')
  }
}

const rungWeights = (config: LadderConfig) =>
  Array.from(
    { length: config.rungCount },
    (_, index) => WEIGHT_SCALE_BPS + BigInt(index) * config.sizeSkewBps
  )

const allocateBudget = (budget: bigint, weights: readonly bigint[], minimumOfferAssets: bigint) => {
  const fundedRungCount = Number(minimum([BigInt(weights.length), budget / minimumOfferAssets]))
  const fundedWeights = weights.slice(0, fundedRungCount)
  if (fundedWeights.length === 0) return []

  const reservedAssets = minimumOfferAssets * BigInt(fundedWeights.length)
  const weightedAssets = budget - reservedAssets
  const totalWeight = fundedWeights.reduce((sum, weight) => sum + weight, 0n)
  const allocations = fundedWeights.map(
    weight => minimumOfferAssets + (weightedAssets * weight) / totalWeight
  )
  const allocated = allocations.reduce((sum, allocation) => sum + allocation, 0n)
  allocations[allocations.length - 1] = (allocations.at(-1) ?? 0n) + budget - allocated
  return allocations
}

const sideBudget = (configured: bigint, capacity: bigint | undefined) => {
  if (capacity === undefined) return configured
  nonnegative(capacity, 'capacityAssets')
  return minimum([configured, capacity])
}

const aggregateBudget = (config: LadderConfig, capacities: LadderMarketState) => {
  const values = [config.targetMarketExposureAssets, config.maximumTotalExposureAssets]
  for (const capacity of [
    capacities.targetMarketCapacityAssets,
    capacities.maximumTotalCapacityAssets
  ]) {
    if (capacity !== undefined) {
      nonnegative(capacity, 'capacityAssets')
      values.push(capacity)
    }
  }
  return minimum(values)
}

const clearedSellRateBps = (rate: bigint, bootstrapBuyRateBps: bigint | undefined) =>
  bootstrapBuyRateBps === undefined
    ? rate
    : bigintMin(rate, bootstrapBuyRateBps - CROSS_BOOK_CLEARANCE_BPS)

/**
 * Validates one complete static ladder shape before any provider read.
 * @param config - Untrusted strategy configuration to validate.
 * @returns Nothing after every shape, amount, cadence, and hard-range invariant passes.
 * @throws LadderConfigurationError when any value is malformed or the full shape cannot fit.
 * @remarks Pure validation; it performs no environment, provider, logging, or publication access.
 */
export const validateLadderConfig = (config: LadderConfig): void => {
  if (!isBytes32(config.marketId)) {
    throw new LadderConfigurationError('marketId', 'must be a 0x-prefixed bytes32 hex value')
  }
  positive(config.spreadBps, 'spreadBps')
  if (config.spreadBps % 2n !== 0n) {
    throw new LadderConfigurationError('spreadBps', 'must be even')
  }
  positive(config.stepBps, 'stepBps')
  safePositive(config.rungCount, 'rungCount')
  if (config.rungCount > MAX_LADDER_RUNG_COUNT) {
    throw new LadderConfigurationError('rungCount', `must not exceed ${MAX_LADDER_RUNG_COUNT}`)
  }
  positive(config.lowerRateBudgetAssets, 'lowerRateBudgetAssets')
  positive(config.higherRateBudgetAssets, 'higherRateBudgetAssets')
  positive(config.targetMarketExposureAssets, 'targetMarketExposureAssets')
  positive(config.maximumTotalExposureAssets, 'maximumTotalExposureAssets')
  positive(config.minimumOfferAssets, 'minimumOfferAssets')
  if (config.lowerRateBudgetAssets < config.minimumOfferAssets) {
    throw new LadderConfigurationError(
      'lowerRateBudgetAssets',
      'must be at least minimumOfferAssets'
    )
  }
  if (config.higherRateBudgetAssets < config.minimumOfferAssets) {
    throw new LadderConfigurationError(
      'higherRateBudgetAssets',
      'must be at least minimumOfferAssets'
    )
  }
  if (config.targetMarketExposureAssets > config.maximumTotalExposureAssets) {
    throw new LadderConfigurationError(
      'targetMarketExposureAssets',
      'must not exceed maximumTotalExposureAssets'
    )
  }
  if (config.groupMode !== 'shared-rung' && config.groupMode !== 'per-book') {
    throw new LadderConfigurationError('groupMode', 'must be shared-rung or per-book')
  }
  safePositive(config.loopIntervalSeconds, 'loopIntervalSeconds')
  if (config.loopIntervalSeconds > MAX_MONITOR_INTERVAL_SECONDS) {
    throw new LadderConfigurationError(
      'loopIntervalSeconds',
      `must not exceed ${MAX_MONITOR_INTERVAL_SECONDS}`
    )
  }
  nonnegative(config.movementToleranceBps, 'movementToleranceBps')
  nonnegative(config.minimumRateBps, 'minimumRateBps')
  positive(config.maximumRateBps, 'maximumRateBps')
  if (config.minimumRateBps >= config.maximumRateBps) {
    throw new LadderConfigurationError('minimumRateBps', 'must be less than maximumRateBps')
  }
  const weights = rungWeights(config)
  if (weights.some(weight => weight <= 0n)) {
    throw new LadderConfigurationError('sizeSkewBps', 'every rung weight must be positive')
  }
  const sideWidth = config.spreadBps / 2n + BigInt(config.rungCount - 1) * config.stepBps
  if (sideWidth * 2n > config.maximumRateBps - config.minimumRateBps) {
    throw new LadderConfigurationError(
      'spreadBps',
      'full ladder shape cannot fit in the hard range'
    )
  }
}

/**
 * Validates that the full ladder shape quoted at one exact reference fits the hard range.
 * @param config - Static strategy configuration whose shape and bounds are validated first.
 * @param referenceRateBps - Exact reference the shape is anchored to, before the quote premium.
 * @returns Nothing when every rung of the full shape stays inside the hard range.
 * @throws LadderConfigurationError when the config is invalid or an outer rung leaves the range.
 * @remarks Static preflight for operator-pinned references: runtime generation clamps rungs, so a
 * hardcoded target that cannot fit unclamped must fail loud at configuration time instead.
 */
export const assertLadderShapeAtReference = (
  config: LadderConfig,
  referenceRateBps: bigint
): void => {
  validateLadderConfig(config)
  const centerRateBps = referenceRateBps + config.quotePremiumBps
  const outerOffsetBps = config.spreadBps / 2n + BigInt(config.rungCount - 1) * config.stepBps
  if (centerRateBps - outerOffsetBps < config.minimumRateBps) {
    throw new LadderConfigurationError(
      'lowerRateBps',
      'lower rung is outside the configured hard range'
    )
  }
  if (centerRateBps + outerOffsetBps > config.maximumRateBps) {
    throw new LadderConfigurationError(
      'higherRateBps',
      'higher rung is outside the configured hard range'
    )
  }
}

/**
 * Generates exact lower/higher rates and deterministic bigint allocations for one market snapshot.
 * @param parameters - Input object: `config` defines the static shape, budgets, cadence, and hard
 * rate range; `referenceRateBps` is the fresh reference in integer basis points; `capacities`
 * optionally supplies fresh balance, credit, exposure-increasing lend caps, and the live own
 * bootstrap-buy rate; and `retainedCenterRateBps` optionally keeps a previously active center
 * inside movement tolerance while still clamping every resulting rung into the hard range.
 * @returns Exact desired quote set; only the nearest rates are funded when the side cannot support
 * every rung at `minimumOfferAssets`, and the outermost funded rung receives division remainders.
 * @throws LadderConfigurationError for an invalid config or negative capacity input.
 * @remarks Sells walking below the hard range saturate at `minimumRateBps`, while buys walking above
 * it saturate at `maximumRateBps`. A sell above the maximum or buy below the minimum is suppressed
 * instead of being moved through the opposite bound, so the two sides cannot collapse onto one rate.
 * Sells additionally quote at least {@link CROSS_BOOK_CLEARANCE_BPS} below any live own bootstrap buy.
 * Saturated neighbouring same-side rungs may share one rate; tick mapping merges equal-tick rungs.
 */
export const generateLadder = (parameters: GenerateLadderParameters): LadderQuoteSet => {
  const { config, referenceRateBps, capacities = {}, retainedCenterRateBps } = parameters
  validateLadderConfig(config)
  const centerRateBps = retainedCenterRateBps ?? referenceRateBps + config.quotePremiumBps
  const weights = rungWeights(config)
  const lowerBudget = sideBudget(config.lowerRateBudgetAssets, capacities.lowerRateCapacityAssets)
  const higherBudget = minimum([
    sideBudget(config.higherRateBudgetAssets, capacities.higherRateCapacityAssets),
    aggregateBudget(config, capacities)
  ])
  const lowerAllocations = allocateBudget(lowerBudget, weights, config.minimumOfferAssets)
  const higherAllocations = allocateBudget(higherBudget, weights, config.minimumOfferAssets)
  const halfSpread = config.spreadBps / 2n
  const buildRungs = (side: 'lower' | 'higher', allocations: readonly bigint[]) =>
    allocations.flatMap((assets, index) => {
      if (assets === 0n) return []
      const offset = halfSpread + BigInt(index) * config.stepBps
      const shapedRateBps = side === 'lower' ? centerRateBps - offset : centerRateBps + offset
      const clearedRateBps =
        side === 'lower'
          ? clearedSellRateBps(shapedRateBps, capacities.bootstrapBuyRateBps)
          : shapedRateBps
      if (side === 'lower' && clearedRateBps > config.maximumRateBps) return []
      if (side === 'higher' && clearedRateBps < config.minimumRateBps) return []
      const rateBps =
        side === 'lower'
          ? bigintMax(clearedRateBps, config.minimumRateBps)
          : bigintMin(clearedRateBps, config.maximumRateBps)
      return [{ index, rateBps, assets }]
    })
  const lower = buildRungs('lower', lowerAllocations)
  const higher = buildRungs('higher', higherAllocations)
  return { marketId: config.marketId, centerRateBps, groupMode: config.groupMode, lower, higher }
}

/**
 * Determines whether a retained center must move after a fresh effective-center observation.
 * @param activeCenterRateBps - Current desired-set center.
 * @param effectiveCenterRateBps - Fresh reference plus configured quote premium.
 * @param toleranceBps - Inclusive no-op movement threshold.
 * @returns `true` only when absolute movement is strictly greater than tolerance.
 * @throws LadderConfigurationError when tolerance is negative.
 */
export const shouldRecenter = (
  activeCenterRateBps: bigint,
  effectiveCenterRateBps: bigint,
  toleranceBps: bigint
) => {
  nonnegative(toleranceBps, 'movementToleranceBps')
  return bigintAbs(activeCenterRateBps - effectiveCenterRateBps) > toleranceBps
}
