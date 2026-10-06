import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import { BootstrapAdapterError } from '../../../src/infrastructure/bootstrap/bootstrap-adapter.error'
import { bootstrapMarketGroupIds } from '../../../src/infrastructure/bootstrap/bootstrap-spread.utils'

const marketId: Hex = `0x${'aa'.repeat(32)}`
const otherMarketId: Hex = `0x${'bb'.repeat(32)}`
const groupOne: Hex = `0x${'11'.repeat(32)}`
const groupTwo: Hex = `0x${'22'.repeat(32)}`

const group = (id: Hex, market: Hex) => ({
  id,
  marketId: market,
  assets: 1n,
  rateBps: 100n
})

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
