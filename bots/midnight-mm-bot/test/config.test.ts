import type { Hash } from 'viem'

import { describe, expect, it } from 'bun:test'

import { parseMarketConfigs } from '../src/config'
const MARKET_ID: Hash = `0x${'11'.repeat(32)}`
const market = {
  marketId: MARKET_ID,
  midTick: 5000,
  halfSpreadTicks: 8,
  levelStepTicks: 4,
  levels: 3,
  maxUnits: '1000000'
} as const
describe('parseMarketConfigs', () => {
  it('parses a static market list', () => {
    expect(parseMarketConfigs(JSON.stringify([market]))).toEqual([
      { ...market, maxUnits: 1000000n }
    ])
  })
  it('rejects duplicate markets', () => {
    expect(() => parseMarketConfigs(JSON.stringify([market, market]))).toThrow('duplicate marketId')
  })
  it('rejects malformed values', () => {
    expect(() => parseMarketConfigs('not-json')).toThrow('MIDNIGHT_MARKETS_JSON must be valid JSON')
    expect(() => parseMarketConfigs(JSON.stringify([{ ...market, midTick: -1 }]))).toThrow(
      'midTick'
    )
  })
})
