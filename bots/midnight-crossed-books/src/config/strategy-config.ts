import { DEFAULT_MAX_MATCHES } from '../domain/matching.service'

export type StrategyEnvironment = Record<string, string | undefined>
export type CrossedBooksStrategyConfig = {
  minimumProfitAssets: bigint
  maxMatches: number
  scanIntervalMs: number
}

export const CROSSED_BOOKS_STRATEGY_ENV_KEYS = [
  'MIN_PROFIT_ASSETS',
  'MAX_MATCHES',
  'SCAN_INTERVAL_MS'
] as const

const unsignedDecimal = (environment: StrategyEnvironment, name: string, fallback: string) => {
  const value = environment[name]?.trim() || fallback
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an unsigned decimal integer`)
  return value
}

/** Browser-safe parser shared by the bot and its stateless configuration playground. */
export const parseCrossedBooksStrategyEnvironment = (
  environment: StrategyEnvironment
): CrossedBooksStrategyConfig => {
  const scanIntervalMs = Number(unsignedDecimal(environment, 'SCAN_INTERVAL_MS', '15000'))
  if (!Number.isSafeInteger(scanIntervalMs) || scanIntervalMs <= 0) {
    throw new Error('SCAN_INTERVAL_MS must be a positive safe integer')
  }

  const minimumProfitAssets = BigInt(unsignedDecimal(environment, 'MIN_PROFIT_ASSETS', '1'))
  const maxMatches = Number(
    unsignedDecimal(environment, 'MAX_MATCHES', String(DEFAULT_MAX_MATCHES))
  )
  if (!Number.isSafeInteger(maxMatches) || maxMatches <= 0) {
    throw new Error('MAX_MATCHES must be a positive safe integer')
  }

  return { minimumProfitAssets, maxMatches, scanIntervalMs }
}
