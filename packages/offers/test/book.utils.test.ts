import type { Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import { batchProspectiveBook, crossedMarketIds, hasNegativeSpread } from '../src/book.utils'

const marketA: Hex = `0x${'aa'.repeat(32)}`
const marketB: Hex = `0x${'bb'.repeat(32)}`
const groupOne: Hex = `0x${'11'.repeat(32)}`
const groupTwo: Hex = `0x${'22'.repeat(32)}`

describe('batchProspectiveBook', () => {
  test('keeps selected-market offers and appends every prospective offer', () => {
    const book = [
      { groupId: groupOne, marketId: marketA, buy: true, tick: -10n },
      { groupId: groupTwo, marketId: marketB, buy: false, tick: 5n }
    ]
    const prospective = [{ marketId: marketA, buy: false, tick: 4n }]

    expect(
      batchProspectiveBook({ marketId: marketA, replacedGroupIds: new Set(), book, prospective })
    ).toEqual([
      { groupId: groupOne, marketId: marketA, buy: true, tick: -10n },
      { marketId: marketA, buy: false, tick: 4n }
    ])
  })

  test('drops retained offers owned by a replaced group', () => {
    const book = [
      { groupId: groupOne, marketId: marketA, buy: true, tick: -10n },
      { groupId: groupTwo, marketId: marketA, buy: false, tick: 5n }
    ]

    expect(
      batchProspectiveBook({
        marketId: marketA,
        replacedGroupIds: new Set([groupOne]),
        book,
        prospective: []
      })
    ).toEqual([{ groupId: groupTwo, marketId: marketA, buy: false, tick: 5n }])
  })

  test('keeps groupless offers regardless of replaced groups', () => {
    const book = [{ marketId: marketA, buy: true, tick: -10n }]

    expect(
      batchProspectiveBook({
        marketId: marketA,
        replacedGroupIds: new Set([groupOne]),
        book,
        prospective: []
      })
    ).toEqual(book)
  })
})

describe('hasNegativeSpread', () => {
  test('reports a crossed book when the highest buy reaches the lowest sell', () => {
    expect(
      hasNegativeSpread([
        { buy: true, tick: 5n },
        { buy: false, tick: 5n }
      ])
    ).toBe(true)
    expect(
      hasNegativeSpread([
        { buy: true, tick: 6n },
        { buy: false, tick: 5n }
      ])
    ).toBe(true)
  })

  test('accepts a strictly positive spread', () => {
    expect(
      hasNegativeSpread([
        { buy: true, tick: 4n },
        { buy: false, tick: 5n }
      ])
    ).toBe(false)
  })

  test('never reports a one-sided or empty book', () => {
    expect(hasNegativeSpread([])).toBe(false)
    expect(hasNegativeSpread([{ buy: true, tick: 5n }])).toBe(false)
    expect(hasNegativeSpread([{ buy: false, tick: 5n }])).toBe(false)
  })
})

describe('crossedMarketIds', () => {
  test('reports only markets whose own book is crossed, in first-appearance order', () => {
    expect(
      crossedMarketIds([
        { marketId: marketA, buy: true, tick: 5n },
        { marketId: marketB, buy: true, tick: 1n },
        { marketId: marketA, buy: false, tick: 5n },
        { marketId: marketB, buy: false, tick: 2n }
      ])
    ).toEqual([marketA])
  })

  test('never mixes sides across markets', () => {
    expect(
      crossedMarketIds([
        { marketId: marketA, buy: true, tick: 10n },
        { marketId: marketB, buy: false, tick: 1n }
      ])
    ).toEqual([])
  })

  test('returns every crossed market once', () => {
    expect(
      crossedMarketIds([
        { marketId: marketA, buy: true, tick: 9n },
        { marketId: marketA, buy: true, tick: 8n },
        { marketId: marketA, buy: false, tick: 3n },
        { marketId: marketA, buy: false, tick: 4n }
      ])
    ).toEqual([marketA])
  })
})
