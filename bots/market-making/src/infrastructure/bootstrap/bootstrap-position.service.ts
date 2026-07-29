import type { Address, Hex } from 'viem'

import type { BootstrapPositionService } from '../../application/position-bootstrap.service'
import type { BootstrapOffer } from '../../domain/position-bootstrap'

import { BootstrapAdapterError } from './bootstrap-adapter.error'

/** Accrued position snapshot returned by the production Midnight reader. */
export type MidnightPositionSnapshot = { marketId: Hex; credit: bigint; debt: bigint }

/** Active lend group projection required by bootstrap reconciliation. */
export type BootstrapActiveGroup = {
  id: Hex
  marketId: Hex
  assets: bigint
  rateBps: bigint
}

/** Read boundary used by the position adapter to combine chain and Mempool truth. */
export interface BootstrapInventoryReader {
  /** Reads all configured accrued Midnight positions. @returns Current accrued position snapshots. */
  readPositions(): Promise<readonly MidnightPositionSnapshot[]>
  /** Reads the maker's current loan-token wallet balance. @returns Current raw token balance. */
  readCashBalance(): Promise<bigint>
  /** Reads active strategy-owned bootstrap groups. @returns Current active group projections. */
  readActiveGroups(): Promise<readonly BootstrapActiveGroup[]>
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
    const [positions, cashBalance, groups] = await Promise.all([
      this.reader.readPositions(),
      this.reader.readCashBalance(),
      this.reader.readActiveGroups()
    ])
    const position = positions.find(item => item.marketId === marketId)
    if (!position) throw new BootstrapAdapterError('position-unavailable')
    const marketGroups = groups.filter(group => group.marketId === marketId)
    const activeGroup = marketGroups[0]
    const replacementGroups = activeGroup
      ? groups.filter(group => group.id !== activeGroup.id)
      : groups
    const reservedByMarket = replacementGroups
      .filter(group => group.marketId === marketId)
      .reduce((total, group) => total + group.assets, 0n)
    const totalExposure =
      positions.reduce((total, item) => total + item.credit, 0n) +
      replacementGroups.reduce((total, group) => total + group.assets, 0n)
    const activeOffer: BootstrapOffer | undefined = activeGroup
      ? {
          marketId,
          assets: activeGroup.assets,
          rateBps: activeGroup.rateBps,
          referenceObservationId: `group:${activeGroup.id}`
        }
      : undefined

    return {
      credit: position.credit,
      debt: position.debt,
      cashBalance,
      marketExposure: position.credit + reservedByMarket,
      totalExposure,
      ...(activeOffer ? { activeOffer } : {}),
      requiresReconciliation: marketGroups.length > 1
    }
  }
}
