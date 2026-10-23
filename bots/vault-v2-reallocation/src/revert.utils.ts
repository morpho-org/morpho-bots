import { vaultV2Abi } from '@morpho-org/blue-sdk-viem'
import { abiRevertDecoder, revertReason as revertReasonWith } from '@repo/kit'

const decodeVaultV2Revert = abiRevertDecoder(vaultV2Abi)

/**
 * VaultV2-aware revert formatter: decodes the vault's custom ABI errors on top of the standard
 * shapes, so `vault.error`, `reallocation.sim_revert` and `runner.failed` carry decoded VaultV2
 * reasons instead of raw hex, and never a transport message that could embed the RPC URL.
 */
export const revertReason = (error: unknown): string => revertReasonWith(error, decodeVaultV2Revert)
