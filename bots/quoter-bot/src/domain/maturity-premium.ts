/** Seconds in the 365-day year used to annualize maturity premiums, matching APR derivation. */
export const MATURITY_PREMIUM_YEAR_SECONDS = 31_536_000n

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
