import { MAX_TICK, TickLib } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'vitest'

import {
  admissibleRateTick,
  alignedRateTick,
  alignTickDown,
  alignTickUp,
  isAprWadInRange,
  isEmptyTickWindow,
  rateTickWindow
} from '../../src/domain/tick-window'

const YEAR_SECONDS = 31_536_000n
const BPS_WAD = 10n ** 14n

const nextSeed = (seed: bigint) => (seed * 6_364_136_223_846_793_005n + 1n) % 2n ** 64n

describe('tick window', () => {
  test('aligns an annual rate onto the lowest covering spacing-aligned tick', () => {
    expect(alignedRateTick(450n, YEAR_SECONDS, 1n)).toBe(3_994n)
    expect(alignedRateTick(400n, YEAR_SECONDS, 1n)).toBe(4_018n)
  })

  test('derives the aligned tick window equivalent of both hard bounds', () => {
    const window = rateTickWindow({
      minimumRateBps: 450n,
      maximumRateBps: 600n,
      timeToMaturity: YEAR_SECONDS,
      tickSpacing: 1n
    })

    expect(window).toEqual({ lowestTick: 3_937n, highestTick: 3_993n })
    expect(isEmptyTickWindow(window)).toBe(false)
  })

  test('leaves an unsupplied bound unbounded', () => {
    expect(rateTickWindow({ timeToMaturity: YEAR_SECONDS, tickSpacing: 1n })).toEqual({})
    expect(
      rateTickWindow({ maximumRateBps: 600n, timeToMaturity: YEAR_SECONDS, tickSpacing: 1n })
    ).toEqual({ lowestTick: 3_937n })
  })

  test('reports an empty window when the range contains no aligned tick', () => {
    const window = rateTickWindow({
      minimumRateBps: 500n,
      maximumRateBps: 500n,
      timeToMaturity: YEAR_SECONDS,
      tickSpacing: 1n
    })

    expect(window).toEqual({ lowestTick: 3_973n, highestTick: 3_972n })
    expect(isEmptyTickWindow(window)).toBe(true)
  })

  test('keeps a zero minimum reachable up to the highest non-negative-rate tick', () => {
    expect(
      rateTickWindow({ minimumRateBps: 0n, timeToMaturity: YEAR_SECONDS, tickSpacing: 1n })
    ).toEqual({ highestTick: MAX_TICK - 1n })
  })

  test('encodes an in-range rate at its aligned tick and refuses one outside the range', () => {
    const parameters = {
      minimumRateBps: 450n,
      maximumRateBps: 600n,
      timeToMaturity: YEAR_SECONDS,
      tickSpacing: 1n
    }
    const window = rateTickWindow(parameters)
    expect(admissibleRateTick(500n, parameters, window)).toBe(
      alignedRateTick(500n, YEAR_SECONDS, 1n)
    )
    expect(admissibleRateTick(450n, parameters, window)).toBe(3_993n)
    expect(admissibleRateTick(600n, parameters, window)).toBe(3_937n)
    expect(admissibleRateTick(449n, parameters, window)).toBeUndefined()
    expect(admissibleRateTick(601n, parameters, window)).toBeUndefined()
    expect(admissibleRateTick(10_000n, { timeToMaturity: YEAR_SECONDS, tickSpacing: 1n }, {})).toBe(
      alignedRateTick(10_000n, YEAR_SECONDS, 1n)
    )
  })

  test('compares an encoded APR against the bounds at full precision', () => {
    const range = { minimumRateBps: 450n, maximumRateBps: 600n }
    expect(isAprWadInRange(600n * BPS_WAD, range)).toBe(true)
    expect(isAprWadInRange(450n * BPS_WAD, range)).toBe(true)
    expect(isAprWadInRange(TickLib.tickToApr(3_936n, YEAR_SECONDS), range)).toBe(false)
    expect(isAprWadInRange(450n * BPS_WAD - 1n, range)).toBe(false)
  })

  test('keeps every encoded APR inside the bounds at coarse spacings near maturity', () => {
    const spacings = Array.from({ length: Number(MAX_TICK) }, (_, index) =>
      BigInt(index + 1)
    ).filter(spacing => MAX_TICK % spacing === 0n)
    const maturities = [1n, 30n, 600n, 3_600n, 86_400n, 7n * 86_400n, YEAR_SECONDS]
    let seed = 42n
    const draw = (bound: bigint) => {
      seed = nextSeed(seed)
      return (seed >> 16n) % bound
    }
    let encoded = 0
    let empty = 0
    for (let sample = 0; sample < 4_000; sample += 1) {
      const tickSpacing = spacings[Number(draw(BigInt(spacings.length)))]!
      const timeToMaturity = maturities[Number(draw(BigInt(maturities.length)))]!
      const minimumRateBps = draw(3_000n)
      const maximumRateBps = minimumRateBps + 1n + draw(3_000n)
      const parameters = { minimumRateBps, maximumRateBps, timeToMaturity, tickSpacing }
      const window = rateTickWindow(parameters)
      if (isEmptyTickWindow(window)) {
        empty += 1
        continue
      }
      const rateBps = minimumRateBps + draw(maximumRateBps - minimumRateBps + 1n)
      const tick = admissibleRateTick(rateBps, parameters, window)!
      const apr = TickLib.tickToApr(tick, timeToMaturity)
      expect(tick % tickSpacing).toBe(0n)
      expect(apr).toBeGreaterThanOrEqual(minimumRateBps * BPS_WAD)
      expect(apr).toBeLessThanOrEqual(maximumRateBps * BPS_WAD)
      const aligned = alignedRateTick(rateBps, timeToMaturity, tickSpacing)
      expect(tick - aligned <= tickSpacing && aligned - tick <= tickSpacing).toBe(true)
      expect(admissibleRateTick(maximumRateBps + 1n, parameters, window)).toBeUndefined()
      if (minimumRateBps > 0n) {
        expect(admissibleRateTick(minimumRateBps - 1n, parameters, window)).toBeUndefined()
      }
      encoded += 1
    }
    expect(encoded).toBeGreaterThan(100)
    expect(empty).toBeGreaterThan(100)
  })
})

describe('tick alignment', () => {
  test('rounds onto the spacing away from and toward zero', () => {
    expect(alignTickUp(4_001n, 5n)).toBe(4_005n)
    expect(alignTickDown(4_001n, 5n)).toBe(4_000n)
  })

  test('leaves an already aligned tick untouched', () => {
    expect(alignTickUp(4_000n, 5n)).toBe(4_000n)
    expect(alignTickDown(4_000n, 5n)).toBe(4_000n)
  })

  test('is the identity at unit spacing', () => {
    expect(alignTickUp(4_001n, 1n)).toBe(4_001n)
    expect(alignTickDown(4_001n, 1n)).toBe(4_001n)
  })
})
