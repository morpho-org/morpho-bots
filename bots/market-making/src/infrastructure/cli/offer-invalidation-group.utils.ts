import type { Hex } from 'viem'

import { bytesToHex, hexToBytes, isHex, size } from 'viem'

import { CliUsageError } from './cli-usage.error'

/**
 * Validates and canonicalizes the optional CLI offer-group selector.
 * @param value - Optional untrusted positional command argument.
 * @returns No selector for maker-wide invalidation, otherwise one canonical bytes32 group ID.
 * @throws `CliUsageError` when the supplied selector is not strict 32-byte hex.
 */
export const offerInvalidationGroup = (value: string | undefined): Hex | undefined => {
  if (value === undefined) return undefined
  if (!isHex(value, { strict: true }) || size(value) !== 32) throw new CliUsageError()
  return bytesToHex(hexToBytes(value))
}
