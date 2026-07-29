import type { Hex } from 'viem'

import { isHex, size } from 'viem'

import { BootstrapConfigurationError } from './bootstrap-configuration.error'

/** Static safety bounds and behavior for bootstrapping one canonical market. */
export type BootstrapConfig = {
  marketId: Hex
  creditTarget: bigint
  acceptanceAssets: bigint
  offerSize: bigint
  premiumBps: bigint
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

const minimum = (values: readonly bigint[]) =>
  values.reduce((smallest, value) => (value < smallest ? value : smallest))

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
  if (!isHex(config.marketId, { strict: true }) || size(config.marketId) !== 32) {
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
        kind: 'invalidate' as const,
        reason: 'target-reached' as const,
        completesInitialTarget: true
      }
    }

    return {
      kind: 'target-reached' as const,
      completesInitialTarget: true,
      credit: position.credit,
      acceptedCredit
    }
  }

  if (initialTargetCompleted && !config.autoRefill) {
    if (activeOffer) {
      return {
        kind: 'invalidate' as const,
        reason: 'auto-refill-disabled' as const,
        completesInitialTarget: false
      }
    }
    return {
      kind: 'observe' as const,
      reason: 'auto-refill-disabled' as const,
      credit: position.credit,
      acceptedCredit
    }
  }

  return undefined
}

/**
 * Computes the deterministic bootstrap action from current chain and Mempool truth.
 * @returns The exact observe, invalidate, rest, replace, or publish action for this snapshot.
 * @throws BootstrapConfigurationError when the final premium-adjusted rate is outside hard bounds.
 */
export const decidePositionBootstrap = ({
  config,
  position,
  rate,
  activeOffer,
  requiresReconciliation = false,
  initialTargetCompleted
}: PositionBootstrapParameters): PositionBootstrapDecision => {
  const transition = decidePositionBootstrapTransition({
    config,
    position,
    activeOffer,
    initialTargetCompleted
  })
  if (transition) return transition

  const requestedRateBps = rate.rateBps + config.premiumBps
  if (requestedRateBps < config.minimumRateBps) {
    throw new BootstrapConfigurationError('requestedRateBps', 'must be at least minimumRateBps')
  }
  if (requestedRateBps > config.maximumRateBps) {
    throw new BootstrapConfigurationError('requestedRateBps', 'must be at most maximumRateBps')
  }

  const assets = minimum([
    config.offerSize,
    config.creditTarget - position.credit,
    position.cashBalance,
    config.maximumMarketExposure - position.marketExposure,
    config.maximumTotalExposure - position.totalExposure
  ])

  if (assets <= 0n) {
    if (activeOffer) {
      return {
        kind: 'invalidate' as const,
        reason: 'no-capacity' as const,
        completesInitialTarget: false
      }
    }
    return { kind: 'observe' as const, reason: 'no-capacity' as const, assets: 0n }
  }

  const offer: BootstrapOffer = {
    marketId: config.marketId,
    assets,
    rateBps: requestedRateBps,
    referenceObservationId: rate.observationId
  }

  const observationMatches =
    rate.mode === 'static' || activeOffer?.referenceObservationId === offer.referenceObservationId
  if (
    activeOffer &&
    !requiresReconciliation &&
    observationMatches &&
    sameOffer(activeOffer, offer)
  ) {
    return { kind: 'rest' as const, offer: activeOffer }
  }
  if (activeOffer) return { kind: 'replace' as const, activeOffer, offer }

  return { kind: 'publish' as const, offer }
}
