import type { Hex } from 'viem'

import type { MaturityPremiumConfig } from './maturity-premium'
import type { RateRange } from './rate-range'

import { isBytes32 } from './bytes32'
import { CROSS_BOOK_CLEARANCE_BPS } from './cross-book'
import { frozenCopy } from './frozen-copy'
import { LadderConfigurationError } from './ladder-configuration.error'
import {
  hasAttainableMaturityPremiumBps,
  highestReachableMaturityPremiumBps,
  maturityPremiumConfigIssue,
  resolveMaturityPremiumBps
} from './maturity-premium'
import { violatedRateBound } from './rate-range'

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
/** Longest interval the runtime timer accepts; loop and cooldown intervals share it. */
export const MAX_MONITOR_INTERVAL_SECONDS = 2_147_483

/**
 * Raises every lend (higher-side) rate with the face credit held in the market.
 * @remarks Pricing intent, not a safety bound. Sells never move, so a taker cannot sell credit to
 * the ladder and buy it back cheaper; see {@link inventorySkewBps} for the rule.
 */
export type InventorySkewConfig = {
  /** Face credit above `neutralCredit` that raises lend rates by one `stepBps`. */
  unitsPerStep: bigint
  /** Face credit held with no skew; defaults to zero. */
  neutralCredit?: bigint
  /** Highest skew applied, in basis points. */
  maxSkewBps?: bigint
}

/** Static shape, inventory and offer floors, cadence, and hard rate range for one ladder market. */
export type LadderConfig = {
  marketId: Hex
  quotePremiumBps: bigint
  /** Optional premium function of time to maturity added on top of `quotePremiumBps`. */
  maturityPremium?: MaturityPremiumConfig
  spreadBps: bigint
  stepBps: bigint
  rungCount: number
  sizeSkewBps: bigint
  /** Zero makes the ladder {@link isLendOnlyLadder}. */
  lowerRateBudgetAssets: bigint
  higherRateBudgetAssets: bigint
  targetMarketExposureAssets: bigint
  maximumTotalExposureAssets: bigint
  minimumOfferAssets: bigint
  groupMode: 'shared-rung' | 'per-book'
  loopIntervalSeconds: number
  /** Seconds one side waits between replacements a third-party crossing triggered. */
  bookCrossedCooldownSeconds: number
  movementToleranceBps: bigint
  minimumRateBps: bigint
  maximumRateBps: bigint
  inventorySkew?: InventorySkewConfig
}

declare const validLadderConfig: unique symbol
/** A {@link LadderConfig} that passed {@link validateLadderConfig}, its only producer. */
export type ValidLadderConfig = Readonly<LadderConfig> & { readonly [validLadderConfig]: true }

/**
 * Whether a third party crosses this strategy's resting ladder on one side, and whether the
 * configured rate window can still clear it.
 */
export type LadderBookSideCrossing = { crossed: boolean; clearable: boolean }

/**
 * Fresh inventory by rate side plus exposure-increasing lend capacity for one ladder market.
 * @remarks Lower-rate capacity is accrued credit for reduce-only sells. Higher-rate capacity is
 * available loan-token balance and allowance for lend buys; target and total capacities cap only
 * that higher-rate exposure-increasing side. `bootstrapBuyRateBps` is the lowest live own
 * bootstrap-buy rate; sells quote at least {@link CROSS_BOOK_CLEARANCE_BPS} below it so the ladder
 * cannot cross the own bootstrap offer.
 *
 * `bookCrossing` is observed fresh every cycle and compared against nothing; generation ignores it.
 * It is absent when the book could not be observed this cycle, which suppresses only the
 * `book-crossed` replacement and never withdraws the ladder.
 *
 * `creditAssets` is the maker's face credit in this market; generation reads it only to price an
 * {@link InventorySkewConfig}. The other trailing fields are observation-only accounting
 * primitives that generation ignores; they exist because the capacities above are saturating minima
 * from which no position value can be reconstructed downstream. `maturityTimestamp` and
 * `observedTimestamp` come from the same read, so the workflow can recognize a matured market
 * without owning a clock.
 *
 * `minimumOfferUnits` replaces `minimumOfferAssets` as the smallest rung, in credit units.
 *
 * `withdrawnSides` are sides whose rate range held no aligned tick at the snapshot block; generation
 * ignores it, and the caller drops those sides from the generated quote.
 */
