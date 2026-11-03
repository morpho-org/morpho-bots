import { MidnightAbi } from '@repo/contracts'
import { abiRevertDecoder, revertReason as revertReasonWith } from '@repo/kit'

const decodeMidnightRevert = abiRevertDecoder(MidnightAbi)

/**
 * Midnight-aware revert formatter: decodes the protocol's custom ABI errors (`NotBorrower(…)` etc.)
 * on top of the standard shapes, so log lines carry decoded Midnight reasons.
 */
export const revertReason = (error: unknown): string =>
  revertReasonWith(error, decodeMidnightRevert)
