import type { KeyedWrite } from '@repo/engine'
import type { Logger } from '@repo/kit'
import type { PairCurve, VenuePair } from '@repo/swaps'

import { MAX_COST_LEVEL_AGE_MS, venuePairKey } from '@repo/swaps'
import { HttpRequestError } from 'viem'
import { describe, expect, it } from 'vitest'

import type { RouteSources } from '../src/routes'

import { routeKeyOf } from '../src/liquidation'
import {
  createCurveSource,
  createRouteResolver,
  ROUTE_MAX_AGE_MS,
  ROUTE_REFRESH_MS,
  routesDue,
  routeWriteOf
} from '../src/routes'
import { collateralAt, curveCosting, keyedOf, LOAN } from './scenario/bot'

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
const PAIR: VenuePair = { collateral: collateralAt(0), loan: LOAN }
const ROUTE = routeKeyOf(PAIR.collateral, LOAN)
const never = () => new AbortController().signal

const sources = (overrides: Partial<RouteSources> = {}): RouteSources => ({
  resolvePair: async (collateral, loan) => ({ collateral, loan }),
  sweep: async () => {},
  curveOf: () => curveCosting(10, 1_000),
  venues: ['0x'],
  ...overrides
})

describe('the route source', () => {
  const wanted = new Map([[ROUTE, { collateral: PAIR.collateral, loan: LOAN }]])

  it('asks for a route once while it is outstanding, and not again once it is known', () => {
    expect(routesDue(wanted, undefined, {}, 0).map(([key]) => key)).toStrictEqual([ROUTE])
    expect(routesDue(wanted, undefined, { [ROUTE]: { id: 0 } }, 0)).toStrictEqual([])
    const known = keyedOf({ [ROUTE]: { pair: PAIR, resolvedAt: 0 } })
    expect(routesDue(wanted, known, {}, ROUTE_REFRESH_MS - 1)).toStrictEqual([])
  })

  it('re-resolves a route past its refresh age, and its new pair replaces the old one', () => {
    const unwrapped = { collateral: collateralAt(9), loan: LOAN }
    const known = keyedOf({ [ROUTE]: { pair: PAIR, resolvedAt: 0 } })
    expect(routesDue(wanted, known, {}, ROUTE_REFRESH_MS).map(([key]) => key)).toStrictEqual([
      ROUTE
    ])
    expect(routeWriteOf({ id: 0, key: ROUTE, pair: unwrapped }, ROUTE_REFRESH_MS)).toStrictEqual({
      coverage: 'carried',
      entries: { [ROUTE]: { pair: unwrapped, resolvedAt: ROUTE_REFRESH_MS } },
      basis: { route: ROUTE },
      expiry: ROUTE_REFRESH_MS + ROUTE_MAX_AGE_MS
    })
  })

  it('writes nothing for a failed resolve, leaving a held route to its own expiry', () => {
    expect(routeWriteOf({ id: 0, key: ROUTE, failed: true }, ROUTE_REFRESH_MS)).toBeUndefined()
  })

  it('returns on abort while a resolve never settles', async () => {
    const stop = new AbortController()
    const run = createRouteResolver(sources({ resolvePair: () => new Promise(() => {}) }))(
      { id: 0, key: ROUTE, collateral: PAIR.collateral, loan: LOAN, at: 0 },
      stop.signal
    )
    stop.abort()
    await expect(run).resolves.toBeUndefined()
  })
})

describe('the curve source', () => {
  const sweep = async (overrides: Partial<RouteSources>, held?: PairCurve) => {
    const writes: KeyedWrite<PairCurve>[] = []
    await createCurveSource(sources(overrides), silent)(
      new Map([[venuePairKey(PAIR), PAIR]]),
      held && keyedOf({ [venuePairKey(PAIR)]: held }),
      write => writes.push(write),
      never()
    )
    return writes
  }

  it('writes the curve a sweep left, once per sweep', async () => {
    expect(await sweep({})).toStrictEqual([
      {
        coverage: 'carried',
        entries: { [venuePairKey(PAIR)]: curveCosting(10, 1_000) },
        basis: { at: 1_000 },
        expiry: 1_000 + MAX_COST_LEVEL_AGE_MS
      }
    ])
    expect(await sweep({}, curveCosting(10, 1_000))).toStrictEqual([])
  })

  it('writes failed for a sweep that threw or left no venue, and nothing while one is in flight', async () => {
    const key = venuePairKey(PAIR)
    expect(await sweep({ sweep: () => Promise.reject(new Error('429')) })).toStrictEqual([
      { coverage: 'failed', keys: [key], reason: 'sweep' }
    ])
    expect(
      await sweep({ curveOf: () => ({ updatedAt: 1, ladder: [1n], venues: [] }) })
    ).toStrictEqual([{ coverage: 'failed', keys: [key], reason: 'no venue curve' }])
    expect(await sweep({ curveOf: () => undefined })).toStrictEqual([])
  })

  it("keeps a credentialed RPC URL out of a failed sweep's log", async () => {
    const url = 'https://user:s3cret@rpc.example/v2/k3y'
    const logged: unknown[] = []
    const logger: Logger = { ...silent, warn: (_event, fields) => logged.push(fields) }
    for (const failure of [new HttpRequestError({ url, status: 401 }), new Error(`GET ${url}`)])
      await createCurveSource(sources({ sweep: () => Promise.reject(failure) }), logger)(
        new Map([[venuePairKey(PAIR), PAIR]]),
        undefined,
        () => {},
        never()
      )
    expect(logged).toHaveLength(2)
    expect(JSON.stringify(logged)).not.toMatch(/s3cret|k3y|rpc\.example/)
  })
})
