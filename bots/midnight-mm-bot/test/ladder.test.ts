import { TickLib } from '@morpho-org/midnight-sdk'
import { describe, expect, it } from 'bun:test'

import type { MarketQuoteConfig } from '../src/config'

import { buildLadderTicks } from '../src/ladder'
const config: MarketQuoteConfig = {
  marketId: `0x${'11'.repeat(32)}`,
  targetRateBps: 500,
  spreadBps: 200,
  ladderLevels: 3,
  ladderRangeBps: 300,
  maxUnits: 1000000n
}
const tick = (rateBps: number) =>
  TickLib.priceToTick(TickLib.rateToPrice(BigInt(rateBps) * 100_000_000_000_000n), 4n)
describe('buildLadderTicks', () => {
  it('builds 2%, 3%, 4% bids and 6%, 7%, 8% asks', () => {
    expect(buildLadderTicks(config, 4)).toEqual({
      bids: [tick(200), tick(300), tick(400)],
      asks: [tick(600), tick(700), tick(800)]
    })
  })
  it('rejects ticks that collapse after snapping to market spacing', () => {
    expect(() =>
      buildLadderTicks(
        { ...config, targetRateBps: 500, spreadBps: 2, ladderLevels: 3, ladderRangeBps: 2 },
        4
      )
    ).toThrow('duplicate snapped tick')
  })
  it('rejects invalid market tick spacing', () => {
    expect(() => buildLadderTicks(config, 0)).toThrow('invalid market tick spacing')
  })
})
