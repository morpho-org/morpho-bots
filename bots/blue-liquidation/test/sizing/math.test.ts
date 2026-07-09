import { describe, expect, it } from 'bun:test'

import { VIRTUAL_ASSETS, VIRTUAL_SHARES, WAD } from '../../src/constants'
import {
  mulDivDown,
  mulDivUp,
  toAssetsDown,
  toAssetsUp,
  toSharesDown,
  toSharesUp,
  wDivDown,
  wDivUp,
  wMulDown,
  wTaylorCompounded
} from '../../src/sizing/math'

describe('wad math', () => {
  it('wMulDown / wDivDown / wDivUp scale by WAD with the right rounding', () => {
    expect(wMulDown(2n * WAD, 3n * WAD)).toBe(6n * WAD)
    expect(wMulDown(3n * 10n ** 17n, 14n * 10n ** 16n)).toBe(42n * 10n ** 15n) // 0.3 * 0.14 = 0.042
    expect(wDivDown(WAD, 2n * WAD)).toBe(WAD / 2n)
    expect(wDivDown(1n, 3n)).toBe((1n * WAD) / 3n)
    expect(wDivUp(1n, 3n)).toBe((1n * WAD) / 3n + 1n)
  })
})

describe('wTaylorCompounded', () => {
  it('is firstTerm + secondTerm + thirdTerm, each floored in order', () => {
    // x = 1e18, n = 1: 1e18 + 5e17 + floor(5e35/3e18)
    expect(wTaylorCompounded(WAD, 1n)).toBe(1_666_666_666_666_666_666n)
  })

  it('is zero when the rate is zero', () => {
    expect(wTaylorCompounded(0n, 10_000n)).toBe(0n)
  })
})

describe('shares math (virtual offsets)', () => {
  it('applies VIRTUAL_SHARES to shares and VIRTUAL_ASSETS to assets', () => {
    expect(VIRTUAL_SHARES).toBe(10n ** 6n)
    expect(VIRTUAL_ASSETS).toBe(1n)
    // Empty market: 1 asset ↔ VIRTUAL_SHARES shares, 1 share-lot ↔ 1 asset.
    expect(toSharesDown(1n, 0n, 0n)).toBe(VIRTUAL_SHARES)
    expect(toSharesUp(1n, 0n, 0n)).toBe(VIRTUAL_SHARES)
    expect(toAssetsDown(VIRTUAL_SHARES, 0n, 0n)).toBe(1n)
    expect(toAssetsUp(VIRTUAL_SHARES, 0n, 0n)).toBe(1n)
  })

  it('rounds toAssetsUp up and toAssetsDown down on a fractional conversion', () => {
    // shares that convert to a fractional asset amount: down floors, up ceils.
    const tba = 3n
    const tbs = 0n
    expect(toAssetsDown(1n, tba, tbs)).toBe(
      mulDivDown(1n, tba + VIRTUAL_ASSETS, tbs + VIRTUAL_SHARES)
    )
    expect(toAssetsUp(1n, tba, tbs)).toBe(mulDivUp(1n, tba + VIRTUAL_ASSETS, tbs + VIRTUAL_SHARES))
  })
})
