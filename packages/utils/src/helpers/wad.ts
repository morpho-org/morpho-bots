import { formatUnits, parseUnits } from 'viem/utils';

const WAD_TWO_DECIMALS = 16;

/**
 * Converts a whole percentage value to a WAD value.
 *
 * @param percentValue - The value in percentage as a number.
 * @returns The WAD value as a bigint.
 */
export function wholePercentToWAD(percentValue: number): bigint {
  return parseUnits(percentValue.toString(), WAD_TWO_DECIMALS);
}

/**
 * Converts a WAD value to a whole percentage value.
 *
 * @param wadValue - The value in WAD as a bigint.
 * @returns The whole percentage value as a number.
 */
export function wadToWholePercent(wadValue: bigint): number {
  return Number(formatUnits(wadValue, WAD_TWO_DECIMALS));
}
