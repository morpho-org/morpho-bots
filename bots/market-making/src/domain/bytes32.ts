/**
 * Checks exact bytes32 syntax without importing account or provider-capable viem modules.
 * @param value - Candidate hexadecimal identifier.
 * @returns Whether the value is a 0x-prefixed 32-byte hexadecimal string.
 */
export const isBytes32 = (value: string) => /^0x[0-9a-fA-F]{64}$/.test(value)

/**
 * Canonicalizes a bytes32 value after the caller has established exact syntax.
 * @param value - Previously validated bytes32 identifier.
 * @returns The lower-case 0x-prefixed representation.
 */
export const normalizeBytes32 = (value: string): `0x${string}` =>
  `0x${value.slice(2).toLowerCase()}`
