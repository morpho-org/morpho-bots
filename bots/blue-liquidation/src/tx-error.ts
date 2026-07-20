import { abiRevertDecoder, revertReason as revertReasonWith } from '@repo/bot-kit';
import { MorphoAbi } from '@repo/contracts';

const decodeMorphoRevert = abiRevertDecoder(MorphoAbi);

/**
 * Morpho-aware revert formatter: decodes the singleton's custom ABI errors on top of the standard
 * shapes. Injected into the runner and the pending queue so their `tick.error` / `tx.*` log lines
 * carry decoded Morpho reasons instead of raw hex.
 */
export const revertReason = (error: unknown): string => revertReasonWith(error, decodeMorphoRevert);
