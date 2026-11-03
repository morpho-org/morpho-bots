import type { Keyed, KeyedWrite } from '@repo/engine'
import type { Logger } from '@repo/kit'
import type { PairCurve, Venue, VenuePair } from '@repo/swaps'
import type { Address } from 'viem'

import { MAX_COST_LEVEL_AGE_MS, venuePairKey } from '@repo/swaps'
import { tryCatch } from '@repo/utils'

import type { RouteLevel, Sizing } from './liquidation'

import { pairOf, probedPlans, routeKeyOf, sellsNothing } from './liquidation'
import { revertReason } from './revert.utils'

/** Where route resolutions and probe curves come from; each may be slow, and nothing awaits it. */
export type RouteSources = Readonly<{
  /** Which pair a collateral sells through for a loan token; see {@link RouteLevel}. */
  resolvePair: (collateral: Address, loan: Address) => Promise<VenuePair | null>
  /** Probes a pair's curve unless it is fresh or already being probed. */
  sweep: (pair: VenuePair) => Promise<void>
  curveOf: (pair: VenuePair) => PairCurve | undefined
  venues: readonly Venue[]
}>

type Wanted = Readonly<{
  routes: ReadonlyMap<string, Readonly<{ collateral: Address; loan: Address }>>
  pairs: ReadonlyMap<string, VenuePair>
  alternatives: number
}>

/**
 * What the idle, listed positions' probed alternatives sell through: the routes to resolve, keyed by
 * {@link routeKeyOf}, and the pairs their routes live at `now` name, keyed by `venuePairKey`.
 */
export const wantedBy = (
  sizing: Keyed<Sizing> | undefined,
  listed: (position: string) => boolean,
  routes: Keyed<RouteLevel> | undefined,
  now: number
): Wanted => {
  const wantedRoutes = new Map<string, { collateral: Address; loan: Address }>()
  const pairs = new Map<string, VenuePair>()
  let alternatives = 0
  for (const [position, fact] of Object.entries(sizing?.keys ?? {})) {
    if (fact.status !== 'present' || !listed(position)) continue
    for (const plan of probedPlans(fact.value)) {
      const collateral = fact.value.collateralTokens[plan.collateralIndex]
      if (sellsNothing(plan) || !collateral) continue
      alternatives += 1
      wantedRoutes.set(routeKeyOf(collateral, fact.value.loanToken), {
        collateral,
        loan: fact.value.loanToken
      })
      const pair = pairOf(plan, fact.value, routes?.keys ?? {}, now)
      if (pair) pairs.set(venuePairKey(pair), pair)
    }
  }
  return { routes: wantedRoutes, pairs, alternatives }
}

const until = (signal: AbortSignal) =>
  new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))

/**
 * How long a resolved route is trusted before it is resolved again. An unwrap list a later firm quote
 * refreshes (a Pendle PT first missing from it) can change a collateral's pair; ten minutes bounds how
 * long bids price the old pair, for one cache-served preview per collateral per window.
 */
export const ROUTE_REFRESH_MS = 10 * 60_000
/** How long a resolved route is used, across failed re-resolves: its write's expiry. */
export const ROUTE_MAX_AGE_MS = 60 * 60_000

/** One route to resolve, numbered by the fold that asked, at the time it asked. */
export type RouteRequest = Readonly<{
  id: number
  key: string
  collateral: Address
  loan: Address
  at: number
}>

/** What one resolve found, `null` when the pair has no route, answering the request it names. */
export type RouteResolution = Readonly<{ id: number; key: string }> &
  (Readonly<{ pair: VenuePair | null }> | Readonly<{ failed: true }>)

/**
 * The wanted routes to resolve at `now`: each not yet known, or held longer than
 * {@link ROUTE_REFRESH_MS}, and not already `outstanding`.
 */
export const routesDue = (
  wanted: Wanted['routes'],
  known: Keyed<RouteLevel> | undefined,
  outstanding: Readonly<Record<string, unknown>>,
  now: number
) =>
  [...wanted].filter(([key]) => {
    const held = known?.keys[key]
    const at = held?.status === 'present' ? held.value.resolvedAt : undefined
    return !Object.hasOwn(outstanding, key) && (at === undefined || now - at >= ROUTE_REFRESH_MS)
  })

/**
 * The route level's write for a resolution of a request made at `at`, expiring
 * {@link ROUTE_MAX_AGE_MS} later; none for a failed resolve, which leaves a held route to its expiry.
 */
export const routeWriteOf = (
  resolution: RouteResolution,
  at: number
): KeyedWrite<RouteLevel> | undefined =>
  'pair' in resolution
    ? {
        coverage: 'carried',
        entries: { [resolution.key]: { pair: resolution.pair, resolvedAt: at } },
        basis: { route: resolution.key },
        expiry: at + ROUTE_MAX_AGE_MS
      }
    : undefined

/**
 * Resolves one route, or returns nothing once `signal` aborts, so a resolve that never settles holds
 * only its own request.
 */
export const createRouteResolver =
  (sources: RouteSources) =>
  async (request: RouteRequest, signal: AbortSignal): Promise<RouteResolution | undefined> => {
    const { id, key } = request
    const resolved = await Promise.race([
      tryCatch(sources.resolvePair(request.collateral, request.loan)),
      until(signal).then(() => undefined)
    ])
    if (resolved === undefined) return undefined
    return resolved.error ? { id, key, failed: true } : { id, key, pair: resolved.data }
  }

/**
 * The curve level's source: sweeps each wanted pair, and writes its curve once a sweep has left one,
 * expiring when it is too old to trust as a cost level, or `failed` for a sweep that threw or left no
 * venue's curve; never an empty curve. Waits for what it started, or for `signal`.
 */
export const createCurveSource =
  (sources: RouteSources, logger: Logger) =>
  async (
    pairs: Wanted['pairs'],
    held: Keyed<PairCurve> | undefined,
    write: (curve: KeyedWrite<PairCurve>) => void,
    signal: AbortSignal
  ) => {
    const swept = [...pairs].map(async ([key, pair]) => {
      const { error } = await tryCatch((async () => sources.sweep(pair))())
      if (error) {
        logger.warn('probe.warm_failed', {
          collateral: pair.collateral,
          loan: pair.loan,
          detail: revertReason(error)
        })
        return write({ coverage: 'failed', keys: [key], reason: 'sweep' })
      }
      const curve = sources.curveOf(pair)
      if (!curve) return
      if (curve.venues.length === 0)
        return write({ coverage: 'failed', keys: [key], reason: 'no venue curve' })
      const current = held?.keys[key]
      if (current?.status === 'present' && current.value.updatedAt === curve.updatedAt) return
      write({
        coverage: 'carried',
        entries: { [key]: curve },
        basis: { at: curve.updatedAt },
        expiry: curve.updatedAt + MAX_COST_LEVEL_AGE_MS
      })
    })
    await Promise.race([Promise.all(swept), until(signal)])
  }
