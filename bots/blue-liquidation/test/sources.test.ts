import type { Keyed } from '@repo/engine'
import type { Logger } from '@repo/kit'
import type { QuoteOutcome, SwapPlan } from '@repo/swaps'

import { digestOf, keyRecord } from '@repo/engine'
import { describe, expect, it } from 'vitest'

import type { PositionReading } from '../src/liquidation'
import type { PositionQuote, QuoteDeps, WorldDeps } from '../src/sources'
import type { LensOut } from '../src/state/lens.sol'

import { sizePosition } from '../src/liquidation'
import { covers, quotesDue, quotesGone, readQuote, readWorld } from '../src/sources'
import { createTickStats } from '../src/stats'
import { borrowerAt, market, MARKET_ID, positionKey } from './scenario/bot'

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const HEAD = { number: 7, hash: '0x7' }

const reading = (liquidatable: boolean, valid = true): LensOut => ({
  valid,
  hasDebt: true,
  healthy: !liquidatable,
  blockTimestamp: 14n,
  borrowShares: 1n,
  collateral: 1n,
  accruedTotalBorrowAssets: 1n,
  totalBorrowShares: 1n,
  collateralPrice: 1n,
  lltv: market.lltv,
  params: market
})

const [open, healthy] = [borrowerAt(1), borrowerAt(2)]

const deps = (overrides: Partial<WorldDeps> = {}): WorldDeps => ({
  discover: async () => ({
    candidates: [open, healthy].map(borrower => ({ marketParams: market, borrower })),
    complete: true
  }),
  readLens: async () =>
    new Map([
      [positionKey(open), reading(true)],
      [positionKey(healthy), reading(false)]
    ]),
  logger: silent,
  ...overrides
})

