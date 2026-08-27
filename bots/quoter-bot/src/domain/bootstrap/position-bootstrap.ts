import type { Hex } from 'viem'

import type { MaturityPremiumConfig } from '../maturity-premium'

import { isBytes32 } from '../bytes32'
import { clampRateBps } from '../cross-book'
import { maturityPremiumConfigIssue, resolveMaturityPremiumBps } from '../maturity-premium'
import { BootstrapConfigurationError } from './bootstrap-configuration.error'

const bigintMin = (left: bigint, right: bigint) => (left < right ? left : right)

/** Static safety bounds and behavior for bootstrapping one canonical market. */
export type BootstrapConfig = {
  marketId: Hex
  creditTarget: bigint
  acceptanceAssets: bigint
  offerSize: bigint
  premiumBps: bigint
  /** Optional premium function of time to maturity added on top of `premiumBps`. */
  maturityPremium?: MaturityPremiumConfig
  maximumMarketExposure: bigint
  maximumTotalExposure: bigint
  minimumRateBps: bigint
  maximumRateBps: bigint
  autoRefill: boolean
}

/** Fresh balance, credit, and exposure inputs used to cap a bootstrap offer. */
export type BootstrapPosition = {
  credit: bigint
  cashBalance: bigint
  marketExposure: bigint
  totalExposure: bigint
}

/** Reference-rate observation and replacement semantics used for offer derivation. */
export type BootstrapRate = {
  mode: 'static' | 'variable'
  rateBps: bigint
  observationId: string
  /** Fresh seconds until market maturity, required by maturity-premium configurations. */
  secondsToMaturity?: bigint
}

/** Fully derived market offer suitable for application-port reconciliation. */
export type BootstrapOffer = {
  marketId: Hex
  assets: bigint
  rateBps: bigint
  referenceObservationId: string
}

type PositionBootstrapParameters = {
  config: BootstrapConfig
  position: BootstrapPosition
  rate: BootstrapRate
  activeOffer?: BootstrapOffer
  requiresReconciliation?: boolean
  initialTargetCompleted: boolean
}

type PositionBootstrapTransitionParameters = Pick<
  PositionBootstrapParameters,
  'config' | 'position' | 'activeOffer' | 'initialTargetCompleted'
>

/** Bootstrap decisions that need no reference-rate read. */
export type PositionBootstrapTransitionDecision =
  | { kind: 'invalidate'; reason: 'target-reached'; completesInitialTarget: true }
  | { kind: 'target-reached'; completesInitialTarget: true; credit: bigint; acceptedCredit: bigint }
  | { kind: 'invalidate'; reason: 'auto-refill-disabled'; completesInitialTarget: false }
  | { kind: 'observe'; reason: 'auto-refill-disabled'; credit: bigint; acceptedCredit: bigint }

/** Complete deterministic action returned for one fresh bootstrap market snapshot. */
export type PositionBootstrapDecision =
  | PositionBootstrapTransitionDecision
  | { kind: 'invalidate'; reason: 'no-capacity'; completesInitialTarget: false }
  | { kind: 'observe'; reason: 'no-capacity'; assets: 0n }
  | { kind: 'rest'; offer: BootstrapOffer }
  | { kind: 'replace'; activeOffer: BootstrapOffer; offer: BootstrapOffer }
  | { kind: 'publish'; offer: BootstrapOffer }

const sameOffer = (left: BootstrapOffer, right: BootstrapOffer) =>
  left.marketId === right.marketId && left.assets === right.assets && left.rateBps === right.rateBps

/**
 * Validates the static bounds required by a market bootstrap strategy.
 * @param config - Bootstrap configuration to validate without reading dynamic position data.
 * @returns Nothing when every structural invariant is valid.
 * @throws BootstrapConfigurationError when a configured amount, rate, or exposure bound is unsafe.
 * @remarks This pure validation has no publication, persistence, or provider side effects.
 */
