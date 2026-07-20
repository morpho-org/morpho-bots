import { describe, expect, it } from 'bun:test'

import { addLogicalGroup, getLogicalGroup } from '../src/registry'

const BUY = `0x${'11'.repeat(32)}` as const
const SELL = `0x${'22'.repeat(32)}` as const

describe('logical group registry', () => {
  it('stores both content-addressed protocol groups', () => {
    const registry = addLogicalGroup({}, 'desk-a', {
      chainId: 8453,
      maker: '0x1111111111111111111111111111111111111111',
      protocolGroups: [BUY, SELL],
      artifact: '/tmp/desk-a.json',
      createdAt: '2026-07-20T00:00:00.000Z'
    })

    expect(getLogicalGroup(registry, 'desk-a').protocolGroups).toEqual([BUY, SELL])
  })

  it('rejects reuse so previous protocol groups cannot be orphaned', () => {
    const first = addLogicalGroup({}, 'desk-a', {
      chainId: 8453,
      maker: '0x1111111111111111111111111111111111111111',
      protocolGroups: [BUY, SELL],
      artifact: '/tmp/desk-a.json',
      createdAt: '2026-07-20T00:00:00.000Z'
    })

    expect(() =>
      addLogicalGroup(first, 'desk-a', {
        chainId: 8453,
        maker: '0x1111111111111111111111111111111111111111',
        protocolGroups: [BUY, SELL],
        artifact: '/tmp/desk-a-2.json',
        createdAt: '2026-07-20T00:01:00.000Z'
      })
    ).toThrow('Logical group "desk-a" already exists')
  })
})
