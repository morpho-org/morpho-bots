import { MorphoAbi } from '@repo/contracts'
import { abiRevertDecoder, revertReason as revertReasonWith } from '@repo/kit'

const decodeMorphoRevert = abiRevertDecoder(MorphoAbi)

/**
 * Morpho-aware revert formatter: decodes the singleton's custom ABI errors on top of the standard
 * shapes, so a failed world reading's `tick.error` carries the decoded reason instead of raw hex.
 */
export const revertReason = (error: unknown): string => revertReasonWith(error, decodeMorphoRevert)
