import type { Address, Hex } from 'viem'

import type { BootstrapPositionService } from '../../application/bootstrap/position-bootstrap.service'
import type { BootstrapOffer } from '../../domain/position-bootstrap'
import type { ExposurePosition } from '../exposure/exposure-snapshot.utils'

import { acceptedLossFactorOf } from '../../domain/loss-factor'
import { BootstrapAdapterError } from './bootstrap-adapter.error'

/**
 * Accrued position snapshot returned by the production Midnight reader.
 * @deprecated Use {@link ExposurePosition}.
 * @public
 */
export type MidnightPositionSnapshot = ExposurePosition

/** Active lend group projection required by bootstrap reconciliation. */
export type BootstrapActiveGroup = {
  id: Hex
  marketId: Hex
  assets: bigint
  rateBps: bigint
  /** Exact protocol tick when this projection represents a bootstrap offer. */
  tick?: bigint
  /** Original protocol group cap before cumulative consumption. */
  maximumAssets?: bigint
  /** Total number of offers sharing the protocol group. */
  offerCount?: number
  /** Maximum market continuous fee accepted by the resting protocol offer. */
  continuousFeeCap?: bigint
  referenceObservationId?: string
}

/** Active bootstrap offers plus other owned buy groups that reserve the same loan-token inventory. */
export type BootstrapGroupInventory = {
  activeGroups: readonly BootstrapActiveGroup[]
  cashReservations: readonly BootstrapActiveGroup[]
}

/** Accrued positions, spendable cash, and group inventory read together at one block. */
export type BootstrapInventory = {
  positions: readonly ExposurePosition[]
  cashBalance: bigint
  groupInventory: BootstrapGroupInventory
}

/** Read boundary used by the position adapter to combine chain and Mempool truth. */
export interface BootstrapInventoryReader {
  /**
   * Reads positions, spendable cash, and group inventory from one exposure snapshot.
   * @returns A coherent inventory whose every value is pinned to the same block.
   */
  readInventory(): Promise<BootstrapInventory>
  /** Reads the current protocol fee that a new offer must accept. @param marketId - Market whose live fee policy is required. @returns Current continuous fee as an unsigned protocol value. */
  readMarketContinuousFeeCap(marketId: Hex): Promise<bigint>
  /** Reads one market's immutable maturity beside the timestamp it is compared against. @param marketId - Market whose lifecycle state is required. @returns Market maturity and the observation timestamp, so callers recognize a matured market without a clock, plus whether the hard rate range holds no aligned tick at that timestamp. */
  readMarketMaturity(
    marketId: Hex
  ): Promise<{ maturityTimestamp: bigint; observedTimestamp: bigint; rateWindowEmpty?: boolean }>
}

/** Concrete position adapter deriving exposure from accrued credit and active lend reserves. */
export class MidnightBootstrapPositionService implements BootstrapPositionService {
  /**
   * Creates a position adapter.
   * @param reader - Chain/API inventory reader.
   * @param maker - Bound maker account.
   * @param acceptedLossFactor - Operator-accepted loss factor per market; omitted markets accept `0`.
   */
  constructor(
    private readonly reader: BootstrapInventoryReader,
    private readonly maker: Address,
    private readonly acceptedLossFactor: ReadonlyMap<Hex, bigint>
  ) {}

  /**
   * Reads one market position and aggregate strategy exposure.
   * @param marketId - Configured Midnight Market identifier.
   * @returns Fresh credit, debt, wallet capacity, exposure, the snapshot-block loss factor beside its
   *   accepted value, market maturity beside the timestamp it is observed against, whether the hard
   *   rate range holds no aligned tick at that timestamp, representative
   *   active offer, and whether duplicate groups require reconciliation.
   * @throws When chain/API inventory reads fail or the market is absent.
   * @remarks The maker address is retained only to bind this adapter instance to one operator.
   */
  async readPosition(marketId: Hex) {
    void this.maker
    const [{ positions, cashBalance, groupInventory }, marketContinuousFeeCap, maturity] =
      await Promise.all([
        this.reader.readInventory(),
        this.reader.readMarketContinuousFeeCap(marketId),
        this.reader.readMarketMaturity(marketId)
      ])
    const position = positions.find(item => item.marketId === marketId)
    if (!position) throw new BootstrapAdapterError('position-unavailable')
    const groups = groupInventory.activeGroups
    const uniqueGroups = [...new Map(groups.map(group => [group.id, group])).values()]
    const marketGroups = [
      ...new Map(
        groups.filter(group => group.marketId === marketId).map(group => [group.id, group])
      ).values()
    ]
    const activeGroup = marketGroups[0]
    const remainingBootstrapGroups = activeGroup
      ? uniqueGroups.filter(group => group.id !== activeGroup.id)
      : uniqueGroups
    const bootstrapGroupIds = new Set(uniqueGroups.map(group => group.id))
    const cashReservations = groupInventory.cashReservations.filter(
      group => !bootstrapGroupIds.has(group.id)
    )
    const uniqueCashReservations = [
      ...new Map(cashReservations.map(group => [group.id, group])).values()
    ]
    const replacementGroups = [...remainingBootstrapGroups, ...uniqueCashReservations]
    const marketReplacementGroups = [
      ...new Map(
        [...remainingBootstrapGroups, ...cashReservations]
          .filter(group => group.marketId === marketId)
          .map(group => [group.id, group])
      ).values()
    ]
    const reservedCash = replacementGroups.reduce((total, group) => total + group.assets, 0n)
    const availableCash = cashBalance > reservedCash ? cashBalance - reservedCash : 0n
    const reservedByMarket = marketReplacementGroups.reduce(
      (total, group) => total + group.assets,
      0n
    )
    const totalExposure =
      positions.reduce((total, item) => total + item.credit, 0n) +
      replacementGroups.reduce((total, group) => total + group.assets, 0n)
    const activeOffer: BootstrapOffer | undefined = activeGroup
      ? {
          marketId,
          assets: activeGroup.assets,
          rateBps: activeGroup.rateBps,
          referenceObservationId: activeGroup.referenceObservationId ?? `group:${activeGroup.id}`
        }
      : undefined

    return {
      ...maturity,
      credit: position.credit,
      debt: position.debt,
      lossFactor: {
        lossFactor: position.lossFactor,
        ...acceptedLossFactorOf(this.acceptedLossFactor, marketId)
      },
      cashBalance: availableCash,
      marketExposure: position.credit + reservedByMarket,
      totalExposure,
      ...(activeOffer ? { activeOffer } : {}),
      requiresReconciliation:
        marketGroups.length > 1 ||
        marketGroups.some(
          group =>
            (group.offerCount !== undefined && group.offerCount !== 1) ||
            group.continuousFeeCap !== marketContinuousFeeCap
        )
    }
  }
}
