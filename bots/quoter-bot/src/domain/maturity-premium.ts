/** Seconds in the 365-day year used to annualize maturity premiums, matching APR derivation. */
export const MATURITY_PREMIUM_YEAR_SECONDS = 31_536_000n

/**
 * Longest protocol-permitted time to maturity, bounding every reachable maturity premium.
 * @remarks Midnight's `touchMarket` rejects `maturity > block.timestamp + 100 * 365 days`
 * (`MaturityTooFar`), so no fresh observation can exceed one hundred 365-day years.
 */
export const MATURITY_PREMIUM_MAX_MATURITY_SECONDS = 100n * MATURITY_PREMIUM_YEAR_SECONDS

/**
 * Operator-selected premium function of time to maturity added on top of a static premium.
 * @remarks `linear` is the initial shape: `premiumPerYearBps` scales with time to maturity and an
 * optional inclusive `maximumPremiumBps` caps the result. Additional shapes extend this tagged
 * union without changing existing configurations.
 */
export type MaturityPremiumConfig = {
  shape: 'linear'
  premiumPerYearBps: bigint
  maximumPremiumBps?: bigint
}

/**
 * Reports the first structural problem in a maturity-premium configuration.
 * @param config - Candidate maturity-premium configuration to inspect.
 * @returns A stable field/reason pair for the first invalid value, or `undefined` when valid.
 * @remarks Pure inspection with no side effects; callers convert issues into their own typed
 * configuration errors so bootstrap and future ladder adopters keep consistent semantics.
 */
export const maturityPremiumConfigIssue = (
  config: MaturityPremiumConfig
): { field: string; reason: string } | undefined => {
  if (config.premiumPerYearBps <= 0n) {
    return { field: 'maturityPremium.premiumPerYearBps', reason: 'must be positive' }
  }
  if (config.maximumPremiumBps !== undefined && config.maximumPremiumBps <= 0n) {
    return { field: 'maturityPremium.maximumPremiumBps', reason: 'must be positive' }
  }
  return undefined
}

/**
 * Resolves the premium contributed by a market's remaining time to maturity.
 * @param config - Validated maturity-premium configuration selecting the function shape.
 * @param secondsToMaturity - Fresh seconds remaining until the market's on-chain maturity.
 * @returns The non-negative integer premium in basis points; further maturity yields a higher
 * premium until the optional configured cap.
 * @remarks Integer floor division keeps the resolved premium stable between whole-BPS boundaries,
 * so a slowly decaying time to maturity does not churn otherwise unchanged offers. A market at or
 * past maturity contributes zero premium rather than failing.
 */
export const resolveMaturityPremiumBps = (
  config: MaturityPremiumConfig,
  secondsToMaturity: bigint
): bigint => {
  if (secondsToMaturity <= 0n) return 0n
  const premiumBps = (config.premiumPerYearBps * secondsToMaturity) / MATURITY_PREMIUM_YEAR_SECONDS
  if (config.maximumPremiumBps !== undefined && premiumBps > config.maximumPremiumBps) {
    return config.maximumPremiumBps
  }
  return premiumBps
}

/**
 * Resolves the highest premium any protocol-permitted maturity can produce.
 * @param config - Validated maturity-premium configuration selecting the function shape.
 * @returns The inclusive premium ceiling in integer basis points: the configured cap when it
 * binds, otherwise the premium resolved at the protocol's furthest permitted maturity.
 * @remarks Bounds the reachability envelope used by load-time validation and previews. The
 * envelope's endpoints (zero and this ceiling) are attainable premiums, but integer flooring makes
 * intermediate premiums a step function — a slope above one BPS per second (`premiumPerYearBps`
 * greater than {@link MATURITY_PREMIUM_YEAR_SECONDS}) skips individual integer values — so callers
 * must treat this as an envelope bound, never a claim that every intermediate value is attainable.
 */
export const highestReachableMaturityPremiumBps = (config: MaturityPremiumConfig): bigint =>
  resolveMaturityPremiumBps(config, MATURITY_PREMIUM_MAX_MATURITY_SECONDS)

/**
 * Reports whether some protocol-permitted maturity resolves a premium inside a window.
 * @param config - Validated maturity-premium configuration selecting the function shape.
 * @param lowestBps - Inclusive lower end of the acceptable premium window in basis points.
 * @param highestBps - Inclusive upper end of the acceptable premium window in basis points.
 * @returns `true` when at least one integer seconds-to-maturity in the protocol horizon resolves
 * a premium within the window; `false` when every attainable premium misses it.
 * @remarks Exact for the step function that integer flooring makes of the linear shape: a slope
 * above one BPS per second skips integer premiums, so the first attainable value at or above the
 * window (the floored step at the smallest sufficient maturity, saturated by the configured cap)
 * decides membership instead of the dense envelope. Zero is always attainable at maturity.
 */
export const hasAttainableMaturityPremiumBps = (
  config: MaturityPremiumConfig,
  lowestBps: bigint,
  highestBps: bigint
): boolean => {
  if (highestBps < 0n || highestBps < lowestBps) return false
  if (lowestBps <= 0n) return true
  if (highestReachableMaturityPremiumBps(config) < lowestBps) return false
  const firstSufficientSeconds =
    (lowestBps * MATURITY_PREMIUM_YEAR_SECONDS + config.premiumPerYearBps - 1n) /
    config.premiumPerYearBps
  const firstAttainableBps = resolveMaturityPremiumBps(config, firstSufficientSeconds)
  return firstAttainableBps <= highestBps
}
