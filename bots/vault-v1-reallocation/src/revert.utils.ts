import { metaMorphoAbi } from '@morpho-org/blue-sdk-viem'
import { abiRevertDecoder, revertReason as revertReasonWith } from '@repo/kit'

const decodeMetaMorphoRevert = abiRevertDecoder(metaMorphoAbi)

/**
 * Vault V1-aware revert formatter: decodes the vault's custom ABI errors on top of the standard
 * shapes, so `vault.error`, `reallocation.sim_revert` and `runner.failed` carry decoded Vault V1
 * reasons instead of raw hex, and never a transport message that could embed the RPC URL.
 */
export const revertReason = (error: unknown): string =>
  revertReasonWith(error, decodeMetaMorphoRevert)
