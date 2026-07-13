import { getAddress, isAddress } from 'viem'
import { z } from 'zod'

export const addressSchema = z
  .string()
  .trim()
  .min(1, 'Missing address')
  .refine(value => isAddress(value, { strict: false }), 'Invalid address')
  .transform(value => getAddress(value))
