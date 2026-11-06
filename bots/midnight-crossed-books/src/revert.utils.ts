import { CrossedBooksResolver, MidnightAbi } from '@repo/contracts'
import { abiRevertDecoder, revertReason as revertReasonWith } from '@repo/kit'

const decodeResolverRevert = abiRevertDecoder([...CrossedBooksResolver.abi, ...MidnightAbi])

/**
 * Decodes the resolver's own errors and the Midnight errors its takes bubble up, on top of the
 * standard shapes, so a reverted simulation logs `NotCrossed(…)` rather than raw hex.
 */
export const revertReason = (error: unknown): string =>
  revertReasonWith(error, decodeResolverRevert)
