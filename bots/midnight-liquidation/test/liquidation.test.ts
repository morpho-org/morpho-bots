import { MAX_COST_LEVEL_AGE_MS, venuePairKey } from '@repo/swaps'
import { describe, expect, it } from 'vitest'

import {
  liquidationTask,
  positionBid,
  positionConflicts,
  pricingOf,
  routeKeyOf,
  sizePosition,
  taskOf
} from '../src/liquidation'
import {
  collateralAt,
  curveCosting,
  FAR_MATURITY,
  LOAN,
  NATIVE,
  outAt,
  PRICES,
  PRICING_NOW,
  pricingFor,
  readingsOf,
  unhealthy
} from './scenario/bot'

const OPTIONS = { seizeCapMarginBps: 0, headroomFloorBps: 0 }

const sized = (slots: number[], amount = 100n, writeOff = false) =>
  sizePosition(
    { out: outAt({ ...unhealthy(0, 1, slots), amount, writeOff }, 100n, FAR_MATURITY), block: 7 },
    OPTIONS
  )

describe('a position bid', () => {
  it('ranks gross while a route or its curve is unknown, cold or too old to trust', () => {
    const gross = positionBid(sized([0]), pricingFor(), PRICING_NOW)
    expect(positionBid(sized([0]), pricingFor({ bps: 100 }, false), PRICING_NOW)).toBe(gross)
    expect(
      positionBid(
        sized([0]),
        pricingFor({ bps: 100, ageMs: MAX_COST_LEVEL_AGE_MS + 1 }),
        PRICING_NOW
      )
    ).toBe(gross)
    expect(positionBid(sized([0]), pricingFor({ bps: 0 }), PRICING_NOW)).toBe(gross)
  })

  it('charges a trusted curve its cost at the position’s own size', () => {
    const gross = positionBid(sized([0]), pricingFor(), PRICING_NOW)
    // 1% of a 100-token seize at one dollar a token.
    expect(positionBid(sized([0]), pricingFor({ bps: 100 }), PRICING_NOW)).toBe(gross - 10n ** 8n)
    expect(positionBid(sized([0], 200n), pricingFor({ bps: 100 }), PRICING_NOW)).toBe(
      positionBid(sized([0], 200n), pricingFor(), PRICING_NOW) - 2n * 10n ** 8n
    )
  })

  it('lets a cheap route outbid a larger gross surplus whose route costs more', () => {
    const cheap = positionBid(sized([0]), pricingFor({ bps: 0 }), PRICING_NOW)
    expect(positionBid(sized([0], 200n), pricingFor(), PRICING_NOW)).toBeGreaterThan(cheap)
    expect(positionBid(sized([0], 200n), pricingFor({ bps: 9_000 }), PRICING_NOW)).toBeLessThan(
      cheap
    )
  })

  it('costs a loan-token slot nothing, and bids an unpriced position below any negative score', () => {
    expect(positionBid(sized([1]), pricingFor(), PRICING_NOW)).toBeGreaterThan(0n)
    const losing = positionBid(sized([0]), pricingFor({ bps: 9_999 }), PRICING_NOW)
    expect(losing).toBeLessThan(0n)
    expect(positionBid(sized([0]), { ...pricingFor(), prices: {} }, PRICING_NOW)).toBeLessThan(
      losing
    )
  })
})

describe('a position’s pricing', () => {
  const pair = (market: number) => ({ collateral: collateralAt(market), loan: LOAN })
  const routeOf = (market: number) => ({
    [routeKeyOf(collateralAt(market), LOAN)]: { pair: pair(market), resolvedAt: 0 }
  })
  const curveOf = (market: number) => ({ [venuePairKey(pair(market))]: curveCosting(100, 0) })

  it('reads a price or a route past its expiry as absent', () => {
    const net = pricingFor({ bps: 100 })
    const at = (pricing: typeof net) => positionBid(sized([0]), pricing, PRICING_NOW)
    expect(at({ ...net, routes: readingsOf(routeOf(0), PRICING_NOW) })).toBe(
      at(pricingFor({ bps: 100 }, false))
    )
    expect(at({ ...net, prices: readingsOf(PRICES, PRICING_NOW) })).toBe(at({ ...net, prices: {} }))
  })

  it('keeps only the readings its activated collaterals can price against, expired ones included', () => {
    const pricing = {
      prices: readingsOf({
        [LOAN]: { priceE8: 1n, decimals: 18 },
        [collateralAt(0)]: { priceE8: 1n, decimals: 18 },
        [NATIVE]: { priceE8: 1n, decimals: 18 }
      }),
      routes: readingsOf({ ...routeOf(0), ...routeOf(5) }, 0),
      curves: readingsOf({ ...curveOf(0), ...curveOf(5) }),
      venues: ['0x'] as const
    }
    const own = pricingOf(outAt(unhealthy(0, 1), 100n, FAR_MATURITY), pricing, NATIVE)
    expect(Object.keys(own.prices)).toStrictEqual([LOAN, NATIVE])
    expect(Object.keys(own.routes)).toStrictEqual(Object.keys(routeOf(0)))
    expect(Object.keys(own.curves)).toStrictEqual(Object.keys(curveOf(0)))
  })
})

describe('the task a position acts under', () => {
  it('separates a write-off from the liquidations that share its conflict', () => {
    expect(taskOf(sized([0]))).toBe('liquidate')
    expect(taskOf(sized([0], 100n, true))).toBe('writeoff')
    const [liquidate, writeOff] = (['liquidate', 'writeoff'] as const).map(task =>
      liquidationTask({ bid: 1n, task }, '0xm:0xb')
    )
    expect([liquidate!.name, writeOff!.name]).toStrictEqual(['liquidate', 'writeoff'])
    expect(writeOff!.conflicts).toStrictEqual(liquidate!.conflicts)
    expect(liquidate!.conflicts).toStrictEqual(positionConflicts('0xm:0xb'))
  })
})
