import { metaMorphoAbi } from '@morpho-org/blue-sdk-viem'
import { abiRevertDecoder, revertReason as revertReasonWith } from '@repo/bot-kit'

const decodeMetaMorphoRevert = abiRevertDecoder(metaMorphoAbi)

/**
 * MetaMorpho-aware revert formatter: decodes the vault's custom ABI errors on top of the standard
 * shapes. Injected into the runner and the pending queue so their `tick.error` / `tx.*` log lines
 * carry decoded MetaMorpho reasons instead of raw hex.
 */
export const revertReason = (error: unknown): string =>
  revertReasonWith(error, decodeMetaMorphoRevert)
