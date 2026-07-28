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

const minimum = (values: readonly bigint[]) =>
  values.reduce((smallest, value) => (value < smallest ? value : smallest))

const sameOffer = (left: BootstrapOffer, right: BootstrapOffer) =>
  left.marketId === right.marketId &&
  left.assets === right.assets &&
  left.rateBps === right.rateBps &&
  left.referenceObservationId === right.referenceObservationId

/** Computes the deterministic bootstrap action from current chain and Mempool truth. */
export const decidePositionBootstrap = ({
  config,
  position,
  rate,
  activeOffer,
  initialTargetCompleted
}: PositionBootstrapParameters) => {
  if (config.premiumBps > 0n) {
    throw new BootstrapConfigurationError('premiumBps', 'must be zero or negative')
  }

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
  if (requestedRateBps < 0n) {
    throw new BootstrapConfigurationError('requestedRateBps', 'must not be negative')
  }

  const offer: BootstrapOffer = {
    marketId: config.marketId,
    assets,
    rateBps: requestedRateBps,
    referenceObservationId: rate.observationId
  }

  if (activeOffer && sameOffer(activeOffer, offer)) {
    return { kind: 'rest' as const, offer: activeOffer }
  }
  if (activeOffer) return { kind: 'replace' as const, activeOffer, offer }

  return { kind: 'publish' as const, offer }
}
