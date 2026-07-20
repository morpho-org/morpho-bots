import type { LogLevel } from '@repo/bot-kit';

import type { Hash, Hex } from 'viem';
import { isHex, parseGwei } from 'viem';

/**
 * Static per-market input parsed from `MIDNIGHT_MARKETS_JSON`.
 *
 * Quote parameters are intentionally global environment variables, so every configured market uses
 * the same target rate, spread, ladder width, and level count.
 */
export type MarketConfig = {
  /** Midnight market id that receives the published bid/ask ladder. */
  marketId: Hash;
  /** Maximum raw loan-token units each side can consume through shared consumption. */
  maxUnits: bigint;
};

/**
 * Fully expanded market quote configuration used by the publisher.
 *
 * The raw market JSON supplies `marketId` and `maxUnits`; `loadConfig` adds the global quote
 * controls after validating the related environment variables.
 */
export type MarketQuoteConfig = MarketConfig & {
  /** Target annualized rate at the center of the ladder, expressed in basis points. */
  targetRateBps: number;
  /** Full bid/ask spread around the target rate, expressed in basis points. */
  spreadBps: number;
  /** Number of bid levels and ask levels to publish for this market. */
  ladderLevels: number;
  /** Distance from the target rate to the farthest ladder level, expressed in basis points. */
  ladderRangeBps: number;
};

/** Fully parsed runtime configuration for the Midnight market-maker bot. */
type Config = {
  /** Chain id supported by this bot. Currently fixed to Base. */
  chainId: 8453;
  /** Primary Base RPC endpoint used for reads and writes. */
  rpcUrl: string;
  /** Optional fallback Base RPC endpoint used by viem's fallback transport. */
  rpcUrlFallback: string | undefined;
  /** Maker account private key used to sign offers and mempool transactions. */
  makerPrivateKey: Hex;
  /** Per-market ladder definitions to publish each epoch. */
  markets: MarketQuoteConfig[];
  /** Midnight API endpoint used for mempool validation. */
  apiUrl: string;
  /** Offer lifetime in seconds. */
  offerTtlSeconds: number;
  /** Seconds before the next epoch when the bot pre-publishes offers. */
  publishLeadSeconds: number;
  /** Main loop sleep duration in seconds. */
  loopIntervalSeconds: number;
  /** Max accepted transaction fee ceiling in wei. */
  maxFeeWei: bigint;
  /** When true, validates and signs offers without submitting to the mempool contract. */
  dryRun: boolean;
  /** Minimum structured log level emitted by the bot. */
  logLevel: LogLevel;
};

type Env = Record<string, string | undefined>;
type JsonRecord = Record<string, unknown>;

const MAX_UINT128 = (1n << 128n) - 1n;
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

function required(env: Env, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function integer(value: unknown, field: string, min: number) {
  if (!Number.isSafeInteger(value) || (value as number) < min)
    throw new Error(`${field} must be an integer >= ${min}`);
  return value as number;
}

function positiveBigInt(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new Error(`${field} must be a positive decimal string`);

  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > MAX_UINT128)
    throw new Error(`${field} must be between 1 and 2^128 - 1`);

  return parsed;
}

function parseMarketId(value: unknown): Hash {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error('marketId must be a 32-byte hex string');
  return value as Hash;
}

export function parseMarketConfigs(raw: string): MarketConfig[] {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('MIDNIGHT_MARKETS_JSON must be valid JSON');
  }

  if (!Array.isArray(value) || value.length === 0)
    throw new Error('MIDNIGHT_MARKETS_JSON must be a non-empty array');

  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`market[${index}] must be an object`);

    const keys = Object.keys(item);
    if (keys.length !== 2 || !keys.includes('marketId') || !keys.includes('maxUnits'))
      throw new Error(`market[${index}] must contain only marketId and maxUnits`);

    const marketId = parseMarketId(item.marketId);
    const key = marketId.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate marketId: ${marketId}`);

    seen.add(key);
    return {
      marketId,
      maxUnits: positiveBigInt(item.maxUnits, `market[${index}].maxUnits`)
    };
  });
}

function intEnv(env: Env, name: string, fallback: number, min: number) {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer >= ${min}`);
  return integer(Number(raw), name, min);
}

function requiredIntEnv(env: Env, name: string, min: number) {
  const raw = required(env, name);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer >= ${min}`);
  return integer(Number(raw), name, min);
}

function boolEnv(env: Env, name: string, fallback: boolean) {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (raw !== 'true' && raw !== 'false') throw new Error(`${name} must be true or false`);
  return raw === 'true';
}

export function loadConfig(env: Env = Bun.env): Config {
  const chainId = intEnv(env, 'CHAIN_ID', 8453, 1);
  if (chainId !== 8453)
    throw new Error(`Unsupported CHAIN_ID: ${chainId}; only Base (8453) is supported`);

  const makerPrivateKey = required(env, 'MAKER_PRIVATE_KEY');
  if (!isHex(makerPrivateKey) || makerPrivateKey.length !== 66)
    throw new Error('MAKER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string');

  const targetRateBps = requiredIntEnv(env, 'TARGET_RATE_BPS', 1);
  const spreadBps = requiredIntEnv(env, 'SPREAD_BPS', 1);
  const ladderLevels = requiredIntEnv(env, 'LADDER_LEVELS', 1);
  const ladderRangeBps = requiredIntEnv(env, 'LADDER_RANGE_BPS', 1);
  if (2 * ladderRangeBps < spreadBps)
    throw new Error('LADDER_RANGE_BPS must be at least half of SPREAD_BPS');
  if (ladderRangeBps > targetRateBps)
    throw new Error('LADDER_RANGE_BPS must not exceed TARGET_RATE_BPS');
  if (ladderLevels === 1 && 2 * ladderRangeBps !== spreadBps)
    throw new Error('LADDER_RANGE_BPS must equal half of SPREAD_BPS when LADDER_LEVELS is 1');

  const quoteConfig = { targetRateBps, spreadBps, ladderLevels, ladderRangeBps };
  const offerTtlSeconds = intEnv(env, 'OFFER_TTL_SECONDS', 3600, 600);
  const publishLeadSeconds = intEnv(env, 'PUBLISH_LEAD_SECONDS', 300, 0);
  if (publishLeadSeconds >= offerTtlSeconds)
    throw new Error('PUBLISH_LEAD_SECONDS must be lower than OFFER_TTL_SECONDS');

  const logLevel = env.LOG_LEVEL?.trim() || 'info';
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel))
    throw new Error(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}`);

  return {
    chainId: 8453,
    rpcUrl: required(env, 'RPC_URL'),
    rpcUrlFallback: env.RPC_URL_FALLBACK?.trim() || undefined,
    makerPrivateKey,
    markets: parseMarketConfigs(required(env, 'MIDNIGHT_MARKETS_JSON')).map(market => ({
      ...market,
      ...quoteConfig
    })),
    apiUrl: env.MIDNIGHT_API_URL?.trim() || 'https://api.morpho.org/v0/midnight',
    offerTtlSeconds,
    publishLeadSeconds,
    loopIntervalSeconds: intEnv(env, 'LOOP_INTERVAL_SECONDS', 30, 5),
    maxFeeWei: parseGwei(env.MAX_FEE_GWEI?.trim() || '10'),
    dryRun: boolEnv(env, 'DRY_RUN', false),
    logLevel: logLevel as LogLevel
  };
}
