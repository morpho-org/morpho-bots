import { MAX_OFFER_CAP, TickLib } from '@morpho-org/midnight-sdk'
import { MathLib } from '@morpho-org/morpho-ts'
import { describe, expect, test } from 'vitest'

import {
  isGroupClosed,
  remainingBuyAssets,
  remainingCap,
  unitsForBuyerAssetsAtTick
} from '../../src/domain/offer-cap'

describe('remainingCap', () => {
  test.each([
    ['assets', 100n, 30n, 70n],
    ['units', 100n, 30n, 70n],
    ['units', 100n, 100n, 0n],
    ['assets', 100n, 150n, 0n],
    ['units', 100n, MAX_OFFER_CAP, 0n]
  ] as const)('a %s cap of %i consumed %i leaves %i', (kind, maximum, consumed, remaining) => {
    expect(remainingCap({ kind, maximum }, consumed)).toBe(remaining)
  })
})

describe('isGroupClosed', () => {
  test.each([
    [
      'a units buy at its cap, whose recorded kind is not trusted',
      { kind: 'units', maximum: 100n },
      true,
      100n,
      false
    ],
    ['a units sell at its cap', { kind: 'units', maximum: 100n }, false, 100n, true],
    ['a cash sell at its cap', { kind: 'assets', maximum: 100n }, false, 100n, true],
    [
      'a cash buy at its cap, still takeable for zero-asset units',
      { kind: 'assets', maximum: 100n },
      true,
      100n,
      false
    ],
    ['a cancelled cash buy', { kind: 'assets', maximum: 100n }, true, MAX_OFFER_CAP, true],
    ['a partly consumed units buy', { kind: 'units', maximum: 100n }, true, 99n, false]
  ] as const)('%s', (_label, cap, buy, consumed, closed) => {
    expect(isGroupClosed({ cap, buy }, consumed)).toBe(closed)
  })
})

describe('face and cash at a tick', () => {
  const tick = 5_000n
  const price = TickLib.tickToPrice(tick)
  const units = (maximum: bigint) => ({ kind: 'units' as const, maximum })

  test('prices a units buy at its tick, rounding up so the bound never understates', () => {
    expect(remainingBuyAssets(units(1_000_000n), 0n, [tick])).toBe(
      MathLib.mulDiv(1_000_000n, price, MathLib.WAD, 'Up')
    )
    expect(remainingBuyAssets(units(1n), 0n, [tick])).toBe(1n)
    expect(remainingBuyAssets(units(100n), 40n, [tick])).toBe(
      MathLib.mulDiv(60n, price, MathLib.WAD, 'Up')
    )
  })

  test('prices a group at its highest buy tick, and at face without one', () => {
    expect(remainingBuyAssets(units(1_000_000n), 0n, [2_000n, tick, 3_000n])).toBe(
      remainingBuyAssets(units(1_000_000n), 0n, [tick])
    )
    expect(remainingBuyAssets(units(1_000_000n), 0n, [])).toBe(1_000_000n)
  })

  test('reads a cash cap and a cancelled group directly', () => {
    expect(remainingBuyAssets({ kind: 'assets', maximum: 100n }, 30n, [tick])).toBe(70n)
    expect(remainingBuyAssets(units(100n), MAX_OFFER_CAP, [tick])).toBe(0n)
  })

  test('finds the fewest units worth an amount by rounding up', () => {
    const fewest = unitsForBuyerAssetsAtTick(1_000_000n, tick)!

    expect(MathLib.mulDiv(fewest, price, MathLib.WAD, 'Down')).toBeGreaterThanOrEqual(1_000_000n)
    expect(MathLib.mulDiv(fewest - 1n, price, MathLib.WAD, 'Down')).toBeLessThan(1_000_000n)
  })

  test.each([0n, 1n])('treats tick %i, whose price is zero, without dividing by it', zeroTick => {
    expect(remainingBuyAssets(units(1_000_000n), 0n, [zeroTick])).toBe(0n)
    expect(unitsForBuyerAssetsAtTick(1_000_000n, zeroTick)).toBeUndefined()
  })
})
