import { MAX_TICK } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'vitest'

import {
  alignedRateTick,
  clampTickToWindow,
  isEmptyTickWindow,
  rateTickWindow
} from '../../src/infrastructure/tick-window.utils'

const YEAR_SECONDS = 31_536_000n

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

  test('saturates ticks at the nearest window side', () => {
    const window = { lowestTick: 3_937n, highestTick: 3_993n }
    expect(clampTickToWindow(3_900n, window)).toBe(3_937n)
    expect(clampTickToWindow(4_100n, window)).toBe(3_993n)
    expect(clampTickToWindow(3_950n, window)).toBe(3_950n)
    expect(clampTickToWindow(3_950n, {})).toBe(3_950n)
  })
})
