import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import { BootstrapAdapterError } from '../../../src/infrastructure/bootstrap/bootstrap-adapter.error'
import {
  assertBootstrapProspectiveSpread,
  bootstrapMarketGroupIds
} from '../../../src/infrastructure/bootstrap/bootstrap-spread.utils'

const marketId: Hex = `0x${'aa'.repeat(32)}`
const otherMarketId: Hex = `0x${'bb'.repeat(32)}`
const groupOne: Hex = `0x${'11'.repeat(32)}`
const groupTwo: Hex = `0x${'22'.repeat(32)}`

const group = (id: Hex, market: Hex) => ({ id, marketId: market, assets: 1n, rateBps: 100n })

describe('bootstrapMarketGroupIds', () => {
  test('selects only groups owned by the requested market', () => {
    const groups = [group(groupOne, marketId), group(groupTwo, otherMarketId)]

    expect(bootstrapMarketGroupIds(groups, marketId)).toEqual(new Set([groupOne]))
  })

  test('rejects a group shared with another market', () => {
    const groups = [group(groupOne, marketId), group(groupOne, otherMarketId)]

    let caught: unknown
    try {
      bootstrapMarketGroupIds(groups, marketId)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(BootstrapAdapterError)
    expect((caught as BootstrapAdapterError).operation).toBe('shared-group-reconciliation')
  })
})

describe('assertBootstrapProspectiveSpread', () => {
  test('accepts a prospective buy strictly below every retained sell', () => {
    expect(() =>
      assertBootstrapProspectiveSpread({
        marketId,
        replacedGroupIds: new Set(),
        book: [{ marketId, buy: false, tick: 10n }],
        prospective: { marketId, buy: true, tick: 9n }
      })
    ).not.toThrow()
  })

  test('rejects a prospective buy at or above the lowest retained sell', () => {
    let caught: unknown
    try {
      assertBootstrapProspectiveSpread({
        marketId,
        replacedGroupIds: new Set(),
        book: [{ marketId, buy: false, tick: 10n }],
        prospective: { marketId, buy: true, tick: 10n }
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(BootstrapAdapterError)
    expect((caught as BootstrapAdapterError).operation).toBe('negative-spread')
  })

  test('ignores sells owned by replaced groups', () => {
    expect(() =>
      assertBootstrapProspectiveSpread({
        marketId,
        replacedGroupIds: new Set([groupOne]),
        book: [{ groupId: groupOne, marketId, buy: false, tick: 3n }],
        prospective: { marketId, buy: true, tick: 5n }
      })
    ).not.toThrow()
  })
})
