import { parseGwei } from 'viem'

/**
 * The fee ceiling in wei, from a decimal gwei amount that resolves to at least one wei, or undefined.
 * Imports nothing that needs a build, so the deploy script refuses exactly what the bot refuses.
 */
export const parseMaxFeeGwei = (raw: string): bigint | undefined => {
  const value = raw.trim()
  if (!/^\d+(\.\d{1,9})?$/.test(value)) return undefined
  const wei = parseGwei(value)
  return wei > 0n ? wei : undefined
}
