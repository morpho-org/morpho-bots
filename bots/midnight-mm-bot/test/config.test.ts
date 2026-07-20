import { describe, expect, it } from 'bun:test';

import type { Hash } from 'viem';

import { loadConfig, parseMarketConfigs } from '../src/config';

const MARKET_ID: Hash = `0x${'11'.repeat(32)}`;
const market = { marketId: MARKET_ID, maxUnits: '1000000' } as const;
const env = {
  RPC_URL: 'https://rpc.example',
  MAKER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  MIDNIGHT_MARKETS_JSON: JSON.stringify([market]),
  TARGET_RATE_BPS: '500',
  SPREAD_BPS: '200',
  LADDER_LEVELS: '3',
  LADDER_RANGE_BPS: '300'
} as const;

describe('parseMarketConfigs', () => {
  it('parses only the static per-market fields', () => {
    expect(parseMarketConfigs(JSON.stringify([market]))).toEqual([
      { marketId: MARKET_ID, maxUnits: 1000000n }
    ]);
  });

  it('rejects quote fields in the market JSON', () => {
    expect(() => parseMarketConfigs(JSON.stringify([{ ...market, targetRateBps: 500 }]))).toThrow(
      'only marketId and maxUnits'
    );
  });

  it('rejects duplicate markets', () => {
    expect(() => parseMarketConfigs(JSON.stringify([market, market]))).toThrow(
      'duplicate marketId'
    );
  });
});

describe('loadConfig quote settings', () => {
  it('applies required global quote settings to every market', () => {
    expect(loadConfig(env).markets).toEqual([
      {
        marketId: MARKET_ID,
        maxUnits: 1000000n,
        targetRateBps: 500,
        spreadBps: 200,
        ladderLevels: 3,
        ladderRangeBps: 300
      }
    ]);
  });

  it('uses safe Router guard defaults', () => {
    const config = loadConfig(env);
    expect(config.maxPriceDeviationBps).toBe(1000);
    expect(config.routerTimeoutMs).toBe(2500);
  });

  it('validates Router guard bounds', () => {
    expect(() => loadConfig({ ...env, MAX_PRICE_DEVIATION_BPS: '0' })).toThrow(
      'MAX_PRICE_DEVIATION_BPS must be an integer >= 1'
    );
    expect(() => loadConfig({ ...env, MAX_PRICE_DEVIATION_BPS: '10001' })).toThrow(
      'MAX_PRICE_DEVIATION_BPS must be an integer between 1 and 10000'
    );
    expect(() => loadConfig({ ...env, ROUTER_TIMEOUT_MS: '0' })).toThrow(
      'ROUTER_TIMEOUT_MS must be an integer >= 1'
    );
  });

  it('requires every global quote setting', () => {
    for (const name of ['TARGET_RATE_BPS', 'SPREAD_BPS', 'LADDER_LEVELS', 'LADDER_RANGE_BPS']) {
      expect(() => loadConfig({ ...env, [name]: undefined })).toThrow(
        `Missing required env var: ${name}`
      );
    }
  });

  it('rejects invalid integers and ranges', () => {
    expect(() => loadConfig({ ...env, TARGET_RATE_BPS: '5.5' })).toThrow(
      'TARGET_RATE_BPS must be an integer'
    );
    expect(() => loadConfig({ ...env, LADDER_RANGE_BPS: '99' })).toThrow(
      'LADDER_RANGE_BPS must be at least half of SPREAD_BPS'
    );
    expect(() => loadConfig({ ...env, LADDER_RANGE_BPS: '501' })).toThrow(
      'LADDER_RANGE_BPS must not exceed TARGET_RATE_BPS'
    );
  });
});
