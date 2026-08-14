import { describe, expect, test } from 'vitest'

import { clampRateBps, CROSS_BOOK_CLEARANCE_BPS } from '../../src/domain/cross-book'

describe('cross-book domain', () => {
  test('keeps the shared clearance at ten basis points', () => {
    expect(CROSS_BOOK_CLEARANCE_BPS).toBe(10n)
  })

  test('saturates rates at the nearest inclusive hard bound', () => {
    expect(clampRateBps(150n, 200n, 800n)).toBe(200n)
    expect(clampRateBps(-1n, 200n, 800n)).toBe(200n)
    expect(clampRateBps(900n, 200n, 800n)).toBe(800n)
    expect(clampRateBps(200n, 200n, 800n)).toBe(200n)
    expect(clampRateBps(800n, 200n, 800n)).toBe(800n)
    expect(clampRateBps(500n, 200n, 800n)).toBe(500n)
  })
})
