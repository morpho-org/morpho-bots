import { isAddressEqual, zeroAddress } from 'viem'

import type { VaultMarketData } from './vault-data'

/**
 * A vault's idle market: the zero-collateral, zero-oracle, zero-IRM market MetaMorpho uses to park
 * unallocated assets. It never borrows, so no rate strategy applies to it — it only ever absorbs or
 * supplies a plan's imbalance.
 */
export const isIdleMarket = (marketData: VaultMarketData): boolean =>
  isAddressEqual(marketData.params.collateralToken, zeroAddress)
