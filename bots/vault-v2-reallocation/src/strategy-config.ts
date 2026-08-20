import type { Address, Hex } from 'viem'

import { InvalidConfigError } from './invalid-config.error'

type ApyRangePercent = { min: number; max: number }

/** Global default borrow-APY range (percent) when no vault or market override matches. */
export const DEFAULT_APY_RANGE: ApyRangePercent = { min: 3, max: 8 }

// Curator policy tables, reviewed via PR. Keyed by chainId, then by CHECKSUMMED vault address
// (viem `getAddress` form) or lowercase market id — lookups are exact string matches.
// Template — add entries like:
//   export const vaultApyRanges: Record<number, Record<Address, ApyRangePercent>> = {
//     [mainnet.id]: { [getAddress('0xBEEF01735c132Ada46AA9aA4c54623cAA92A64CB')]: { min: 4, max: 6 } }
//   }

export const vaultApyRanges: Record<number, Record<Address, ApyRangePercent>> = {}

export const marketApyRanges: Record<number, Record<Hex, ApyRangePercent>> = {}

export const vaultMinApyDeltaBips: Record<number, Record<Address, number>> = {}

export const marketMinApyDeltaBips: Record<number, Record<Hex, number>> = {}

export const vaultMinUtilizationDeltaBips: Record<number, Record<Address, number>> = {}

/**
 * Rejects an inverted or empty APY range: the classifier picks `upperBound` first, so a market
 * sitting between an inverted pair would flip to allocate every pass. Runs at module load over the
 * checked-in tables, so a bad entry fails the bot at startup instead of silently thrashing.
 */
export const assertApyRangeValid = (range: ApyRangePercent, label: string): void => {
  if (!(range.min < range.max)) {
    throw new InvalidConfigError(
      `APY range for ${label} must satisfy min < max, got min=${range.min} max=${range.max}`
    )
  }
}

assertApyRangeValid(DEFAULT_APY_RANGE, 'DEFAULT_APY_RANGE')
for (const [table, name] of [
  [vaultApyRanges, 'vaultApyRanges'],
  [marketApyRanges, 'marketApyRanges']
] as const) {
  for (const [chainId, entries] of Object.entries(table)) {
    for (const [key, range] of Object.entries(entries)) {
      assertApyRangeValid(range, `${name}[${chainId}][${key}]`)
    }
  }
}

/** Borrow-APY range for (vault, market); precedence: market override > vault override > default. */
export const resolveApyRange = (chainId: number, vault: Address, marketId: Hex): ApyRangePercent =>
  marketApyRanges[chainId]?.[marketId] ?? vaultApyRanges[chainId]?.[vault] ?? DEFAULT_APY_RANGE

/** ApyRange firing threshold (bips); precedence: market override > vault override > `fallback`. */
export const resolveMinApyDeltaBips = (
  chainId: number,
  vault: Address,
  marketId: Hex,
  fallback: number
): number =>
  marketMinApyDeltaBips[chainId]?.[marketId] ?? vaultMinApyDeltaBips[chainId]?.[vault] ?? fallback

/** EqualizeUtilizations firing threshold (bips); precedence: vault override > `fallback`. */
export const resolveMinUtilizationDeltaBips = (
  chainId: number,
  vault: Address,
  fallback: number
): number => vaultMinUtilizationDeltaBips[chainId]?.[vault] ?? fallback