export type LadderMarketState = {
  lowerRateCapacityAssets?: bigint
  higherRateCapacityAssets?: bigint
  targetMarketCapacityAssets?: bigint
  maximumTotalCapacityAssets?: bigint
  bootstrapBuyRateBps?: bigint
  bookCrossing?: { lower: LadderBookSideCrossing; higher: LadderBookSideCrossing }
  cashBalanceAssets?: bigint
  creditAssets?: bigint
  otherMarketCreditAssets?: bigint
  reservedAssets?: bigint
  marketReservedAssets?: bigint
  maturityTimestamp?: bigint
  observedTimestamp?: bigint
  minimumOfferUnits?: bigint
  withdrawnSides?: readonly LadderWithdrawnSide[]
}

/**
 * A ladder side withdrawn because no aligned tick encoded its rates, at the snapshot or the
 * publication block.
 * @remarks Tick rounding moves with time to maturity, so a range that holds a tick at one block can
 * hold none at the next; the other side still publishes.
 */
export type LadderWithdrawnSide = 'lower' | 'higher'

/**
 * One exact domain rung before protocol-specific tick and buy/sell conversion.
 * @remarks `assets` is face credit, published as the offer's `maxUnits`.
 */
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
  /** Inventory skew added to every higher rung before the range check; absent means zero. */
  higherSkewBps?: bigint
}

type LadderOfferCapInput = Pick<LadderQuoteSet, 'groupMode' | 'lower' | 'higher'>

/**
 * Resolves the protocol `maxUnits` written onto every ladder offer.
 * @param quote - Group mode and per-rung allocations for both rate sides.
 * @returns One cap per rung, preserving side and rung order.
 * @remarks Pure and browser-safe. In `shared-rung`, an offer cap equals that rung's allocation. In
 * `per-book`, every offer on a side carries the side-wide allocation sum because consumption is
 * shared by the side's protocol group.
 */
export const offerCapsByRung = (quote: LadderOfferCapInput) => {
  const resolveSide = (rungs: readonly LadderRung[]) => {
    if (quote.groupMode === 'shared-rung') return rungs.map(rung => rung.assets)
    const sideTotal = rungs.reduce((total, rung) => total + rung.assets, 0n)
    return rungs.map(() => sideTotal)
  }
  return { lower: resolveSide(quote.lower), higher: resolveSide(quote.higher) }
}

