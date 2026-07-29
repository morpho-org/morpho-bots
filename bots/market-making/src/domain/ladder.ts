import type { Hex } from 'viem'

import { isHex, size } from 'viem'

import { LadderConfigurationError } from './ladder-configuration.error'

const WEIGHT_SCALE_BPS = 10_000n

/**
 * Highest supported rung count per ladder side.
 * @remarks A two-sided ladder at this limit creates 1,024 offers, a height-10 tree. This remains
 * comfortably below Midnight SDK 1.2.0's height-20 tree limit while bounding local allocation.
 */
const MAX_LADDER_RUNG_COUNT = 512

/** Static shape, inventory limits, cadence, and hard rate range for one ladder market. */
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
  groupMode: 'shared-rung' | 'per-book'
  loopIntervalSeconds: number
  movementToleranceBps: bigint
  minimumRateBps: bigint
  maximumRateBps: bigint
}

/** Fresh capacities that independently cap each configured side budget. */
export type LadderMarketState = {
  lowerRateCapacityAssets?: bigint
  higherRateCapacityAssets?: bigint
  targetMarketCapacityAssets?: bigint
  maximumTotalCapacityAssets?: bigint
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
  groupMode: LadderConfig['groupMode']
  lower: readonly LadderRung[]
  higher: readonly LadderRung[]
}

type GenerateLadderParameters = {
  config: LadderConfig
  referenceRateBps: bigint
  capacities?: LadderMarketState
  retainedCenterRateBps?: bigint
}

const minimum = (values: readonly bigint[]) =>
  values.reduce((smallest, value) => (value < smallest ? value : smallest))

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

const allocateBudget = (budget: bigint, weights: readonly bigint[]) => {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n)
  const allocations = weights.map(weight => (budget * weight) / totalWeight)
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

const splitBudget = (lower: bigint, higher: bigint, aggregate: bigint) => {
  const requested = lower + higher
  if (requested <= aggregate) return { lower, higher }
  const lowerShare = (aggregate * lower) / requested
  return { lower: lowerShare, higher: aggregate - lowerShare }
}

const assertRungBounds = (rate: bigint, side: 'lower' | 'higher', config: LadderConfig) => {
  if (rate < config.minimumRateBps || rate > config.maximumRateBps) {
    throw new LadderConfigurationError(
      `${side}RateBps`,
      `${side} rung is outside the configured hard range`
    )
  }
}

/**
 * Validates one complete static ladder shape before any provider read.
 * @param config - Untrusted strategy configuration to validate.
 * @returns Nothing after every shape, amount, cadence, and hard-range invariant passes.
 * @throws LadderConfigurationError when any value is malformed or the full shape cannot fit.
 * @remarks Pure validation; it performs no environment, provider, logging, or publication access.
 */
export const validateLadderConfig = (config: LadderConfig): void => {
  if (!isHex(config.marketId, { strict: true }) || size(config.marketId) !== 32) {
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
 * Generates exact lower/higher rates and deterministic bigint allocations for one market snapshot.
 * @param parameters - Input object: `config` defines the static shape, budgets, cadence, and hard
 * rate range; `referenceRateBps` is the fresh reference in integer basis points; `capacities`
 * optionally supplies fresh side, market, and total budget caps; and `retainedCenterRateBps`
 * optionally keeps a previously active center inside movement tolerance while still requiring every
 * resulting rung to satisfy the configured hard range.
 * @returns Exact desired quote set; outer rungs receive integer-division remainders.
 * @throws LadderConfigurationError for invalid config, capacities, or any out-of-bounds runtime rung.
 * @remarks This domain operation never clamps rates and performs no protocol direction/tick mapping.
 */
export const generateLadder = (parameters: GenerateLadderParameters): LadderQuoteSet => {
  const { config, referenceRateBps, capacities = {}, retainedCenterRateBps } = parameters
  validateLadderConfig(config)
  const centerRateBps = retainedCenterRateBps ?? referenceRateBps + config.quotePremiumBps
  const weights = rungWeights(config)
  const budgets = splitBudget(
    sideBudget(config.lowerRateBudgetAssets, capacities.lowerRateCapacityAssets),
    sideBudget(config.higherRateBudgetAssets, capacities.higherRateCapacityAssets),
    aggregateBudget(config, capacities)
  )
  const lowerAllocations = allocateBudget(budgets.lower, weights)
  const higherAllocations = allocateBudget(budgets.higher, weights)
  const halfSpread = config.spreadBps / 2n
  const buildRungs = (side: 'lower' | 'higher', allocations: readonly bigint[]) =>
    weights.flatMap((_weight, index) => {
      const assets = allocations[index] ?? 0n
      if (assets === 0n) return []
      const offset = halfSpread + BigInt(index) * config.stepBps
      const rateBps = side === 'lower' ? centerRateBps - offset : centerRateBps + offset
      assertRungBounds(rateBps, side, config)
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
  const movement = activeCenterRateBps - effectiveCenterRateBps
  return (movement < 0n ? -movement : movement) > toleranceBps
}
