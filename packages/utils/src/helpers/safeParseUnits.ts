import { parseUnits } from 'viem'

/**
 * Scales a decimal string to a bigint, or `null` when it does not parse. `""` and `"."` yield `0n`.
 *
 * Excess precision is ROUNDED half-away-from-zero, not truncated — `"1.9999999"` at 6 decimals is
 * `2000000n`, so a value derived from a balance can round above that balance.
 */
export function safeParseUnits(value: string, decimals: number): bigint | null {
  try {
    return parseUnits(value.trim(), decimals)
  } catch {
    return null
  }
}
