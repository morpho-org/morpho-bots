import { describe, expect, it } from 'vitest'

import { mergeTakeLegs } from '../../src/pollers/take'
import { borrowItem, exitPrimaryItem, lendItem } from '../midnight/fixtures'

describe('mergeTakeLegs', () => {
  it('folds the two legs of one take into a single entry at the first leg position', () => {
    const lend = lendItem({ id: 'l', created_at: 100 })
    const borrow = borrowItem({ id: 'b', created_at: 100 })
    const exit = exitPrimaryItem({ id: 'e' })
    expect(mergeTakeLegs([lend, exit, borrow])).toEqual([
      { kind: 'take', lend, borrow },
      { kind: 'item', item: exit }
    ])
  })

  it('assigns lend/borrow roles by event type regardless of arrival order', () => {
    const lend = lendItem({ id: 'l', created_at: 100 })
    const borrow = borrowItem({ id: 'b', created_at: 100 })
    expect(mergeTakeLegs([borrow, lend])).toEqual([{ kind: 'take', lend, borrow }])
  })

  it('leaves legs unpaired when a trade-scoped field differs', () => {
    const lend = lendItem({ id: 'l', created_at: 100, assets: '1000' })
    const borrow = borrowItem({ id: 'b', created_at: 100, assets: '2000' })
    expect(mergeTakeLegs([lend, borrow])).toEqual([
      { kind: 'item', item: lend },
      { kind: 'item', item: borrow }
    ])
  })

  it('pairs indistinguishable takes one-to-one instead of lumping them', () => {
    const lend1 = lendItem({ id: 'l1', created_at: 100 })
    const lend2 = lendItem({ id: 'l2', created_at: 100 })
    const borrow1 = borrowItem({ id: 'b1', created_at: 100 })
    const borrow2 = borrowItem({ id: 'b2', created_at: 100 })
    expect(mergeTakeLegs([lend1, lend2, borrow1, borrow2])).toEqual([
      { kind: 'take', lend: lend1, borrow: borrow1 },
      { kind: 'take', lend: lend2, borrow: borrow2 }
    ])
  })

  it('never pairs two legs of the same type', () => {
    const lend1 = lendItem({ id: 'l1', created_at: 100 })
    const lend2 = lendItem({ id: 'l2', created_at: 100 })
    expect(mergeTakeLegs([lend1, lend2])).toEqual([
      { kind: 'item', item: lend1 },
      { kind: 'item', item: lend2 }
    ])
  })
})