export const validateBootstrapConfig = (config: BootstrapConfig): void => {
  if (!isBytes32(config.marketId)) {
    throw new BootstrapConfigurationError('marketId', 'must be a 0x-prefixed bytes32 hex value')
  }
  if (config.creditTarget <= 0n) {
    throw new BootstrapConfigurationError('creditTarget', 'must be positive')
  }
  if (config.acceptanceAssets < 0n) {
    throw new BootstrapConfigurationError('acceptanceAssets', 'must not be negative')
  }
  if (config.acceptanceAssets > config.creditTarget) {
    throw new BootstrapConfigurationError('acceptanceAssets', 'must not exceed creditTarget')
  }
  if (config.offerSize <= 0n) {
    throw new BootstrapConfigurationError('offerSize', 'must be positive')
  }
  if (config.premiumBps > 0n) {
    throw new BootstrapConfigurationError('premiumBps', 'must be zero or negative')
  }
  if (config.maturityPremium !== undefined) {
    const issue = maturityPremiumConfigIssue(config.maturityPremium)
    if (issue) throw new BootstrapConfigurationError(issue.field, issue.reason)
  }
  if (config.minimumRateBps < 0n) {
    throw new BootstrapConfigurationError('minimumRateBps', 'must not be negative')
  }
  if (config.maximumRateBps < 0n) {
    throw new BootstrapConfigurationError('maximumRateBps', 'must not be negative')
  }
  if (config.minimumRateBps > config.maximumRateBps) {
    throw new BootstrapConfigurationError('minimumRateBps', 'must not exceed maximumRateBps')
  }
  if (config.maximumMarketExposure <= 0n) {
    throw new BootstrapConfigurationError('maximumMarketExposure', 'must be positive')
  }
  if (config.maximumTotalExposure <= 0n) {
    throw new BootstrapConfigurationError('maximumTotalExposure', 'must be positive')
  }
  if (config.maximumMarketExposure > config.maximumTotalExposure) {
    throw new BootstrapConfigurationError(
      'maximumMarketExposure',
      'must not exceed maximumTotalExposure'
    )
  }
}

/**
 * Decides completion and one-shot transitions that do not require a reference-rate read.
 * @returns A transition decision, or `undefined` when reference-rate derivation is still required.
 */
export const decidePositionBootstrapTransition = ({
  config,
  position,
  activeOffer,
  initialTargetCompleted
}: PositionBootstrapTransitionParameters): PositionBootstrapTransitionDecision | undefined => {
  validateBootstrapConfig(config)

  const acceptedCredit = config.creditTarget - config.acceptanceAssets

  if (position.credit >= acceptedCredit) {
    if (activeOffer) {
      return {
        kind: 'invalidate',
        reason: 'target-reached',
        completesInitialTarget: true
      }
    }

    return {
      kind: 'target-reached',
      completesInitialTarget: true,
      credit: position.credit,
      acceptedCredit
    }
  }

  if (initialTargetCompleted && !config.autoRefill) {
    if (activeOffer) {
      return {
        kind: 'invalidate',
        reason: 'auto-refill-disabled',
        completesInitialTarget: false
      }
    }
    return {
      kind: 'observe',
      reason: 'auto-refill-disabled',
      credit: position.credit,
      acceptedCredit
    }
  }

  return undefined
}

/** Which configured limit bound one bootstrap offer's size. */
export type BootstrapSizeCap =
  | 'offer-size'
  | 'credit-target'
  | 'cash-balance'
  | 'market-exposure'
  | 'total-exposure'

/**
 * Resolves the complete premium applied to the reference rate for one bootstrap offer.
 * @param config - Bootstrap configuration whose static and optional maturity premiums apply.
 * @param secondsToMaturity - Fresh seconds until market maturity from the current observation.
 * @returns The static premium plus the resolved maturity premium in integer basis points.
 * @throws BootstrapConfigurationError when a maturity premium is configured without a fresh
 * maturity observation, so a wiring gap fails loud instead of silently dropping the premium.
 * @remarks Pure derivation with no provider access; the static premium stays zero or negative
 * while the maturity term is non-negative, so only further maturities raise the requested rate.
 */
export const effectiveBootstrapPremiumBps = (
  config: BootstrapConfig,
  secondsToMaturity?: bigint
): bigint => {
  if (config.maturityPremium === undefined) return config.premiumBps
  if (secondsToMaturity === undefined) {
    throw new BootstrapConfigurationError('maturityPremium', 'requires a maturity observation')
  }
  return config.premiumBps + resolveMaturityPremiumBps(config.maturityPremium, secondsToMaturity)
}

/**
 * Guardrail observations from one bootstrap derivation.
 * @remarks `cap` names the binding limit even when nothing was reduced, so a projection must
 * compare `requestedAssets` against `cappedAssets` before reporting an exposure cap. `cappedAssets`
 * is floored at zero when an already-exceeded bound makes the binding candidate negative.
 */
