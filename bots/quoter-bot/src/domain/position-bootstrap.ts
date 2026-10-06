import type { Hex } from 'viem'

import type { LendHalt, LossFactorObservation } from './loss-factor'
import type { MaturityPremiumConfig } from './maturity-premium'

import { BootstrapConfigurationError } from './bootstrap-configuration.error'
import { isBytes32 } from './bytes32'
import { frozenCopy } from './frozen-copy'
import { lendHalt } from './loss-factor'
import { maturityPremiumConfigIssue, resolveMaturityPremiumBps } from './maturity-premium'
import { violatedRateBound } from './rate-range'

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

declare const validBootstrapConfig: unique symbol
/** A {@link BootstrapConfig} that passed {@link validateBootstrapConfig}, its only producer. */
export type ValidBootstrapConfig = Readonly<BootstrapConfig> & {
  readonly [validBootstrapConfig]: true
}

/**
 * Fresh balance, credit, and exposure inputs used to cap a bootstrap offer.
 * @remarks `maturityTimestamp` and `observedTimestamp` come from the same read, so a workflow can
 * recognize a market whose lifecycle has ended without consulting a wall clock. Sizing ignores both.
 * `rateWindowEmpty` means no aligned tick encodes a rate inside the hard range at
 * `observedTimestamp`, so no offer is publishable even when the requested rate is in range.
 */
export type BootstrapPosition = {
  credit: bigint
  cashBalance: bigint
  marketExposure: bigint
  totalExposure: bigint
  maturityTimestamp?: bigint
  observedTimestamp?: bigint
  rateWindowEmpty?: boolean
}

/** Reference-rate observation and replacement semantics used for offer derivation. */
export type BootstrapRate = {
  mode: 'static' | 'variable'
  rateBps: bigint
  observationId: string
  /** Fresh seconds until market maturity, required by maturity-premium configurations. */
  secondsToMaturity?: bigint
}

/**
 * Fully derived market offer suitable for application-port reconciliation.
 * @remarks `assets` is face credit: the offer's `maxUnits` cap, like every bootstrap size limit.
 */
export type BootstrapOffer = {
  marketId: Hex
  assets: bigint
  rateBps: bigint
  referenceObservationId: string
}

type PositionBootstrapParameters = {
  config: ValidBootstrapConfig
  position: BootstrapPosition
  lossFactor: LossFactorObservation
  rate: BootstrapRate
  activeOffer?: BootstrapOffer
  requiresReconciliation?: boolean
  initialTargetCompleted: boolean
}

type PositionBootstrapTransitionParameters = Pick<
  PositionBootstrapParameters,
  'config' | 'position' | 'lossFactor' | 'activeOffer' | 'initialTargetCompleted'
>

/** Bootstrap decisions that need no reference-rate read. */
export type PositionBootstrapTransitionDecision =
  | {
      kind: 'invalidate'
      reason: 'loss-factor-mismatch'
      completesInitialTarget: false
      halt: LendHalt
    }
  | { kind: 'observe'; reason: 'loss-factor-mismatch'; halt: LendHalt }
  | { kind: 'invalidate'; reason: 'target-reached'; completesInitialTarget: true }
  | { kind: 'target-reached'; completesInitialTarget: true; credit: bigint; acceptedCredit: bigint }
  | { kind: 'invalidate'; reason: 'auto-refill-disabled'; completesInitialTarget: false }
  | { kind: 'observe'; reason: 'auto-refill-disabled'; credit: bigint; acceptedCredit: bigint }

/** Complete deterministic action returned for one fresh bootstrap market snapshot. */
export type PositionBootstrapDecision =
  | PositionBootstrapTransitionDecision
  | { kind: 'invalidate'; reason: 'no-capacity'; completesInitialTarget: false }
  | { kind: 'observe'; reason: 'no-capacity'; assets: 0n }
  | { kind: 'invalidate'; reason: 'rate-out-of-range'; completesInitialTarget: false }
  | { kind: 'observe'; reason: 'rate-out-of-range' }
  | { kind: 'rest'; offer: BootstrapOffer }
  | { kind: 'replace'; activeOffer: BootstrapOffer; offer: BootstrapOffer }
  | { kind: 'publish'; offer: BootstrapOffer }

const sameOffer = (left: BootstrapOffer, right: BootstrapOffer) =>
  left.marketId === right.marketId && left.assets === right.assets && left.rateBps === right.rateBps

/**
 * Validates the static bounds required by a market bootstrap strategy.
 * @param input - Bootstrap configuration to validate without reading dynamic position data.
 * @returns A deeply frozen copy of `input`, typed as {@link ValidBootstrapConfig}, when every
 * structural invariant is valid; later writes through `input` cannot reach it.
 * @throws BootstrapConfigurationError when a configured amount, rate, or exposure bound is unsafe.
 * @remarks This pure validation has no publication, persistence, or provider side effects.
 */
