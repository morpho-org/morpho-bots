import type { InputMarketParams } from '@morpho-org/blue-sdk'

import type { VaultV2Data } from '../vault-data'

/** One delta leg: assets to allocate to (or deallocate from) the market with these params. */
export type ReallocationAction = {
  marketParams: InputMarketParams
  assets: bigint
}

/** A vault's planned move: exact-amount deltas, executed deallocations-first in one multicall. */
export type Reallocation = {
  allocations: ReallocationAction[]
  deallocations: ReallocationAction[]
}

/**
 * Finds the reallocation for one vault, or undefined when no move clears the strategy's
 * thresholds. Unlike V1's absolute targets, V2 legs are deltas and need not balance: surplus
 * deallocation parks in the vault's idle balance, surplus allocation draws from it.
 */
export type Strategy = (vaultData: VaultV2Data) => Reallocation | undefined
