import { formatUnits, getAddress, isAddress, isHex, maxUint256 } from 'viem';
import { z } from 'zod';

import { safeParseUnits } from './safeParseUnits';

export const hexSchema = z
  .string()
  .refine(isHex, 'Invalid hex format')
  .transform(v => v);

export const addressSchema = z
  .string()
  .trim()
  .min(1, 'Missing address')
  .refine(value => isAddress(value, { strict: false }), 'Invalid address')
  .transform(value => getAddress(value));

export function createOnchainAmountSchema({
  decimals,
  min = 1n, // 1n is equivalent to positive (0n is not valid)
  minErrorMessage = min === 1n
    ? 'Amount required'
    : `Must be greater than ${formatUnits(min, decimals)}.`,
  max = maxUint256,
  maxErrorMessage = `Must be less than ${formatUnits(max, decimals)}.`
}: {
  decimals: number;
  min?: bigint;
  minErrorMessage?: string;
  max?: bigint;
  maxErrorMessage?: string;
}) {
  return z
    .string()
    .transform((value, ctx) => {
      const parsed = safeParseUnits(value, decimals);

      if (parsed === null) {
        ctx.addIssue({
          code: 'custom',
          message: 'Invalid number'
        });
        return z.NEVER;
      }

      return parsed;
    })
    .pipe(z.bigint().min(min, { message: minErrorMessage }).max(max, { message: maxErrorMessage }));
}
