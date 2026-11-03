import type { Logger } from '@repo/kit'
import type { Hex } from 'viem'

import { describe, expect, it } from 'vitest'

import type { Whitelist, WorldDeps } from '../src/sources'

import { readWorld } from '../src/sources'
import { EXECUTOR, FAR_MATURITY, marketIdAt, outAt, positionKey, unhealthy } from './scenario/bot'

const HEAD = { number: 7, hash: '0x7' as Hex }

const log = () => {}
const logger: Logger = { debug: log, info: log, warn: log, error: log }

const [open, healthy, unlisted] = [unhealthy(0, 1), unhealthy(0, 2), unhealthy(1, 3)]
const keyOf = (position: typeof open) => positionKey(position.market, position.borrower)
const listing = (markets: readonly number[]): Whitelist => ({
  isListed: id => markets.some(market => marketIdAt(market) === id),
  fresh: markets.length > 0 ? 1 : 0,
  maxAgeMs: 600_000,
  sources: []
})

const deps = (overrides: Partial<WorldDeps> = {}): WorldDeps => ({
  discover: async () => ({
    candidates: [open, healthy, unlisted].map(position => ({
      marketId: marketIdAt(position.market),
      borrower: position.borrower
    })),
    complete: true
  }),
  readLens: async pairs =>
    new Map(
      pairs.map(pair => {
        const position = [open, healthy, unlisted].find(p => p.borrower === pair.borrower)!
        const out = outAt(position, 14n, FAR_MATURITY)
        return [keyOf(position), position === healthy ? { ...out, healthy: true } : out]
      })
    ),
  caller: EXECUTOR,
  logger,
  ...overrides
})

describe('a world read', () => {
  it('reads only listed markets, and vouches for the whole scope when both reads covered it', async () => {
    let asked: readonly unknown[] = []
    const { write, pairs } = await readWorld(
      HEAD,
      listing([0]),
      deps({
        readLens: async (lensPairs, at) => {
          asked = lensPairs
          return deps().readLens(lensPairs, at)
        }
      })
    )
    expect(pairs).toBe(2)
    expect(asked).toMatchObject([{ caller: EXECUTOR }, { caller: EXECUTOR }])
    expect(write).toMatchObject({
      coverage: 'complete',
      basis: { block: 7, blockHash: '0x7' },
      entries: { [keyOf(open)]: { borrower: open.borrower, block: 7 } }
    })
    expect(Object.keys('entries' in write ? write.entries : {})).toStrictEqual([keyOf(open)])
  })

  it('vouches for no absence while no markets source is fresh, so its scope is unknown', async () => {
    let discovered = false
    const { write, pairs } = await readWorld(
      HEAD,
      listing([]),
      deps({
        discover: async () => {
          discovered = true
          return deps().discover()
        }
      })
    )
    expect(write).toStrictEqual({ coverage: 'unknown', reason: 'whitelist' })
    expect(pairs).toBe(0)
    expect(discovered).toBe(false)
  })

  it('fails without naming any position when discovery fails, so none becomes absent', async () => {
    const { write } = await readWorld(
      HEAD,
      listing([0]),
      deps({ discover: () => Promise.reject(new Error('down')) })
    )
    expect(write).toStrictEqual({ coverage: 'failed', reason: 'discovery' })
  })

  it('carries only what it read when discovery was cut short', async () => {
    const { write } = await readWorld(
      HEAD,
      listing([0]),
      deps({
        discover: async () => ({
          candidates: [open, healthy].map(position => ({
            marketId: marketIdAt(position.market),
            borrower: position.borrower
          })),
          complete: false
        })
      })
    )
    expect(write).toMatchObject({ coverage: 'carried', absent: [keyOf(healthy)], failed: [] })
  })

  it('reads a pair the lens did not answer as failed, never as absent', async () => {
    const { write } = await readWorld(
      HEAD,
      listing([0]),
      deps({
        readLens: async pairs =>
          new Map(
            (await deps().readLens(pairs, HEAD)).entries().filter(([key]) => key === keyOf(open))
          )
      })
    )
    expect(write).toMatchObject({ coverage: 'carried', absent: [], failed: [keyOf(healthy)] })
  })

  it('fails without naming any position when the lens refuses the pinned block', async () => {
    let pinned: unknown
    const { write } = await readWorld(
      HEAD,
      listing([0]),
      deps({
        readLens: (_pairs, at) => {
          pinned = at
          return Promise.reject(new Error('header not found'))
        }
      })
    )
    expect(pinned).toStrictEqual(HEAD)
    expect(write).toStrictEqual({ coverage: 'failed', reason: 'lens' })
  })
})