export type BootstrapDecisionDiagnostics = {
  requestedRateBps: bigint
  clampedRateBps: bigint
  clampedBound?: 'minimum' | 'maximum'
  requestedAssets: bigint
  cappedAssets: bigint
  cap: BootstrapSizeCap
}

const SIZE_CAPS: readonly BootstrapSizeCap[] = [
  'offer-size',
  'credit-target',
  'cash-balance',
  'market-exposure',
  'total-exposure'
]

/**
 * Computes one bootstrap action alongside the guardrail observations that shaped it.
 * @returns The decision, plus rate-clamp and size-cap diagnostics for a rate-derived decision.
 * @throws BootstrapConfigurationError when the static configuration itself is invalid or a
 * configured maturity premium is missing its maturity observation.
 * @remarks Diagnostics are absent for transition decisions, which never reach rate derivation.
 * Exists so silent rate saturation stays observable without a logger reaching into this pure module.
 */
export const decidePositionBootstrapWithDiagnostics = ({
  config,
  position,
  rate,
  activeOffer,
  requiresReconciliation = false,
  initialTargetCompleted
}: PositionBootstrapParameters): {
  decision: PositionBootstrapDecision
  diagnostics?: BootstrapDecisionDiagnostics
} => {
  const transition = decidePositionBootstrapTransition({
    config,
    position,
    activeOffer,
    initialTargetCompleted
  })
  if (transition) return { decision: transition }

  const unclampedRateBps =
    rate.rateBps + effectiveBootstrapPremiumBps(config, rate.secondsToMaturity)
  const requestedRateBps = clampRateBps(
    unclampedRateBps,
    config.minimumRateBps,
    config.maximumRateBps
  )

  const candidates = [
    config.offerSize,
    config.creditTarget - position.credit,
    position.cashBalance,
    config.maximumMarketExposure - position.marketExposure,
    config.maximumTotalExposure - position.totalExposure
  ]
  const assets = candidates.reduce(bigintMin)
  const diagnostics: BootstrapDecisionDiagnostics = {
    requestedRateBps: unclampedRateBps,
    clampedRateBps: requestedRateBps,
    ...(unclampedRateBps < config.minimumRateBps
      ? { clampedBound: 'minimum' as const }
      : unclampedRateBps > config.maximumRateBps
        ? { clampedBound: 'maximum' as const }
        : {}),
    requestedAssets: config.offerSize,
    cappedAssets: assets > 0n ? assets : 0n,
    cap: SIZE_CAPS[candidates.indexOf(assets)] ?? 'offer-size'
  }
  const decision = (): PositionBootstrapDecision => {
    if (assets <= 0n) {
      if (activeOffer) {
        return { kind: 'invalidate', reason: 'no-capacity', completesInitialTarget: false }
      }
      return { kind: 'observe', reason: 'no-capacity', assets: 0n }
    }

    const offer: BootstrapOffer = {
      marketId: config.marketId,
      assets,
      rateBps: requestedRateBps,
      referenceObservationId: rate.observationId
    }

    const observationMatches = activeOffer?.referenceObservationId === offer.referenceObservationId
    if (
      activeOffer &&
      !requiresReconciliation &&
      observationMatches &&
      sameOffer(activeOffer, offer)
    ) {
      return { kind: 'rest', offer: activeOffer }
    }
    if (activeOffer) return { kind: 'replace', activeOffer, offer }

    return { kind: 'publish', offer }
  }

  return { decision: decision(), diagnostics }
}

/**
 * Computes the deterministic bootstrap action from current chain and Mempool truth.
 * @param parameters - Validated configuration, fresh position, reference rate, active offer,
 * reconciliation requirement, and initial-target completion state.
 * @returns The exact observe, invalidate, rest, replace, or publish action for this snapshot.
 * @throws BootstrapConfigurationError when the static configuration itself is invalid.
 * @remarks A premium-adjusted rate outside the hard range saturates at the nearest bound instead of
 * failing, so a reference-rate excursion can never halt the strategy. Use
 * {@link decidePositionBootstrapWithDiagnostics} when that saturation must be observable.
 */
export const decidePositionBootstrap = (
  parameters: PositionBootstrapParameters
): PositionBootstrapDecision => decidePositionBootstrapWithDiagnostics(parameters).decision
