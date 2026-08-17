import type { InputAllocation } from '@morpho-org/blue-sdk-viem'

import type { VaultData } from '../vault-data'

/** One market's target allocation in a `reallocate` call (blue-sdk-viem's input shape). */
export type MarketAllocation = InputAllocation

/**
 * Finds the reallocation for one vault: target absolute allocations, withdrawals first, the last
 * deposit leg `maxUint256`. Returns undefined when no move clears the strategy's thresholds.
 */
export type Strategy = (vaultData: VaultData) => MarketAllocation[] | undefined