export const validateBootstrapConfig = <Config extends BootstrapConfig>(input: Config) => {
  const config = frozenCopy(input)
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
  return config as Config & ValidBootstrapConfig
}

/**
 * Decides completion and one-shot transitions that do not require a reference-rate read.
 * @returns A transition decision, or `undefined` when reference-rate derivation is still required.
 * @remarks A loss factor that differs from the accepted value wins over every other transition: the
 * active buy is invalidated, and the initial target is never marked complete.
 */
export const decidePositionBootstrapTransition = ({
  config,
  position,
  lossFactor,
  activeOffer,
  initialTargetCompleted
}: PositionBootstrapTransitionParameters): PositionBootstrapTransitionDecision | undefined => {
  const halt = lendHalt(lossFactor)
  if (halt) {
    return activeOffer
      ? { kind: 'invalidate', reason: 'loss-factor-mismatch', completesInitialTarget: false, halt }
      : { kind: 'observe', reason: 'loss-factor-mismatch', halt }
  }

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
  /** Bound `requestedRateBps` falls outside of; present exactly when that rate is inadmissible. */
  outOfRangeBound?: 'minimum' | 'maximum'
  /** Set when the position's {@link BootstrapPosition.rateWindowEmpty} withdrew the offer. */
  rateWindowEmpty?: true
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
 * Bounds one bootstrap offer's size by every configured limit against one position.
 * @param config - Offer size, credit target, and exposure limits.
 * @param position - Credit, spendable cash, and exposure the offer adds to.
 * @returns The largest admissible size, negative when a bound is already exceeded, and the limit
 * that binds it.
 */
export const bootstrapSizeCapacity = (
  config: Pick<
    BootstrapConfig,
    'offerSize' | 'creditTarget' | 'maximumMarketExposure' | 'maximumTotalExposure'
  >,
  position: BootstrapPosition
): { assets: bigint; cap: BootstrapSizeCap } => {
  const candidates = [
    config.offerSize,
    config.creditTarget - position.credit,
    position.cashBalance,
    config.maximumMarketExposure - position.marketExposure,
    config.maximumTotalExposure - position.totalExposure
  ]
  const assets = candidates.reduce(bigintMin)
  return { assets, cap: SIZE_CAPS[candidates.indexOf(assets)] ?? 'offer-size' }
}

/**
 * Computes one bootstrap action alongside the guardrail observations that shaped it.
 * @returns The decision, plus rate-range and size-cap diagnostics for a rate-derived decision.
 * @throws BootstrapConfigurationError when a configured maturity premium is missing its maturity
 * observation.
 * @remarks Diagnostics are absent for transition decisions, which never reach rate derivation.
 * Exists so an out-of-range rate stays observable without a logger reaching into this pure module.
 */
export const decidePositionBootstrapWithDiagnostics = ({
  config,
  position,
  lossFactor,
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
    lossFactor,
    activeOffer,
    initialTargetCompleted
  })
  if (transition) return { decision: transition }

  const requestedRateBps =
    rate.rateBps + effectiveBootstrapPremiumBps(config, rate.secondsToMaturity)
  const outOfRangeBound = violatedRateBound(requestedRateBps, config)

  const { assets, cap } = bootstrapSizeCapacity(config, position)
  const diagnostics: BootstrapDecisionDiagnostics = {
    requestedRateBps,
    ...(outOfRangeBound === undefined ? {} : { outOfRangeBound }),
    ...(position.rateWindowEmpty === true ? { rateWindowEmpty: true } : {}),
    requestedAssets: config.offerSize,
    cappedAssets: assets > 0n ? assets : 0n,
    cap
  }
  const decision = (): PositionBootstrapDecision => {
    if (outOfRangeBound !== undefined || position.rateWindowEmpty === true) {
      if (activeOffer) {
        return { kind: 'invalidate', reason: 'rate-out-of-range', completesInitialTarget: false }
      }
      return { kind: 'observe', reason: 'rate-out-of-range' }
    }
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
 * @param parameters - Validated configuration, fresh position and loss factor, reference rate,
 * active offer, reconciliation requirement, and initial-target completion state.
 * @returns The exact observe, invalidate, rest, replace, or publish action for this snapshot.
 * @throws BootstrapConfigurationError when a configured maturity premium is missing its maturity
 * observation.
 * @remarks The hard range is an admissibility envelope: a premium-adjusted rate failing
 * {@link violatedRateBound}, or a range that holds no aligned tick at the snapshot, publishes
 * nothing and invalidates any active offer, never a clamped one, and neither halts the strategy. Use
 * {@link decidePositionBootstrapWithDiagnostics} when that must be observable.
 */
export const decidePositionBootstrap = (
  parameters: PositionBootstrapParameters
): PositionBootstrapDecision => decidePositionBootstrapWithDiagnostics(parameters).decision
