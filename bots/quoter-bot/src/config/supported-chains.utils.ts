import type { Address, Hex } from 'viem'

import { getChainAddress, registerCustomAddresses } from '@morpho-org/morpho-ts'
import { base, mainnet } from 'viem/chains'

/** Ethereum mainnet chain ID served by the quoter-bot bot. */
export const MAINNET_CHAIN_ID = mainnet.id

/** Base mainnet chain ID served by the quoter-bot bot. */
export const BASE_CHAIN_ID = base.id

/**
 * Canonical Midnight deployment addresses on Ethereum mainnet.
 * @remarks The pinned `@morpho-org/morpho-ts` address registry (2.8.0, unchanged through 2.9.0)
 * carries Midnight entries for Base only, so mainnet lookups would throw without this shim. Each
 * address below was verified against mainnet: all four hold deployed bytecode, and both ratifiers
 * report `MIDNIGHT()` equal to the `midnight` singleton listed here, proving they belong to one
 * coherent deployment. Delete this constant and the registration below once the SDK ships mainnet
 * Midnight addresses upstream.
 */
const MAINNET_MIDNIGHT_ADDRESSES = {
  midnight: '0x471686c42792F93528B000beF54bC10E3aa2045f',
  midnightMempool: '0xde2d62449301a09A51EbF9326EA60d2e8BF4A8F7',
  ecrecoverRatifier: '0xAC439c81CAA6ef4C7B7E8F0110F8CE63A4b6D43e',
  setterRatifier: '0xb72c416382c8A6399D0765CebfB032F040B00B3c'
} as const satisfies Record<string, Address>

let midnightAddressesRegistered = false

/**
 * Registers the mainnet Midnight addresses missing from the pinned SDK registry exactly once.
 * @remarks `registerCustomAddresses` merges into the existing chain record rather than replacing
 * it, so Ethereum mainnet keeps its upstream Morpho Blue entries (verified: the chain-1 record
 * grows from 42 to 46 keys and `morpho` still resolves). Registration is idempotent and is driven
 * from {@link chainAddress} instead of module evaluation, so no call site depends on import order.
 */
const ensureMidnightAddressesRegistered = () => {
  if (midnightAddressesRegistered) return
  registerCustomAddresses({ addresses: { [MAINNET_CHAIN_ID]: MAINNET_MIDNIGHT_ADDRESSES } })
  midnightAddressesRegistered = true
}

/**
 * Exact keccak256 runtime-bytecode hashes of each canonical ratifier, keyed by chain and kind.
 * @remarks Ratifier bytecode embeds its immutable Midnight target, so every chain has distinct
 * hashes and a Base hash must never be accepted on mainnet. The Base values are the deployment
 * hashes previously pinned in `viem-setup-state.utils.ts`
 * (morpho-org/deployments@24c04410 address-book.json); the mainnet values were read from mainnet
 * runtime code with the Base hashes recomputed alongside as a control, reproducing the pinned
 * constants exactly. Update these together with {@link MAINNET_MIDNIGHT_ADDRESSES}.
 */
const RATIFIER_RUNTIME_HASHES = {
  [BASE_CHAIN_ID]: {
    ecrecover: '0xcce1e0dd38ae831e81a9270627af2c24c208409ec03d5654a28a33ead53b1ac1',
    setter: '0xace63c5b7c1b611d0b9c04df3993ce0cf24a172287c9e0755d18606b7465c235'
  },
  [MAINNET_CHAIN_ID]: {
    ecrecover: '0x857f6c0c206d6be9de3794b8a9c29261f40e8037c4fb7481047303609df880cc',
    setter: '0x31a04caac779f54e1eaeabc85855e866fb3aa818a4c923c3a38bb0b50e4b3920'
  }
} as const

/**
 * Reads the expected ratifier runtime hash for one chain and ratifier kind.
 * @param chainId - Supported EVM chain identifier.
 * @param type - Canonical ratifier kind selected for the configured ratifier address.
 * @returns The exact keccak256 runtime hash the deployed ratifier must produce.
 * @remarks Callers compare this against `keccak256` of fetched runtime code; a mismatch means the
 * configured ratifier is not the canonical deployment for that chain and must be rejected.
 */
export const ratifierRuntimeHash = (chainId: SupportedChainId, type: 'ecrecover' | 'setter'): Hex =>
  RATIFIER_RUNTIME_HASHES[chainId][type]

/** Viem chain definitions for every chain the quoter-bot bot supports, keyed by chain ID. */
const SUPPORTED_CHAINS = {
  [BASE_CHAIN_ID]: base,
  [MAINNET_CHAIN_ID]: mainnet
} as const

/** Chain ID of a network the quoter-bot bot supports. */
export type SupportedChainId = keyof typeof SUPPORTED_CHAINS

/** Every supported chain ID, ordered for stable operator-facing messages. */
export const SUPPORTED_CHAIN_IDS: readonly SupportedChainId[] = [MAINNET_CHAIN_ID, BASE_CHAIN_ID]

/**
 * Narrows an arbitrary chain ID to one the bot supports.
 * @param value - Candidate EVM chain identifier.
 * @returns `true` when the bot has a viem chain and Midnight addresses for the value.
 */
export const isSupportedChainId = (value: number): value is SupportedChainId =>
  Object.hasOwn(SUPPORTED_CHAINS, value)

/**
 * Resolves the viem chain definition backing a supported chain ID.
 * @param chainId - Supported EVM chain identifier.
 * @returns The viem `Chain` used to build public and wallet clients.
 * @remarks Also installs the mainnet Midnight shim. The Morpho SDK's `morpho.midnight(chainId)`
 * extension stores only `{ client, chainId }` and resolves addresses lazily on each method call,
 * so it would bypass {@link chainAddress} entirely. Registering here means every code path that
 * builds a client has the mainnet addresses in place before any such call can run.
 */
export const supportedChain = (chainId: SupportedChainId) => {
  ensureMidnightAddressesRegistered()
  return SUPPORTED_CHAINS[chainId]
}

/**
 * Resolves the chain ID used to label observability before configuration is validated.
 * @param environment - Process environment read for `CHAIN_ID`.
 * @returns The configured chain when it names a supported chain, otherwise {@link BASE_CHAIN_ID}.
 * @remarks Observability starts before `chainIdValue` runs, so this deliberately never throws: a
 * malformed or unsupported `CHAIN_ID` must surface as the precise `ConfigValidationError` raised
 * moments later by configuration parsing, not as an unlabelled crash during logger startup.
 */
export const observabilityChainId = (environment: Record<string, string | undefined>) => {
  const raw = environment.CHAIN_ID?.trim()
  if (raw === undefined || !/^\d+$/.test(raw)) return BASE_CHAIN_ID
  const parsed = Number(raw)
  return isSupportedChainId(parsed) ? parsed : BASE_CHAIN_ID
}

/**
 * Reads one canonical contract address for a supported chain.
 * @param chainId - Supported EVM chain identifier.
 * @param key - Address key defined by the Morpho SDK registry.
 * @returns The canonical address registered for the chain.
 * @throws When the SDK registry has no entry for the chain and key pair.
 * @remarks Wraps the SDK's `getChainAddress` so that the mainnet Midnight shim is always installed
 * first; prefer this helper over calling `getChainAddress` directly anywhere Midnight or ratifier
 * addresses are read.
 */
export const chainAddress = (
  chainId: SupportedChainId,
  key: Parameters<typeof getChainAddress>[1]
): Address => {
  ensureMidnightAddressesRegistered()
  return getChainAddress(chainId, key)
}
