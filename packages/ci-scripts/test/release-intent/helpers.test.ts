import { describe, expect, it } from 'vitest'

import {
  deriveBodyIntentTimes,
  findMergedPullRequest,
  parseReleaseIntents
} from '../../src/release-intent/helpers'
import bodyIntentFixture from './__fixtures__/body-intent-cases.json'
import fixture from './__fixtures__/parse-cases.json'

// The fixtures are byte-identical to prime-monorepo's so the grammar stays shared. Prime excludes
// `storybook-app` by policy; here the same case holds because an unknown token never matches.
const KNOWN = new Set(fixture.knownApps.filter(app => app !== 'storybook-app'))

describe('parseReleaseIntents (golden fixture)', () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      expect(parseReleaseIntents(c.text, KNOWN)).toEqual(c.expected)
    })
  }

  it('handles a null body', () => {
    expect(parseReleaseIntents(null, KNOWN)).toEqual([])
  })

  it('ignores intent hidden in an HTML comment', () => {
    expect(parseReleaseIntents('<!-- Releases markets-app -->', KNOWN)).toEqual([])
    expect(
      parseReleaseIntents('<!--\nReleases markets-app\n-->\nReleases delegate-app', KNOWN)
    ).toEqual(['delegate-app'])
  })

  it('matches the real bot ids', () => {
    const bots = new Set(['blue-liq', 'midnight-liq', 'crossed-books', 'quoter-bot'])
    expect(parseReleaseIntents('Releases quoter-bot and midnight-liq.', bots)).toEqual([
      'midnight-liq',
      'quoter-bot'
    ])
    expect(parseReleaseIntents('Releases blue-liquidation', bots)).toEqual([])
  })
})

describe('deriveBodyIntentTimes (golden fixture)', () => {
  const knownBots = new Set(bodyIntentFixture.knownApps)

  for (const c of bodyIntentFixture.cases) {
    it(c.name, () => {
      expect(
        Object.fromEntries(
          deriveBodyIntentTimes({
            createdAt: c.createdAt,
            currentBody: c.currentBody,
            revisions: c.revisions,
            knownBots,
            until: c.until
          })
        )
      ).toEqual(c.expected)
    })
  }

  it('uses createdAt and the current body when history is empty', () => {
    expect(
      deriveBodyIntentTimes({
        createdAt: '2026-06-01T10:00:00Z',
        currentBody: 'Releases markets-app',
        revisions: [],
        knownBots
      })
    ).toEqual(new Map([['markets-app', '2026-06-01T10:00:00Z']]))
  })
})

describe('findMergedPullRequest', () => {
  const sha = '0b9c90a04c763e13bbc4e2e1947b2ae2b40bb1af'
  const merged = { number: 42, merge_commit_sha: sha, merged_at: '2026-08-20T13:20:39Z' }

  it('binds a merged PR whose merge commit is the SHA', () => {
    expect(findMergedPullRequest([merged], sha)).toEqual(merged)
  })

  it.each([
    { name: 'no merged_at', pull: { ...merged, merged_at: null } },
    { name: 'different merge commit', pull: { ...merged, merge_commit_sha: 'other' } }
  ])('does not bind $name', ({ pull }) => {
    expect(findMergedPullRequest([pull], sha)).toBeUndefined()
  })
})
