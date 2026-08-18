import { getAddress } from 'viem'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_APY_RANGE,
  marketApyRanges,
  marketMinApyDeltaBips,
  resolveApyRange,
  resolveMinApyDeltaBips,
  resolveMinUtilizationDeltaBips,
  vaultApyRanges,
  vaultMinApyDeltaBips,
  vaultMinUtilizationDeltaBips
} from '../src/strategy-config'

type ApyRangePercent = { min: number; max: number }

const CHAIN_ID = 1
const VAULT = getAddress(`0x${'11'.repeat(20)}`)
const MARKET = `0x${'22'.repeat(32)}` as const

// The tables ship empty (template); tests exercise precedence by populating and restoring them.
afterEach(() => {
  for (const table of [
    vaultApyRanges,
    marketApyRanges,
    vaultMinApyDeltaBips,
    marketMinApyDeltaBips,
    vaultMinUtilizationDeltaBips
  ]) {
    delete table[CHAIN_ID]
  }
})

describe('checked-in APY range tables', () => {
  // Guards future PRs editing the (currently empty) tables: a flipped pair silently inverts the
  // above-range / below-range classification instead of failing.
  it('keeps min below max in the global default', () => {
    expect(DEFAULT_APY_RANGE.min).toBeLessThan(DEFAULT_APY_RANGE.max)
  })

  it.each([
    ['vault', vaultApyRanges as Record<number, Record<string, ApyRangePercent>>],
    ['market', marketApyRanges as Record<number, Record<string, ApyRangePercent>>]
  ])('keeps min below max in every %s override', (_label, table) => {
    for (const [chainId, entries] of Object.entries(table)) {
      for (const [key, range] of Object.entries(entries)) {
        expect(range.min, `${chainId}/${key}`).toBeLessThan(range.max)
      }
    }
  })
})

describe('resolveApyRange', () => {
  it('falls back to the global default', () => {
    expect(resolveApyRange(CHAIN_ID, VAULT, MARKET)).toEqual(DEFAULT_APY_RANGE)
  })

  it('prefers a vault override over the default', () => {
    vaultApyRanges[CHAIN_ID] = { [VAULT]: { min: 4, max: 6 } }
    expect(resolveApyRange(CHAIN_ID, VAULT, MARKET)).toEqual({ min: 4, max: 6 })
  })

  it('prefers a market override over a vault override', () => {
    vaultApyRanges[CHAIN_ID] = { [VAULT]: { min: 4, max: 6 } }
    marketApyRanges[CHAIN_ID] = { [MARKET]: { min: 5, max: 7 } }
    expect(resolveApyRange(CHAIN_ID, VAULT, MARKET)).toEqual({ min: 5, max: 7 })
  })

  it('scopes overrides to their chain', () => {
    vaultApyRanges[CHAIN_ID] = { [VAULT]: { min: 4, max: 6 } }
    expect(resolveApyRange(8453, VAULT, MARKET)).toEqual(DEFAULT_APY_RANGE)
  })
})

describe('resolveMinApyDeltaBips', () => {
  it('falls back to the caller-provided default', () => {
    expect(resolveMinApyDeltaBips(CHAIN_ID, VAULT, MARKET, 25)).toBe(25)
  })

  it('applies market > vault precedence', () => {
    vaultMinApyDeltaBips[CHAIN_ID] = { [VAULT]: 50 }
    expect(resolveMinApyDeltaBips(CHAIN_ID, VAULT, MARKET, 25)).toBe(50)
    marketMinApyDeltaBips[CHAIN_ID] = { [MARKET]: 75 }
    expect(resolveMinApyDeltaBips(CHAIN_ID, VAULT, MARKET, 25)).toBe(75)
  })
})

describe('resolveMinUtilizationDeltaBips', () => {
  it('prefers a vault override over the caller-provided default', () => {
    expect(resolveMinUtilizationDeltaBips(CHAIN_ID, VAULT, 250)).toBe(250)
    vaultMinUtilizationDeltaBips[CHAIN_ID] = { [VAULT]: 100 }
    expect(resolveMinUtilizationDeltaBips(CHAIN_ID, VAULT, 250)).toBe(100)
  })
})
