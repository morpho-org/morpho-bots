import type { LogLevel } from '@repo/bot-kit'
import type { Hash, Hex } from 'viem'

import { isHex, parseGwei } from 'viem'

export type MarketQuoteConfig = {
  marketId: Hash
  midTick: number
  halfSpreadTicks: number
  levelStepTicks: number
  levels: number
  maxUnits: bigint
}
export type Config = {
  chainId: 8453
  rpcUrl: string
  rpcUrlFallback: string | undefined
  makerPrivateKey: Hex
  markets: MarketQuoteConfig[]
  apiUrl: string
  offerTtlSeconds: number
  publishLeadSeconds: number
  loopIntervalSeconds: number
  maxFeeWei: bigint
  dryRun: boolean
  logLevel: LogLevel
}
type Env = Record<string, string | undefined>
type JsonRecord = Record<string, unknown>
const MAX_UINT128 = (1n << 128n) - 1n
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
function required(env: Env, name: string) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}
function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function integer(value: unknown, field: string, min: number) {
  if (!Number.isSafeInteger(value) || (value as number) < min)
    throw new Error(`${field} must be an integer >= ${min}`)
  return value as number
}
function positiveBigInt(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new Error(`${field} must be a positive decimal string`)
  const parsed = BigInt(value)
  if (parsed <= 0n || parsed > MAX_UINT128)
    throw new Error(`${field} must be between 1 and 2^128 - 1`)
  return parsed
}
function parseMarketId(value: unknown): Hash {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error('marketId must be a 32-byte hex string')
  return value as Hash
}
export function parseMarketConfigs(raw: string): MarketQuoteConfig[] {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    throw new Error('MIDNIGHT_MARKETS_JSON must be valid JSON')
  }
  if (!Array.isArray(value) || value.length === 0)
    throw new Error('MIDNIGHT_MARKETS_JSON must be a non-empty array')
  const seen = new Set<string>()
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`market[${index}] must be an object`)
    const marketId = parseMarketId(item.marketId)
    const key = marketId.toLowerCase()
    if (seen.has(key)) throw new Error(`duplicate marketId: ${marketId}`)
    seen.add(key)
    return {
      marketId,
      midTick: integer(item.midTick, `market[${index}].midTick`, 0),
      halfSpreadTicks: integer(item.halfSpreadTicks, `market[${index}].halfSpreadTicks`, 1),
      levelStepTicks: integer(item.levelStepTicks, `market[${index}].levelStepTicks`, 1),
      levels: integer(item.levels, `market[${index}].levels`, 1),
      maxUnits: positiveBigInt(item.maxUnits, `market[${index}].maxUnits`)
    }
  })
}
function intEnv(env: Env, name: string, fallback: number, min: number) {
  const raw = env[name]?.trim()
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer >= ${min}`)
  return integer(Number(raw), name, min)
}
function boolEnv(env: Env, name: string, fallback: boolean) {
  const raw = env[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw !== 'true' && raw !== 'false') throw new Error(`${name} must be true or false`)
  return raw === 'true'
}
export function loadConfig(env: Env = Bun.env): Config {
  const chainId = intEnv(env, 'CHAIN_ID', 8453, 1)
  if (chainId !== 8453)
    throw new Error(`Unsupported CHAIN_ID: ${chainId}; only Base (8453) is supported`)
  const makerPrivateKey = required(env, 'MAKER_PRIVATE_KEY')
  if (!isHex(makerPrivateKey) || makerPrivateKey.length !== 66)
    throw new Error('MAKER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
  const offerTtlSeconds = intEnv(env, 'OFFER_TTL_SECONDS', 3600, 600)
  const publishLeadSeconds = intEnv(env, 'PUBLISH_LEAD_SECONDS', 300, 0)
  if (publishLeadSeconds >= offerTtlSeconds)
    throw new Error('PUBLISH_LEAD_SECONDS must be lower than OFFER_TTL_SECONDS')
  const logLevel = env.LOG_LEVEL?.trim() || 'info'
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel))
    throw new Error(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}`)
  return {
    chainId: 8453,
    rpcUrl: required(env, 'RPC_URL'),
    rpcUrlFallback: env.RPC_URL_FALLBACK?.trim() || undefined,
    makerPrivateKey,
    markets: parseMarketConfigs(required(env, 'MIDNIGHT_MARKETS_JSON')),
    apiUrl: env.MIDNIGHT_API_URL?.trim() || 'https://api.morpho.org/v0/midnight',
    offerTtlSeconds,
    publishLeadSeconds,
    loopIntervalSeconds: intEnv(env, 'LOOP_INTERVAL_SECONDS', 30, 5),
    maxFeeWei: parseGwei(env.MAX_FEE_GWEI?.trim() || '10'),
    dryRun: boolEnv(env, 'DRY_RUN', false),
    logLevel: logLevel as LogLevel
  }
}
