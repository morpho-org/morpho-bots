import { describe, expect, it } from 'vitest'

import {
  computeHumanApprovals,
  evaluateReleaseGate,
  type ReviewLike
} from '../../src/release-intent/gate'

const T = (hour: number) => `2026-09-09T${String(hour).padStart(2, '0')}:00:00Z`
const review = (login: string, state: string, hour: number, type?: string): ReviewLike => ({
  user: { login, type },
  state,
  submitted_at: T(hour)
})
const MERGED_AT = T(20)

describe('computeHumanApprovals', () => {
  it('keeps the latest verdict per reviewer and drops the author and bots', () => {
    const approvals = computeHumanApprovals(
      [
        review('alice', 'APPROVED', 10),
        review('bob', 'APPROVED', 11),
        review('bob', 'CHANGES_REQUESTED', 12),
        review('author', 'APPROVED', 13),
        review('robot', 'APPROVED', 14, 'Bot'),
        review('carol', 'COMMENTED', 15)
      ],
      'author',
      MERGED_AT
    )
    expect(approvals).toEqual([{ login: 'alice', submittedAt: T(10) }])
  })

  it('lets a later APPROVED supersede an earlier CHANGES_REQUESTED, not vice versa', () => {
    expect(
      computeHumanApprovals(
        [review('bob', 'CHANGES_REQUESTED', 10), review('bob', 'APPROVED', 11)],
        'author'
      )
    ).toEqual([{ login: 'bob', submittedAt: T(11) }])
  })

  it('ignores COMMENTED reviews when deciding the latest verdict', () => {
    expect(
      computeHumanApprovals([review('bob', 'APPROVED', 10), review('bob', 'COMMENTED', 11)], 'a')
    ).toEqual([{ login: 'bob', submittedAt: T(10) }])
  })

  it('ignores reviews submitted after the merge-time cutoff', () => {
    expect(computeHumanApprovals([review('bob', 'APPROVED', 21)], 'author', MERGED_AT)).toEqual([])
  })

  it('on an equal timestamp the later element wins', () => {
    expect(
      computeHumanApprovals(
        [review('bob', 'APPROVED', 10), review('bob', 'CHANGES_REQUESTED', 10)],
        'author'
      )
    ).toEqual([])
  })
})

describe('evaluateReleaseGate', () => {
  const approvals = [{ login: 'bob', submittedAt: T(12) }]

  it('authorizes intent that predates an approval', () => {
    const result = evaluateReleaseGate({
      intentBots: ['quoter-bot'],
      intentTimes: new Map([['quoter-bot', T(11)]]),
      approvals
    })
    expect(result.authorized).toEqual(['quoter-bot'])
    expect(result.refused.size).toBe(0)
  })

  it('refuses intent added after the last approval', () => {
    const result = evaluateReleaseGate({
      intentBots: ['quoter-bot'],
      intentTimes: new Map([['quoter-bot', T(13)]]),
      approvals
    })
    expect(result.authorized).toEqual([])
    expect(result.refused.get('quoter-bot')).toMatch(/no approval .* after the intent/)
  })

  it('refuses intent added in the same instant as the approval', () => {
    const result = evaluateReleaseGate({
      intentBots: ['quoter-bot'],
      intentTimes: new Map([['quoter-bot', T(12)]]),
      approvals
    })
    expect(result.authorized).toEqual([])
  })

  it('refuses a bot with no body-history intent even if the commit names it', () => {
    const result = evaluateReleaseGate({
      intentBots: ['blue-liq'],
      intentTimes: new Map(),
      approvals
    })
    expect(result.refused.get('blue-liq')).toMatch(/not in the PR body history/)
  })

  it('refuses everything when there are no approvals', () => {
    const result = evaluateReleaseGate({
      intentBots: ['blue-liq', 'quoter-bot'],
      intentTimes: new Map([
        ['blue-liq', T(1)],
        ['quoter-bot', T(1)]
      ]),
      approvals: []
    })
    expect(result.authorized).toEqual([])
    expect([...result.refused.keys()]).toEqual(['blue-liq', 'quoter-bot'])
  })

  it('judges each bot independently', () => {
    const result = evaluateReleaseGate({
      intentBots: ['blue-liq', 'quoter-bot'],
      intentTimes: new Map([
        ['blue-liq', T(11)],
        ['quoter-bot', T(13)]
      ]),
      approvals
    })
    expect(result.authorized).toEqual(['blue-liq'])
    expect([...result.refused.keys()]).toEqual(['quoter-bot'])
  })
})
