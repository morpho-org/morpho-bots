import type { Address, Hex } from 'viem'

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
