import { abiRevertDecoder, revertReason as revertReasonWith } from '@repo/bot-kit';
import { MidnightAbi } from '@repo/contracts';

const decodeMidnightRevert = abiRevertDecoder(MidnightAbi);

/**
 * Midnight-aware revert formatter: decodes the protocol's custom ABI errors (`NotBorrower(…)` etc.)
 * on top of the standard shapes. Injected into the runner and the pending queue so their
 * `tick.error` / `tx.*` log lines carry decoded Midnight reasons.
 */
export const revertReason = (error: unknown): string =>
  revertReasonWith(error, decodeMidnightRevert);
