import { parseUnits } from 'viem/utils'

const WAD_TWO_DECIMALS = 16

/**
 * Converts a whole percentage value to a WAD value.
 *
 * @param percentValue - The value in percentage as a number.
 * @returns The WAD value as a bigint.
 */
export function wholePercentToWAD(percentValue: number): bigint {
  return parseUnits(percentValue.toString(), WAD_TWO_DECIMALS)
}
