import type { Hex } from 'viem'

/**
 * Reconstructs pending items only for the market currently being reconciled.
 * @param marketId - Market whose book is being validated.
 * @param items - Pending items that may span multiple markets.
 * @param reconstruct - Potentially fallible reconstruction for one selected item.
 * @returns Reconstructed values for the selected market in input order.
 * @throws Forwards reconstruction failures from selected-market items only.
 */
export const mapSelectedMarketItems = <Item extends { marketId: Hex }, Output>(
  marketId: Hex,
  items: readonly Item[],
  reconstruct: (item: Item) => Promise<Output>
): Promise<Output[]> =>
  Promise.all(items.filter(item => item.marketId === marketId).map(reconstruct))
