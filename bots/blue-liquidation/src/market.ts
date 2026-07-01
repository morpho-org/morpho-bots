import type { Address, Hex } from 'viem'

import { encodeAbiParameters, keccak256 } from 'viem'

/**
 * A Morpho Blue market's immutable definition. Field ORDER is load-bearing: the market id is
 * `keccak256(abi.encode(marketParams))`, so any reorder changes the id. Not stored on the singleton
 * (only the mutable `Market` accounting is) — recovered from the `CreateMarket` event by discovery
 * and re-derived on-chain by the lens as an id-commitment check before any state is read.
 */
export type MarketParams = {
  loanToken: Address
  collateralToken: Address
  oracle: Address
  irm: Address
  lltv: bigint
}

// The abi.encode layout of MarketParams: five static 32-byte words (3 addresses, 2 uint256), so
// `keccak256(abi.encode(params))` is byte-identical to Blue's `keccak256(marketParams, 5*32)`.
const MARKET_PARAMS_COMPONENTS = [
  { name: 'loanToken', type: 'address' },
  { name: 'collateralToken', type: 'address' },
  { name: 'oracle', type: 'address' },
  { name: 'irm', type: 'address' },
  { name: 'lltv', type: 'uint256' }
] as const

/**
 * The market id: `keccak256(abi.encode(marketParams))`. This is a cryptographic commitment to the
 * immutable params. The bot uses it only to build stable per-pair map keys and to dedupe candidates;
 * the lens re-derives the same id on-chain from the supplied params and reads state at it, so a
 * forged/mismatched param set is rejected there — off-chain we never trust it for a decision.
 */
export function marketId(params: MarketParams): Hex {
  return keccak256(
    encodeAbiParameters([{ type: 'tuple', components: MARKET_PARAMS_COMPONENTS }], [params])
  )
}
