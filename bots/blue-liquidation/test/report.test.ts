import { describe, expect, it } from 'vitest'

import { classifyWorld } from '../src/report'

const plan = { seizedAssets: 1n, impliedRepaidAssets: 1n }
const present = (value: unknown) => ({ status: 'present', value, digest: 'd', basis: 1 })

describe('classifying a world read', () => {
  it('counts each position once and keeps why a plan was skipped', () => {
    expect(
      classifyWorld({
        sizing: {
          coverage: { status: 'complete' },
          absentBasis: 1,
          keys: {
            '0xm:0xbusy': present({ plan }),
            '0xm:0xbacked': present({ plan }),
            '0xm:0xready': present({ plan }),
            '0xm:0xdust': present({ plan: null, reason: 'seize_rounds_to_zero' })
          }
        } as never,
        view: {
          busy: ['0xm:0xbusy'],
          numReservations: 1,
          acceptingNewWork: true,
          conflictMarks: {},
          oldestPendingMs: 0,
          pendingAtCeiling: 0
        },
        backoff: { block: 10, keys: { '0xm:0xbacked': { liquidate: { failures: 1, until: 12 } } } }
      })
    ).toStrictEqual({
      liquidatable: 4,
      inflightSkipped: 1,
      planSkipped: 1,
      planned: 2,
      backoffSkipped: 1,
      skipped: [{ key: '0xm:0xdust', reason: 'seize_rounds_to_zero' }]
    })
  })

  it('counts nothing before the first read', () => {
    expect(classifyWorld({})).toMatchObject({ liquidatable: 0, planned: 0, skipped: [] })
  })
})
