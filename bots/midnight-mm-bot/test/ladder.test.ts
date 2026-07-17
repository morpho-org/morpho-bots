import { describe, expect, it } from 'bun:test'

import type { MarketQuoteConfig } from '../src/config'

import { buildLadderTicks } from '../src/ladder'
const config: MarketQuoteConfig = {
  marketId: `0x${'11'.repeat(32)}`,
  midTick: 5000,
  halfSpreadTicks: 8,
  levelStepTicks: 4,
  levels: 3,
  maxUnits: 1000000n
}
describe('buildLadderTicks', () => {
  it('builds bids below asks in price space', () => {
    expect(buildLadderTicks(config, 4)).toEqual({
      bids: [5008n, 5012n, 5016n],
      asks: [4992n, 4988n, 4984n]
    })
  })
  it('requires offsets to match spacing', () => {
    expect(() => buildLadderTicks({ ...config, halfSpreadTicks: 6 }, 4)).toThrow(
      'halfSpreadTicks must be a multiple'
    )
    expect(() => buildLadderTicks({ ...config, levelStepTicks: 2 }, 4)).toThrow(
      'levelStepTicks must be a multiple'
    )
  })
  it('rejects out-of-bounds ladders', () => {
    expect(() => buildLadderTicks({ ...config, midTick: 4 }, 4)).toThrow('ask tick is outside')
  })
})
