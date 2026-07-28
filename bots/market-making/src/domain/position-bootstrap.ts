import type { Hex } from 'viem'

import { BootstrapConfigurationError } from './bootstrap-configuration.error'

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

export type BootstrapPosition = {
  credit: bigint
  cashBalance: bigint
  marketExposure: bigint
  totalExposure: bigint
}

export type BootstrapRate = {
  mode: 'static' | 'variable'
  rateBps: bigint
  observationId: string
}

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
  initialTargetCompleted: boolean
}

type PositionBootstrapTransitionParameters = Pick<
  PositionBootstrapParameters,
  'config' | 'position' | 'activeOffer' | 'initialTargetCompleted'
>

export type PositionBootstrapTransitionDecision =
  | { kind: 'invalidate'; reason: 'target-reached'; completesInitialTarget: true }
  | { kind: 'target-reached'; completesInitialTarget: true; credit: bigint; acceptedCredit: bigint }
  | { kind: 'invalidate'; reason: 'auto-refill-disabled'; completesInitialTarget: false }
  | { kind: 'observe'; reason: 'auto-refill-disabled'; credit: bigint; acceptedCredit: bigint }

export type PositionBootstrapDecision =
  | PositionBootstrapTransitionDecision
  | { kind: 'invalidate'; reason: 'no-capacity'; completesInitialTarget: false }
  | { kind: 'observe'; reason: 'no-capacity'; assets: 0n }
  | { kind: 'rest'; offer: BootstrapOffer }
  | { kind: 'replace'; activeOffer: BootstrapOffer; offer: BootstrapOffer }
  | { kind: 'publish'; offer: BootstrapOffer }

const minimum = (values: readonly bigint[]) =>
  values.reduce((smallest, value) => (value < smallest ? value : smallest))

const sameOffer = (left: BootstrapOffer, right: BootstrapOffer, mode: BootstrapRate['mode']) =>
  left.marketId === right.marketId &&
  left.assets === right.assets &&
  left.rateBps === right.rateBps &&
  (mode === 'static' || left.referenceObservationId === right.referenceObservationId)

/**
 * Validates the static bounds required by a market bootstrap strategy.
 * @param config - Bootstrap configuration to validate without reading dynamic position data.
 * @returns Nothing when every structural invariant is valid.
 * @throws BootstrapConfigurationError when a configured amount, rate, or exposure bound is unsafe.
 * @remarks This pure validation has no publication, persistence, or provider side effects.
 */
export const validateBootstrapConfig = (config: BootstrapConfig): void => {
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

/** Decides completion and one-shot transitions that do not require a reference-rate read. */
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

/** Computes the deterministic bootstrap action from current chain and Mempool truth. */
export const decidePositionBootstrap = ({
  config,
  position,
  rate,
  activeOffer,
  initialTargetCompleted
}: PositionBootstrapParameters): PositionBootstrapDecision => {
  const transition = decidePositionBootstrapTransition({
    config,
    position,
    activeOffer,
    initialTargetCompleted
  })
  if (transition) return transition

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

  const requestedRateBps = rate.rateBps + config.premiumBps
  if (requestedRateBps < config.minimumRateBps) {
    throw new BootstrapConfigurationError('requestedRateBps', 'must be at least minimumRateBps')
  }
  if (requestedRateBps > config.maximumRateBps) {
    throw new BootstrapConfigurationError('requestedRateBps', 'must be at most maximumRateBps')
  }

  const offer: BootstrapOffer = {
    marketId: config.marketId,
    assets,
    rateBps: requestedRateBps,
    referenceObservationId: rate.observationId
  }

  if (activeOffer && sameOffer(activeOffer, offer, rate.mode)) {
    return { kind: 'rest' as const, offer: activeOffer }
  }
  if (activeOffer) return { kind: 'replace' as const, activeOffer, offer }

  return { kind: 'publish' as const, offer }
}
