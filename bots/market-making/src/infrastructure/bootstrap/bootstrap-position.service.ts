import type { Address, Hex } from 'viem'

import type { BootstrapPositionService } from '../../application/bootstrap/position-bootstrap.service'
import type { BootstrapOffer } from '../../domain/bootstrap/position-bootstrap'

import { BootstrapAdapterError } from './bootstrap-adapter.error'

/** Accrued position snapshot returned by the production Midnight reader. */
export type MidnightPositionSnapshot = { marketId: Hex; credit: bigint; debt: bigint }

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

/** Read boundary used by the position adapter to combine chain and Mempool truth. */
export interface BootstrapInventoryReader {
  /** Reads all configured accrued Midnight positions. @returns Current accrued position snapshots. */
  readPositions(): Promise<readonly MidnightPositionSnapshot[]>
  /** Reads the maker's current loan-token wallet balance. @returns Current raw token balance. */
  readCashBalance(): Promise<bigint>
  /** Reads the current protocol fee that a new offer must accept. @param marketId - Market whose live fee policy is required. @returns Current continuous fee as an unsigned protocol value. */
  readMarketContinuousFeeCap(marketId: Hex): Promise<bigint>
  /** Reads bootstrap offers and independently owned buy-side reservations in one snapshot. @returns Current grouped inventory without treating reservations as replaceable bootstrap offers. */
  readGroupInventory(): Promise<BootstrapGroupInventory>
  /** Converts one raw buy reservation into conservative credit units at its exact offer terms. @param group - Resting or prospective buy reservation. @returns Maximum credit units created by consuming its remaining assets. */
  readReservationCredit(group: BootstrapActiveGroup): Promise<bigint>
}

/** Concrete position adapter deriving exposure from accrued credit and active lend reserves. */
export class MidnightBootstrapPositionService implements BootstrapPositionService {
  /** Creates a position adapter. @param reader - Chain/API inventory reader. @param maker - Bound maker account. */
  constructor(
    private readonly reader: BootstrapInventoryReader,
    private readonly maker: Address
  ) {}

  /**
   * Reads one market position and aggregate strategy exposure.
   * @param marketId - Configured Midnight market identifier.
   * @returns Fresh credit, debt, wallet capacity, exposure, representative active offer, and whether
   *   duplicate groups require reconciliation.
   * @throws When chain/API inventory reads fail or the market is absent.
   * @remarks The maker address is retained only to bind this adapter instance to one operator.
   */
  async readPosition(marketId: Hex) {
    void this.maker
    const [positions, cashBalance, marketContinuousFeeCap, groupInventory] = await Promise.all([
      this.reader.readPositions(),
      this.reader.readCashBalance(),
      this.reader.readMarketContinuousFeeCap(marketId),
      this.reader.readGroupInventory()
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
    const reservedByMarket = (
      await Promise.all(
        marketReplacementGroups.map(group => this.reader.readReservationCredit(group))
      )
    ).reduce((total, credit) => total + credit, 0n)
    const totalExposure =
      positions.reduce((total, item) => total + item.credit, 0n) +
      (
        await Promise.all(replacementGroups.map(group => this.reader.readReservationCredit(group)))
      ).reduce((total, credit) => total + credit, 0n)
    const activeOffer: BootstrapOffer | undefined = activeGroup
      ? {
          marketId,
          assets: activeGroup.assets,
          rateBps: activeGroup.rateBps,
          referenceObservationId: activeGroup.referenceObservationId ?? `group:${activeGroup.id}`
        }
      : undefined

    return {
      credit: position.credit,
      debt: position.debt,
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