describe('a world read', () => {
  it('vouches for the whole scope when discovery and the lens both covered it', async () => {
    const { write, pairs } = await readWorld(HEAD, deps())
    expect(pairs).toBe(2)
    expect(write).toMatchObject({
      coverage: 'complete',
      basis: { block: 7, blockHash: '0x7' },
      entries: { [positionKey(open)]: { borrower: open, block: 7 } }
    })
    expect(Object.keys('entries' in write ? write.entries : {})).toStrictEqual([positionKey(open)])
  })

  it('fails without naming any position when discovery fails, so none becomes absent', async () => {
    const { write } = await readWorld(
      HEAD,
      deps({ discover: () => Promise.reject(new Error('down')) })
    )
    expect(write).toStrictEqual({ coverage: 'failed', reason: 'discovery' })
  })

  it('carries only what it read when discovery was cut short or the lens answered part of it', async () => {
    for (const overrides of [
      {
        discover: async () => ({
          candidates: [open, healthy].map(borrower => ({ marketParams: market, borrower })),
          complete: false
        })
      },
      { readLens: async () => new Map([[positionKey(healthy), reading(false)]]) }
    ]) {
      const { write } = await readWorld(HEAD, deps(overrides))
      expect(write).toMatchObject({ coverage: 'carried', absent: [positionKey(healthy)] })
    }
  })

  it('carries what it read when the lens answers under keys it was not asked for', async () => {
    const { write } = await readWorld(
      HEAD,
      deps({ readLens: async () => new Map([['elsewhere', reading(true)]]) })
    )
    expect(write).toStrictEqual({
      coverage: 'carried',
      entries: {},
      absent: [],
      failed: [positionKey(open), positionKey(healthy)],
      basis: { block: 7, blockHash: '0x7' }
    })
  })

  it('reads a pair the lens could not read as failed, never as absent', async () => {
    const { write } = await readWorld(
      HEAD,
      deps({
        readLens: async () =>
          new Map([
            [positionKey(open), reading(true)],
            [positionKey(healthy), reading(false, false)]
          ])
      })
    )
    expect(write).toMatchObject({ coverage: 'carried', absent: [], failed: [positionKey(healthy)] })
  })

  it('fails without naming any position when the lens refuses the pinned block', async () => {
    let pinned: unknown
    const { write } = await readWorld(
      HEAD,
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

const BASIS = { block: 7, blockHash: '0x7' }
const sizeable = (collateral: bigint): LensOut => ({
  ...reading(true),
  borrowShares: 10n ** 24n,
  collateral,
  accruedTotalBorrowAssets: 10n ** 18n,
  totalBorrowShares: 10n ** 24n,
  collateralPrice: 10n ** 36n
})
const positionOf = (borrower: ReturnType<typeof borrowerAt>, out: LensOut): PositionReading => ({
  marketId: MARKET_ID,
  borrower,
  out,
  block: 7
})
const keyed = <T>(entries: Record<string, { value: T; expiry?: number }>): Keyed<T> => ({
  coverage: { status: 'complete' },
  absentBasis: BASIS,
  keys: Object.fromEntries(
    Object.entries(entries).map(([key, { value, expiry }]) => [
      key,
      {
        status: 'present',
        value,
        digest: digestOf(value as never),
        basis: BASIS,
        ...(expiry !== undefined && { expiry })
      }
    ])
  )
})
const swap: SwapPlan = { steps: [], expectedAmountOut: 1n, amountOutMinimum: 1n }

describe('scheduling quotes', () => {
  const [a, b] = [borrowerAt(1), borrowerAt(2)]
  const [ka, kb] = [positionKey(a), positionKey(b)]
  const outs = { [ka]: sizeable(10n ** 18n), [kb]: sizeable(2n * 10n ** 18n) }
  const positions = keyed({
    [ka]: { value: positionOf(a, outs[ka]!) },
    [kb]: { value: positionOf(b, outs[kb]!) }
  })
  const seizeOf = (key: string) => sizePosition(outs[key]!).plan!.seizedAssets
  const route = (seizedAssets: bigint): PositionQuote => ({ kind: 'route', seizedAssets, swap })
  const failed = (failures: number, until: number): PositionQuote => ({
    kind: 'failed',
    reason: 'no_route',
    failures,
    until
  })
  const at = (now: number, held: readonly string[] = []) => ({ held, slots: 4, now })
  const keysDue = (...args: Parameters<typeof quotesDue>) =>
    quotesDue(...args)
      .map(r => r.key)
      .toSorted()

  it('quotes the least healthy positions not held first, within its slots', () => {
    const due = quotesDue(positions, keyed({}), { held: [], slots: 1, now: 0 })
    expect(due.map(request => request.key)).toStrictEqual([ka])
    expect(due[0]).toStrictEqual({ key: ka, reading: positionOf(a, outs[ka]!), failures: 0 })
    expect(keysDue(positions, keyed({}), at(0, [ka]))).toStrictEqual([kb])
  })

  it('ranks a large position with a 6-decimal loan token above dust with an 18-decimal one', () => {
    const large: LensOut = {
      ...reading(true),
      borrowShares: 10n ** 18n,
      collateral: 552n * 10n ** 18n,
      accruedTotalBorrowAssets: 1_000_000n * 10n ** 6n,
      totalBorrowShares: 10n ** 18n,
      collateralPrice: 2n * 10n ** 27n
    }
    const dust: LensOut = {
      ...reading(true),
      borrowShares: 10n ** 21n,
      collateral: 114n * 10n ** 13n,
      accruedTotalBorrowAssets: 10n ** 15n,
      totalBorrowShares: 10n ** 21n,
      collateralPrice: 10n ** 36n
    }
    const both = keyed({
      [ka]: { value: positionOf(a, dust) },
      [kb]: { value: positionOf(b, large) }
    })
    expect(sizePosition(dust).plan).not.toBeNull()
    expect(sizePosition(large).plan).not.toBeNull()
    expect(quotesDue(both, keyed({}), { held: [], slots: 1, now: 0 })[0]?.key).toBe(kb)
  })

  it('quotes again only once a route expires or no longer covers its seize', () => {
    const covered = keyed({
      [ka]: { value: route(seizeOf(ka)), expiry: 100 },
      [kb]: { value: route(seizeOf(kb)), expiry: 200 }
    })
    expect(quotesDue(positions, covered, at(99))).toStrictEqual([])
    expect(keysDue(positions, covered, at(100))).toStrictEqual([ka])
    const drifted = keyed({
      [ka]: { value: route((seizeOf(ka) * 99n) / 100n), expiry: 100 },
      [kb]: { value: route(seizeOf(kb) + 1n), expiry: 100 }
    })
    expect(keysDue(positions, drifted, at(0))).toStrictEqual([ka, kb].toSorted())
  })

  it('waits out a failed quote until its block, and carries how many failed running', () => {
    const quotes = keyed({ [ka]: { value: failed(2, 8) }, [kb]: { value: failed(1, 7) } })
    expect(quotesDue(positions, quotes, at(0))).toStrictEqual([
      { key: kb, reading: positionOf(b, outs[kb]!), failures: 1 }
    ])
    const later = keyed({
      [ka]: { value: { ...positionOf(a, outs[ka]!), block: 8 } },
      [kb]: { value: { ...positionOf(b, outs[kb]!), block: 8 } }
    })
    expect(quotesDue(later, quotes, at(0)).map(r => [r.key, r.failures])).toStrictEqual([
      [ka, 2],
      [kb, 1]
    ])
  })

  it('marks each lost position absent once, keeping a failed quote through its wait and one maximum wait after', () => {
    const policy = { baseBlocks: 2, maxBlocks: 64 }
    const kc = positionKey(borrowerAt(3))
    const held = keyed({ [ka]: { value: failed(3, 20) }, [kb]: { value: route(1n) } })
    const quotes = {
      ...held,
      keys: { ...held.keys, [kc]: keyRecord(keyed<PositionQuote>({}), kc) }
    }
    const lost = keyed<PositionReading>({})
    expect(quotesGone(quotes, lost, { block: 83, policy })).toStrictEqual([kb])
    expect(quotesGone(quotes, lost, { block: 84, policy })).toStrictEqual([ka, kb])
    expect(quotesGone(quotes, positions, { block: 84, policy })).toStrictEqual([])
  })

  it('never quotes a position its preparations or the kernel backed off, until that passes', () => {
    const keys = { [ka]: { liquidate: { failures: 1, until: 9 } } }
    expect(keysDue(positions, keyed({}), { ...at(0), backoff: { block: 7, keys } })).toStrictEqual([
      kb
    ])
    expect(keysDue(positions, keyed({}), { ...at(0), backoff: { block: 9, keys } })).toStrictEqual(
      [ka, kb].toSorted()
    )
  })

  it('never quotes a position whose world read has expired, even when a failed read kept it', () => {
    const stale = keyed({
      [ka]: { value: positionOf(a, outs[ka]!), expiry: 50 },
      [kb]: { value: positionOf(b, outs[kb]!), expiry: 200 }
    })
    expect(keysDue(stale, keyed({}), at(100))).toStrictEqual([kb])
  })
})

describe('covering a seize', () => {
  const route = (seizedAssets: bigint): PositionQuote => ({ kind: 'route', seizedAssets, swap })

  it('covers a seize it does not exceed and trails by at most 50 bps', () => {
    expect(covers(route(10_000n), 10_000n)).toBe(true)
    expect(covers(route(9_950n), 10_000n)).toBe(true)
    expect(covers(route(9_949n), 10_000n)).toBe(false)
    expect(covers(route(10_001n), 10_000n)).toBe(false)
  })
})

describe('reading a quote', () => {
  const borrower = borrowerAt(1)
  const request = {
    key: positionKey(borrower),
    reading: positionOf(borrower, sizeable(10n ** 18n)),
    failures: 0
  }
  const depsOf = (quoteFor: QuoteDeps['quoteFor']): QuoteDeps => ({
    quoteFor,
    timeoutMs: 50,
    backoff: { baseBlocks: 2, maxBlocks: 64 },
    stats: createTickStats(),
    logger: silent
  })
  const firstFailure = (reason: string): PositionQuote => ({
    kind: 'failed',
    reason,
    failures: 1,
    until: 9
  })

  it('reads a route for the seize it was asked, and every failure as a quote', async () => {
    const seize = sizePosition(request.reading.out).plan!.seizedAssets
    expect(
      await readQuote(
        request,
        depsOf(async () => ({ kind: 'swap', plan: swap }))
      )
    ).toStrictEqual({ kind: 'route', seizedAssets: seize, swap })
    const answers: [QuoteDeps['quoteFor'], PositionQuote][] = [
      [async () => ({ kind: 'no_config' }), { kind: 'no_swap_path' }],
      [
        async () => ({ kind: 'failed', reason: 'no_route' }) as QuoteOutcome,
        firstFailure('no_route')
      ],
      [
        async () => {
          throw new Error('down')
        },
        firstFailure('error')
      ],
      [() => new Promise(() => {}), firstFailure('error')],
      [
        async () => ({
          kind: 'swap',
          plan: {
            ...swap,
            steps: [
              {
                tokenIn: borrower,
                tokenOut: borrower,
                target: borrower,
                value: 1n,
                callData: '0x',
                amountIn: { source: 'fixed', value: 1n }
              }
            ]
          }
        }),
        firstFailure('native_value')
      ]
    ]
    for (const [quoteFor, quote] of answers)
      expect(await readQuote(request, depsOf(quoteFor))).toStrictEqual(quote)
  })

  it('backs a failing position off from its reading, doubling to the cap', async () => {
    const down = depsOf(async () => {
      throw new Error('down')
    })
    const untils = []
    for (const failures of [1, 2, 5, 6, 40]) {
      const quote = await readQuote({ ...request, failures }, down)
      untils.push(quote.kind === 'failed' && [quote.failures, quote.until])
    }
    expect(untils).toStrictEqual([
      [2, 11],
      [3, 15],
      [6, 7 + 64],
      [7, 7 + 64],
      [41, 7 + 64]
    ])
  })
})