type GenerateLadderParameters = {
  config: ValidLadderConfig
  referenceRateBps: bigint
  capacities?: LadderMarketState
  retainedCenterRateBps?: bigint
  secondsToMaturity?: bigint
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

const allocateBudget = (budget: bigint, weights: readonly bigint[], minimumOfferSize: bigint) => {
  const fundedRungCount = Number(minimum([BigInt(weights.length), budget / minimumOfferSize]))
  const fundedWeights = weights.slice(0, fundedRungCount)
  if (fundedWeights.length === 0) return []

  const reservedAssets = minimumOfferSize * BigInt(fundedWeights.length)
  const weightedAssets = budget - reservedAssets
  const totalWeight = fundedWeights.reduce((sum, weight) => sum + weight, 0n)
  const allocations = fundedWeights.map(
    weight => minimumOfferSize + (weightedAssets * weight) / totalWeight
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
 * Whether a ladder quotes lend buys only, configured as a zero `lowerRateBudgetAssets`.
 * @param config - Ladder whose lower-side budget decides it.
 * @returns `true` exactly when `lowerRateBudgetAssets` is zero.
 * @remarks Such a ladder never publishes a sell at any held credit, so its shape checks cover the
 * higher side alone; credit it buys is held to maturity.
 */
export const isLendOnlyLadder = (config: Pick<LadderConfig, 'lowerRateBudgetAssets'>) =>
  config.lowerRateBudgetAssets === 0n

const assertSideBudgetsCoverOfferFloor = (config: LadderConfig) => {
  if (!isLendOnlyLadder(config) && config.lowerRateBudgetAssets < config.minimumOfferAssets) {
    throw new LadderConfigurationError(
      'lowerRateBudgetAssets',
      'must be zero or at least minimumOfferAssets'
    )
  }
  if (config.higherRateBudgetAssets < config.minimumOfferAssets) {
    throw new LadderConfigurationError(
      'higherRateBudgetAssets',
      'must be at least minimumOfferAssets'
    )
  }
}

/**
 * Validates one complete static ladder shape before any provider read.
 * @param input - Untrusted strategy configuration to validate.
 * @returns A deeply frozen copy of `input`, typed as {@link ValidLadderConfig}, after every shape,
 * amount, cadence, and hard-range invariant passes; later writes through `input` cannot reach it.
 * @throws LadderConfigurationError when any value is malformed or the full shape cannot fit.
 * @remarks Pure validation; it performs no environment, provider, logging, or publication access.
 */
export const validateLadderConfig = <Config extends LadderConfig>(input: Config) => {
  const config = frozenCopy(input)
  if (!isBytes32(config.marketId)) {
    throw new LadderConfigurationError('marketId', 'must be a 0x-prefixed bytes32 hex value')
  }
  if (config.maturityPremium !== undefined) {
    const issue = maturityPremiumConfigIssue(config.maturityPremium)
    if (issue) throw new LadderConfigurationError(issue.field, issue.reason)
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
  nonnegative(config.lowerRateBudgetAssets, 'lowerRateBudgetAssets')
  positive(config.higherRateBudgetAssets, 'higherRateBudgetAssets')
  positive(config.targetMarketExposureAssets, 'targetMarketExposureAssets')
  positive(config.maximumTotalExposureAssets, 'maximumTotalExposureAssets')
  positive(config.minimumOfferAssets, 'minimumOfferAssets')
  assertSideBudgetsCoverOfferFloor(config)
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
  safePositive(config.bookCrossedCooldownSeconds, 'bookCrossedCooldownSeconds')
  if (config.bookCrossedCooldownSeconds > MAX_MONITOR_INTERVAL_SECONDS) {
    throw new LadderConfigurationError(
      'bookCrossedCooldownSeconds',
      `must not exceed ${MAX_MONITOR_INTERVAL_SECONDS}`
    )
  }
  nonnegative(config.movementToleranceBps, 'movementToleranceBps')
  nonnegative(config.minimumRateBps, 'minimumRateBps')
  positive(config.maximumRateBps, 'maximumRateBps')
  if (config.minimumRateBps >= config.maximumRateBps) {
    throw new LadderConfigurationError('minimumRateBps', 'must be less than maximumRateBps')
  }
  if (config.inventorySkew !== undefined) {
    const { unitsPerStep, neutralCredit, maxSkewBps } = config.inventorySkew
    positive(unitsPerStep, 'inventorySkew.unitsPerStep')
    if (neutralCredit !== undefined) nonnegative(neutralCredit, 'inventorySkew.neutralCredit')
    if (maxSkewBps !== undefined) {
      positive(maxSkewBps, 'inventorySkew.maxSkewBps')
      if (maxSkewBps > config.maximumRateBps - config.minimumRateBps) {
        throw new LadderConfigurationError(
          'inventorySkew.maxSkewBps',
          'must not exceed maximumRateBps minus minimumRateBps'
        )
      }
    }
  }
  const weights = rungWeights(config)
  if (weights.some(weight => weight <= 0n)) {
    throw new LadderConfigurationError('sizeSkewBps', 'every rung weight must be positive')
  }
  const rungSpan = BigInt(config.rungCount - 1) * config.stepBps
  const shapeWidth = isLendOnlyLadder(config) ? rungSpan : (config.spreadBps / 2n + rungSpan) * 2n
  if (shapeWidth > config.maximumRateBps - config.minimumRateBps) {
    throw new LadderConfigurationError(
      'spreadBps',
      'full ladder shape cannot fit in the hard range'
    )
  }
  return config as Config & ValidLadderConfig
}

/**
 * Validates that the full ladder shape quoted at one exact reference can fit the hard range.
 * @param config - Validated static strategy configuration.
 * @param referenceRateBps - Exact reference the shape is anchored to, before the quote premium.
 * @returns Nothing when the full shape fits inside the range at some reachable maturity premium.
 * @throws LadderConfigurationError when an outer rung stays outside the hard range at every
 * reachable maturity premium.
 * @remarks Static preflight for operator-pinned references: runtime generation omits out-of-range
 * rungs, so a hardcoded target that can never fit must fail loud at configuration time instead of
 * quietly quoting a thinned or empty ladder. A maturity premium moves the center along the reachable
 * envelope bounded by the configured cap and the protocol's 100-year maturity horizon, so load-time
 * rejection is reserved for shapes pinned outside a bound at every protocol-permitted maturity; a
 * transiently omitted rung is documented runtime behavior. The per-bound envelope checks give stable
 * field errors, and the final exact gate rejects a configuration whose floored premium steps jump
 * over every center that fits the full shape, so acceptance always means some protocol-permitted
 * maturity truly fits. A ladder that {@link isLendOnlyLadder} fits its higher side alone.
 */
export const assertLadderShapeAtReference = (
  config: ValidLadderConfig,
  referenceRateBps: bigint
): void => {
  const centerRateBps = referenceRateBps + config.quotePremiumBps
  const outerOffsetBps = config.spreadBps / 2n + BigInt(config.rungCount - 1) * config.stepBps
  const highestCenterRateBps =
    config.maturityPremium === undefined
      ? centerRateBps
      : centerRateBps + highestReachableMaturityPremiumBps(config.maturityPremium)
  const lendOnly = isLendOnlyLadder(config)
  const innerHigherOffsetBps = config.spreadBps / 2n
  if (lendOnly && highestCenterRateBps + innerHigherOffsetBps < config.minimumRateBps) {
    throw new LadderConfigurationError(
      'higherRateBps',
      'higher rung is outside the configured hard range'
    )
  }
  if (!lendOnly && highestCenterRateBps - outerOffsetBps < config.minimumRateBps) {
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
  if (
    config.maturityPremium !== undefined &&
    !hasAttainableMaturityPremiumBps(
      config.maturityPremium,
      config.minimumRateBps - centerRateBps + (lendOnly ? -innerHigherOffsetBps : outerOffsetBps),
      config.maximumRateBps - centerRateBps - outerOffsetBps
    )
  ) {
    throw new LadderConfigurationError(
      'centerRateBps',
      'must be attainable with the full shape inside the hard range'
    )
  }
}

/**
 * Resolves the complete premium applied to the reference rate for one ladder center.
 * @param config - Ladder configuration whose static and optional maturity premiums apply.
 * @param secondsToMaturity - Fresh seconds until market maturity from the current observation.
 * @returns The signed quote premium plus the resolved maturity premium in integer basis points.
 * @throws LadderConfigurationError when a maturity premium is configured without a fresh maturity
 * observation, so a wiring gap fails loud instead of silently quoting a flat curve.
 * @remarks Pure derivation with no provider access; the signed static quote premium keeps its
 * meaning while the maturity term is non-negative, so only further maturities raise the center.
 */
export const effectiveLadderPremiumBps = (
  config: LadderConfig,
  secondsToMaturity?: bigint
): bigint => {
  if (config.maturityPremium === undefined) return config.quotePremiumBps
  if (secondsToMaturity === undefined) {
    throw new LadderConfigurationError('maturityPremium', 'requires a maturity observation')
  }
  return (
    config.quotePremiumBps + resolveMaturityPremiumBps(config.maturityPremium, secondsToMaturity)
  )
}

const resolveInventorySkew = (
  skew: InventorySkewConfig,
  stepBps: bigint,
  creditAssets: bigint | undefined
) => {
  if (typeof creditAssets !== 'bigint' || creditAssets < 0n) {
    throw new LadderConfigurationError(
      'inventorySkew',
      'requires a non-negative credit observation'
    )
  }
  const neutralCredit = skew.neutralCredit ?? 0n
  const excessCredit = creditAssets > neutralCredit ? creditAssets - neutralCredit : 0n
  const unboundedBps = (stepBps * excessCredit) / skew.unitsPerStep
  const clamped = skew.maxSkewBps !== undefined && unboundedBps > skew.maxSkewBps
  return {
    skewBps: clamped ? skew.maxSkewBps! : unboundedBps,
    clamped,
    creditAssets,
    neutralCredit
  }
}

/**
 * Resolves the basis points added to every higher (lend) rung for the face credit held.
 * @param config - Ladder step and optional inventory skew.
 * @param creditAssets - Maker face credit in the market from the block-pinned snapshot.
 * @returns `min(maxSkewBps, floor(stepBps × max(0, credit − neutralCredit) / unitsPerStep))`, or
 * zero when no skew is configured.
 * @throws LadderConfigurationError when a skew is configured and `creditAssets` is missing or
 * negative, so a wiring gap can never quote lending at the unskewed rate.
 */
export const inventorySkewBps = (
  config: Pick<LadderConfig, 'stepBps' | 'inventorySkew'>,
  creditAssets: bigint | undefined
) =>
  config.inventorySkew === undefined
    ? 0n
    : resolveInventorySkew(config.inventorySkew, config.stepBps, creditAssets).skewBps

const higherShapedRateBps = (
  config: LadderConfig,
  centerRateBps: bigint,
  index: number,
  skewBps: bigint
) => centerRateBps + config.spreadBps / 2n + BigInt(index) * config.stepBps + skewBps

/**
 * Reports whether a fresh credit observation would publish any planned lend rung at a higher rate.
 * @param config - Configuration the quote was generated with.
 * @param quote - Planned quote set, carrying the skew it was generated at.
 * @param creditAssets - Fresh maker face credit in the market.
 * @returns `true` when the fresh skew exceeds `quote.higherSkewBps` and at least one higher rung is
 * planned, including a rung the fresh skew would push above `maximumRateBps` and so omit; always
 * `false` without a skew.
 * @throws LadderConfigurationError when a skew is configured and `creditAssets` is negative.
 * @remarks A lower fresh skew is never reported: the planned buys are then dearer than needed,
 * which is safe.
 */
export const higherRungsRepriced = (
  config: ValidLadderConfig,
  quote: Pick<LadderQuoteSet, 'centerRateBps' | 'higher' | 'higherSkewBps'>,
  creditAssets: bigint
) => {
  const freshSkewBps = inventorySkewBps(config, creditAssets)
  if (freshSkewBps <= (quote.higherSkewBps ?? 0n)) return false
  return quote.higher.some(
    rung =>
      higherShapedRateBps(config, quote.centerRateBps, rung.index, freshSkewBps) > rung.rateBps
  )
}

/**
 * Guardrail counts observed while generating one ladder side.
 * @remarks Aggregates, never per-rung records: a side may hold up to 512 rungs and regenerate every
 * second. `fundedRungs` counts rungs allocated before omission, so the published count is
 * `fundedRungs` minus both omitted counts. The two omission groups are disjoint, and a rung cleared
 * below the own bootstrap buy may also be omitted, so `clearedRungs` and the omitted counts can both
 * include it. `lowestOmittedRateBps` and `highestOmittedRateBps` are the most extreme rates omitted
 * below and above the range, present only when that group is non-empty.
 */
export type LadderSideDiagnostics = {
  configuredRungs: number
  fundedRungs: number
  omittedBelowMinimumRungs: number
  omittedBelowMinimumAssets: bigint
  lowestOmittedRateBps?: bigint
  omittedAboveMaximumRungs: number
  omittedAboveMaximumAssets: bigint
  highestOmittedRateBps?: bigint
  clearedRungs: number
}

/** Inventory skew applied to the higher side and the credit observation it was priced from. */
export type LadderInventorySkewDiagnostics = {
  inventorySkewBps: bigint
  /** Whether `maxSkewBps` bounded the skew. */
  skewClamped: boolean
  creditAssets: bigint
  neutralCredit: bigint
}

/** Guardrail counts for both sides of one generated quote set. */
export type LadderDiagnostics = {
  lower: LadderSideDiagnostics
  higher: LadderSideDiagnostics
  /** Present only when the market configures an inventory skew. */
  inventorySkew?: LadderInventorySkewDiagnostics
}

/**
 * Generates one ladder quote set alongside the guardrail counts that shaped it.
 * @param parameters - Same inputs as {@link generateLadder}.
 * @returns The desired quote set and the per-side omission, clearance, and funding counts.
 * @throws LadderConfigurationError for a negative capacity input, a non-positive
 * `minimumOfferUnits`, a configured maturity premium missing its maturity observation, or a
 * configured inventory skew missing its credit observation.
 * @remarks Exists so omitted rungs and cross-book repricing stay observable without a logger
 * reaching into this pure module; see {@link generateLadder} for the generation contract.
 */
export const generateLadderWithDiagnostics = (
  parameters: GenerateLadderParameters
): { quote: LadderQuoteSet; diagnostics: LadderDiagnostics } => {
  const {
    config,
    referenceRateBps,
    capacities = {},
    retainedCenterRateBps,
    secondsToMaturity
  } = parameters
  const effectivePremiumBps = effectiveLadderPremiumBps(config, secondsToMaturity)
  const centerRateBps = retainedCenterRateBps ?? referenceRateBps + effectivePremiumBps
  const skew =
    config.inventorySkew === undefined
      ? undefined
      : resolveInventorySkew(config.inventorySkew, config.stepBps, capacities.creditAssets)
  const higherSkewBps = skew?.skewBps ?? 0n
  const weights = rungWeights(config)
  const minimumOfferSize = capacities.minimumOfferUnits ?? config.minimumOfferAssets
  positive(minimumOfferSize, 'minimumOfferUnits')
  const lowerBudget = sideBudget(config.lowerRateBudgetAssets, capacities.lowerRateCapacityAssets)
  const higherBudget = minimum([
    sideBudget(config.higherRateBudgetAssets, capacities.higherRateCapacityAssets),
    aggregateBudget(config, capacities)
  ])
  const lowerAllocations = allocateBudget(lowerBudget, weights, minimumOfferSize)
  const higherAllocations = allocateBudget(higherBudget, weights, minimumOfferSize)
  const halfSpread = config.spreadBps / 2n
  const rateRange: RateRange = {
    minimumRateBps: config.minimumRateBps,
    maximumRateBps: config.maximumRateBps
  }
  const buildRungs = (
    side: 'lower' | 'higher',
    allocations: readonly bigint[],
    range: RateRange
  ) => {
    const diagnostics: LadderSideDiagnostics = {
      configuredRungs: side === 'lower' && isLendOnlyLadder(config) ? 0 : config.rungCount,
      fundedRungs: 0,
      omittedBelowMinimumRungs: 0,
      omittedBelowMinimumAssets: 0n,
      omittedAboveMaximumRungs: 0,
      omittedAboveMaximumAssets: 0n,
      clearedRungs: 0
    }
    const rungs = allocations.flatMap((assets, index) => {
      if (assets === 0n) return []
      const shapedRateBps =
        side === 'lower'
          ? centerRateBps - halfSpread - BigInt(index) * config.stepBps
          : higherShapedRateBps(config, centerRateBps, index, higherSkewBps)
      const rateBps =
        side === 'lower'
          ? clearedSellRateBps(shapedRateBps, capacities.bootstrapBuyRateBps)
          : shapedRateBps
      diagnostics.fundedRungs += 1
      if (rateBps !== shapedRateBps) diagnostics.clearedRungs += 1
      const violated = violatedRateBound(rateBps, range)
      if (violated === 'minimum') {
        diagnostics.omittedBelowMinimumRungs += 1
        diagnostics.omittedBelowMinimumAssets += assets
        diagnostics.lowestOmittedRateBps = bigintMin(
          diagnostics.lowestOmittedRateBps ?? rateBps,
          rateBps
        )
        return []
      }
      if (violated === 'maximum') {
        diagnostics.omittedAboveMaximumRungs += 1
        diagnostics.omittedAboveMaximumAssets += assets
        diagnostics.highestOmittedRateBps = bigintMax(
          diagnostics.highestOmittedRateBps ?? rateBps,
          rateBps
        )
        return []
      }
      return [{ index, rateBps, assets }]
    })
    return { rungs, diagnostics }
  }
  const lower = buildRungs('lower', lowerAllocations, rateRange)
  const higher = buildRungs('higher', higherAllocations, rateRange)
  return {
    quote: {
      marketId: config.marketId,
      centerRateBps,
      groupMode: config.groupMode,
      lower: lower.rungs,
      higher: higher.rungs,
      ...(skew === undefined ? {} : { higherSkewBps })
    },
    diagnostics: {
      lower: lower.diagnostics,
      higher: higher.diagnostics,
      ...(skew === undefined
        ? {}
        : {
            inventorySkew: {
              inventorySkewBps: skew.skewBps,
              skewClamped: skew.clamped,
              creditAssets: skew.creditAssets,
              neutralCredit: skew.neutralCredit
            }
          })
    }
  }
}

/**
 * Generates exact lower/higher rates and deterministic bigint allocations for one market snapshot.
 * @param parameters - Input object: `config` defines the static shape, budgets, cadence, and hard
 * rate range; `referenceRateBps` is the fresh reference in integer basis points; `capacities`
 * optionally supplies fresh balance, credit, exposure-increasing lend caps, and the live own
 * bootstrap-buy rate; `retainedCenterRateBps` optionally keeps a previously active center
 * inside movement tolerance while still omitting every resulting rung outside the hard range; and
 * `secondsToMaturity` supplies the fresh maturity observation a configured maturity premium
 * requires to raise the center by its resolved duration compensation.
 * @returns Exact desired quote set; only the nearest rates are funded when the side cannot support
 * every rung at `minimumOfferAssets` (or `minimumOfferUnits`), and the outermost funded
 * rung receives division remainders.
 * @throws LadderConfigurationError for a negative capacity input, a non-positive
 * `minimumOfferUnits`, a configured maturity premium missing its maturity observation —
 * even at a retained center, so a wiring gap can never quote silently without its configured
 * duration compensation — or a configured inventory skew missing its credit observation.
 * @remarks Pure derivation with no provider, logging, persistence, or publication access. The hard
 * range is an admissibility envelope, not a clamp target: a rung whose final rate fails
 * {@link violatedRateBound} is omitted with its allocation, which is never redistributed, so every
 * published rung is in range at its budgeted size. A side left with no rung withdraws. Sells quote
 * at least {@link CROSS_BOOK_CLEARANCE_BPS} below any live own bootstrap buy so both strategies
 * cannot cross, and a configured inventory skew raises every higher rung by
 * {@link inventorySkewBps}; both apply before the range check. Lower rungs never move with
 * inventory. Use {@link generateLadderWithDiagnostics} when omissions must be observable.
 */
export const generateLadder = (parameters: GenerateLadderParameters): LadderQuoteSet =>
  generateLadderWithDiagnostics(parameters).quote

/**
 * Determines whether a retained center must move after a fresh effective-center observation.
 * @param activeCenterRateBps - Current desired-set center.
 * @param effectiveCenterRateBps - Fresh reference plus the configured quote premium and any
 * resolved maturity premium.
 * @param toleranceBps - Inclusive no-op movement threshold.
 * @returns `true` only when absolute movement is strictly greater than tolerance.
 * @throws LadderConfigurationError when tolerance is negative.
 * @remarks The tolerance absorbs slow maturity-premium decay exactly like reference movement: a
 * retained center rests until the decayed effective center escapes the inclusive deadband.
 */
export const shouldRecenter = (
  activeCenterRateBps: bigint,
  effectiveCenterRateBps: bigint,
  toleranceBps: bigint
) => {
  nonnegative(toleranceBps, 'movementToleranceBps')
  return bigintAbs(activeCenterRateBps - effectiveCenterRateBps) > toleranceBps
}
