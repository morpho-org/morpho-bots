import type { KeyedWrite } from '@repo/engine'

import { defineBot } from '@repo/controller'
import { createRunner, keyedLevel } from '@repo/engine'
import { describe, expect, it } from 'vitest'

import type { Markets } from '../src/graph'
import type { PositionReading } from '../src/liquidation'

import { declareListedFacts } from '../src/graph'
import { FAR_MATURITY, marketIdAt, outAt, positionKey, unhealthy } from './scenario/bot'

const MAX_AGE_MS = 1_000
const READ_EXPIRY = 50_000
const position = unhealthy(0, 1)
const KEY = positionKey(0, position.borrower)

const facts = () => {
  const { graph, writes, markets, listed } = defineBot('listed-facts', b => {
    const { writes, markets, positions } = b.raw(g => {
      const writes = g.occurrences<KeyedWrite<PositionReading>>('reads')
      return {
        writes,
        markets: g.level<Markets>('markets'),
        positions: keyedLevel(g, 'positions', writes)
      }
    })
    return { writes, markets, listed: declareListedFacts(b, positions, markets, MAX_AGE_MS) }
  })({})
  const runner = createRunner(graph, { now: () => 0 })
  const list = (ids: readonly string[], updatedAt: number, others: Markets['sources'] = []) =>
    runner.push(markets, {
      value: { sources: [{ source: 'a', ids, updatedAt }, ...others], now: 10_000 },
      basis: { at: 10_000 }
    })
  runner.push(writes, {
    coverage: 'complete',
    entries: {
      [KEY]: {
        marketId: marketIdAt(0),
        borrower: position.borrower,
        out: outAt(position, 100n, FAR_MATURITY),
        block: 7
      }
    },
    basis: { block: 7, blockHash: '0x7' },
    expiry: READ_EXPIRY
  })
  return { list, fact: () => runner.read(listed)?.keys[KEY] }
}

describe('a position fact over the whitelist', () => {
  it('expires a listed position at the earlier of its read and its whitelist', () => {
    const { list, fact } = facts()
    list([marketIdAt(0).toLowerCase()], 9_500)
    expect(fact()).toMatchObject({ status: 'present', expiry: 10_500 })
    list([marketIdAt(0).toLowerCase()], READ_EXPIRY)
    expect(fact()).toMatchObject({ status: 'present', expiry: READ_EXPIRY })
  })

  it('expires a position with the last fresh source listing its market, not an older one', () => {
    const { list, fact } = facts()
    list([marketIdAt(0).toLowerCase()], 9_900, [{ source: 'b', ids: [], updatedAt: 9_500 }])
    expect(fact()).toMatchObject({ status: 'present', expiry: 10_900 })
  })

  it('reads a delisted position as absent until its read expires', () => {
    const { list, fact } = facts()
    list([], 9_500)
    expect(fact()).toStrictEqual({
      status: 'absent',
      basis: { block: 7, blockHash: '0x7' },
      expiry: READ_EXPIRY
    })
  })
})
