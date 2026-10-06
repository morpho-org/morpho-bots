import type { Hex } from 'viem'

import type { BootstrapActiveGroup } from './bootstrap-position.service'

import { BootstrapAdapterError } from './bootstrap-adapter.error'

/**
 * Resolves the strategy group IDs that may be reconciled for one market.
 * @param groups - Fresh active strategy-group projections.
 * @param marketId - Canonical market selected for reconciliation.
 * @returns Distinct active group IDs owned only by the selected market.
 * @throws `BootstrapAdapterError` when a selected group also contains another market.
 */
export const bootstrapMarketGroupIds = (groups: readonly BootstrapActiveGroup[], marketId: Hex) => {
  const groupIds = new Set(
    groups.filter(group => group.marketId === marketId).map(group => group.id)
  )
  if (groups.some(group => group.marketId !== marketId && groupIds.has(group.id))) {
    throw new BootstrapAdapterError('shared-group-reconciliation')
  }
  return groupIds
}
