import { parseUnits } from 'viem';

/**
 * Parses a string value to a bigint with the specified decimals or return null if the value is invalid.
 * Handles "" and "." as 0n.
 * @param value - The value to parse.
 * @param decimals - The number of decimals to use for parsing.
 * @returns The parsed value as a bigint, or null if the value is invalid.
 */
export function safeParseUnits(value: string, decimals: number): bigint | null {
  try {
    // parseUnits handles "" and "." as 0n (desired behavior)
    return parseUnits(value.trim(), decimals);
  } catch {
    return null;
  }
}
