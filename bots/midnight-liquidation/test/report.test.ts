import { describe, expect, it } from 'vitest'

import { classifyWorld } from '../src/report'

const plan = { collateralIndex: 0, seizedAssets: 1n, repaidUnits: 1n }
const writeOff = { collateralIndex: 0, seizedAssets: 0n, repaidUnits: 0n }
const present = (value: unknown) => ({ status: 'present', value, digest: 'd', basis: 1 })
const keyed = (keys: Record<string, unknown>) =>
  ({ coverage: { status: 'complete' }, absentBasis: 1, keys }) as never

const sizing = keyed({
  '0xm:0xbusy': present({ plans: [plan], skips: [] }),
  '0xm:0xbacked': present({ plans: [plan], skips: [] }),
  '0xm:0xwriteoff': present({ plans: [writeOff], skips: [] }),
  '0xm:0xramp': present({
    plans: [plan],
    skips: [{ reason: 'insufficient_headroom', collateralIndex: 1 }]
  }),
  '0xm:0xdust': present({
    plans: [],
    skips: [{ reason: 'seize_rounds_to_zero', collateralIndex: 0 }]
  })
})
const held = (status: 'present' | 'absent') =>
  keyed(
    Object.fromEntries(
      ['0xbusy', '0xbacked', '0xwriteoff', '0xramp', '0xdust'].map(borrower => [
        `0xm:${borrower}`,
        status === 'present' ? present({}) : { status, basis: 1 }
      ])
    )
  )

describe('classifying a world read', () => {
  it('counts each position once, backed off for its own task, and keeps every idle one', () => {
    const { idle, ...counts } = classifyWorld({
      sizing,
      liquidatable: held('present'),
      view: {
        busy: ['0xm:0xbusy'],
        numReservations: 1,
        acceptingNewWork: true,
        conflictMarks: {},
        oldestPendingMs: 0,
        pendingAtCeiling: 0
      },
      backoff: {
        block: 10,
        keys: {
          '0xm:0xbacked': { liquidate: { failures: 1, until: 12 } },
          '0xm:0xwriteoff': { liquidate: { failures: 1, until: 12 } }
        }
      }
    })
    expect(counts).toStrictEqual({
      liquidatable: 5,
      inflightSkipped: 1,
      planSkipped: 1,
      planned: 3,
      backoffSkipped: 1
    })
    expect(idle.map(({ key }) => key)).toStrictEqual([
      '0xm:0xbacked',
      '0xm:0xwriteoff',
      '0xm:0xramp',
      '0xm:0xdust'
    ])
  })

  it('counts nothing once the whitelist expires, though the last read is still held', () => {
    expect(classifyWorld({ sizing, liquidatable: held('absent') })).toMatchObject({
      liquidatable: 0,
      planned: 0,
      idle: []
    })
  })

  it('counts nothing before the first read', () => {
    expect(classifyWorld({})).toMatchObject({ liquidatable: 0, planned: 0, idle: [] })
  })
})
