import type { Hex } from 'viem'

import { base, mainnet } from 'viem/chains'

/** Ethereum mainnet chain ID served by the quoter-bot bot. */
export const MAINNET_CHAIN_ID = mainnet.id

/** Base mainnet chain ID served by the quoter-bot bot. */
export const BASE_CHAIN_ID = base.id

/**
 * Exact keccak256 runtime-bytecode hashes of each canonical ratifier, keyed by chain and kind.
 * @remarks Ratifier bytecode embeds its immutable Midnight target, so every chain has distinct
 * hashes and a Base hash must never be accepted on mainnet. The Base values are the deployment
 * hashes previously pinned in `viem-setup-state.utils.ts`
 * (morpho-org/deployments@24c04410 address-book.json); the mainnet values were read from mainnet
 * runtime code with the Base hashes recomputed alongside as a control, reproducing the pinned
 * constants exactly. The Morpho SDK address registry carries deployment addresses but not runtime
 * hashes, so these stay local and must be updated whenever a ratifier is redeployed.
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

/** Viem chain definitions for every chain the quoter-bot bot supports, keyed by chain ID. */
const SUPPORTED_CHAINS = {
  [BASE_CHAIN_ID]: base,
  [MAINNET_CHAIN_ID]: mainnet
} as const

/** Chain ID of a network the quoter-bot bot supports. */
export type SupportedChainId = keyof typeof SUPPORTED_CHAINS

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
 * @remarks Midnight and ratifier addresses come from the pinned Morpho SDK registry, which carries
 * entries for both supported chains; read them with the SDK's `getChainAddress`.
 */
export const supportedChain = (chainId: SupportedChainId) => SUPPORTED_CHAINS[chainId]

/** Reference-rate lookback window in seconds, matching `BlueBootstrapReferenceRateService`. */
const REFERENCE_LOOKBACK_SECONDS = 21_600n

/**
 * Estimates how many blocks span the reference-rate lookback window on one chain.
 * @param chainId - Supported EVM chain identifier.
 * @returns The block count covering {@link REFERENCE_LOOKBACK_SECONDS} at that chain's cadence.
 * @remarks A fixed block count is chain-specific: 10,800 blocks is six hours on Base's two-second
 * cadence but about 36 hours on Ethereum's twelve-second cadence, which would make setup inspect
 * far older state than the rate reader needs and fail readiness for a recently initialized or
 * recently funded reference market. Derived from viem's `blockTime` so Base keeps its existing
 * 10,800-block default exactly.
 */
export const referenceLookbackBlocks = (chainId: SupportedChainId) =>
  REFERENCE_LOOKBACK_SECONDS / (BigInt(SUPPORTED_CHAINS[chainId].blockTime) / 1000n)

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
