import type { BackoffPolicy, Backoff, Bot, KernelView } from '@repo/controller'
import type { Budget, GraphBuilder, Keyed, KeyedWrite, Node, Stream } from '@repo/engine'
import type { KernelHead, KernelHostOptions } from '@repo/kernel'
import type { Logger } from '@repo/kit'
import type { PairCurve } from '@repo/swaps'

import { defineBot, isBackedOff, isBusy, logBackoff, logTasks, tasks } from '@repo/controller'
import { emitTo, every, GraphDefinitionError, keyedLevel, lane, latest, watch } from '@repo/engine'
import { tryCatch } from '@repo/utils'

import type { WhitelistSource } from './discovery/markets'
import type { PricedToken, PriceTable } from './discovery/token-prices'
import type { PositionReading, Pricing, RouteLevel, Sizing, SizingOptions } from './liquidation'
import type { PrepareDeps } from './prepare'
import type { RouteRequest, RouteResolution, RouteSources } from './routes'
import type { PlanSkipLog } from './runner/plan-skip-log'
import type { WorldDeps } from './sources'
import type { TickStats } from './stats'

import { listedAt } from './discovery/markets'
import { liquidationTask, positionBid, pricingOf, sizePosition, taskOf } from './liquidation'
import { preparePosition } from './prepare'
import { createReporter } from './report'
import { revertReason } from './revert.utils'
import { createCurveSource, createRouteResolver, routesDue, routeWriteOf, wantedBy } from './routes'
import { readWorld } from './sources'

/** World reads queued behind the one in flight; a read for a head the kernel has passed is skipped. */
const WORLD_QUEUE = 256
/** Preparations waiting for the venue lane; the family never has more out than it runs. */
const PREPARE_QUEUE = 64
/** A firm quote with its retries and a simulation, well inside the world's validity. */
export const PREPARE_TIMEOUT_MS = 20_000
/** How often, at most, the whitelist's age is judged and its and the prices' refreshes considered. */
const SOURCES_CLOCK_MS = 5_000

export type LiquidatorOptions = Readonly<{
  kernel: Omit<KernelHostOptions, 'requests' | 'facts' | 'onActivity'>
  world: Omit<WorldDeps, 'logger'>
  /** How long a world read authorizes liquidations, from when it started. */
  worldValidMs: number
  prepare: Omit<PrepareDeps, 'sizing' | 'stats' | 'logger'>
  sizing: SizingOptions
  /** The market whitelist, as {@link Start} carries it and how to refresh it. */
  markets: Readonly<{
    maxAgeMs: number
    refreshMs: number
    refresh: () => Promise<readonly WhitelistSource[]>
  }>
  /** Token USD prices, which order positions and bound their fees, each used for `validForMs` after its fetch. */
  prices: Readonly<{ refreshMs: number; validForMs: number; refresh: () => Promise<PriceSnapshot> }>
  /** Where the route and curve levels the bids price against come from. */
  routes: RouteSources
  /** How many preparations run at once, and how many may start in a window. */
  venue: Readonly<{ concurrency: number; budget?: Budget }>
  backoff: BackoffPolicy
  /** Names this run in its intent ids, so a restart's acts never collide with an earlier run's. */
  runId: string
  /** How many native reservations the kernel's caps allow. */
  maxReservations: number
  stats: TickStats
  planSkipLog: PlanSkipLog
  logger: Logger
}>

export type Markets = Readonly<{ sources: readonly WhitelistSource[]; now: number }>

/** Pushed once before the graph runs: when it started, and the whitelist's startup refresh. */
type Start = Readonly<{ at: number; markets: readonly WhitelistSource[] }>

/** The last price table fetched, and when; `updatedAt` is `null` before any fetch landed. */
export type PriceSnapshot = Readonly<{ table: PriceTable; updatedAt: number | null }>

const priceWriteOf = (
  { table, updatedAt }: PriceSnapshot,
  validForMs: number
): KeyedWrite<PricedToken> =>
  updatedAt === null
    ? { coverage: 'unknown' }
    : {
        coverage: 'complete',
        entries: table,
        basis: { at: updatedAt },
        expiry: updatedAt + validForMs,
        ...(Object.keys(table).length === 0 && { empty: true as const })
      }

/** The whitelist as of the markets fold's clock: each listed market id, and when it ages out. */
type Listing = Readonly<Record<string, number>>

/**
 * A position's fact: still liquidatable, in a market the whitelist lists. A delisted position reads
 * absent under its read, and a listed one expires no later than the whitelist would age out.
 */
export const declareListedFacts = (
  b: Bot,
  positions: Node<Keyed<PositionReading>>,
  markets: Node<Markets>,
  maxAgeMs: number
) => {
  const listing = b.raw(g =>
    g.map('markets.listing', {
      reads: { markets: latest(markets) },
      compute: ({ markets: { sources, now } }): Listing => listedAt(sources, now, maxAgeMs).expiries
    })
  )
  return b.fact(
    'positions.liquidatable',
    positions,
    ({ marketId, borrower }, _key, { listing }) =>
      Object.hasOwn(listing, marketId.toLowerCase()) ? { marketId, borrower } : undefined,
    {
      with: { listing: latest(listing) },
      expiry: ({ marketId }, _key, { listing }) => listing[marketId.toLowerCase()]
    }
  )
}

/**
 * The effect `${id}.refresh`, writing `${id}.reads`: a clock tick starts a refresh once the last one
 * has landed and `everyMs` has passed since it started, as the fold `${id}.interval` decides. A
 * refresh that throws is logged and written as `failed`, which ends it and changes nothing else.
 */
const declareRefresh = <T>(
  g: GraphBuilder,
  id: 'markets' | 'prices',
  clock: Stream<number>,
  start: Stream<Start>,
  spec: Readonly<{
    everyMs: number
    /** When the last refresh before `start` started, or `null` for none. */
    readAt: (start: Start) => number | null
    refresh: () => Promise<T>
    failed: T
    logger: Logger
  }>
) => {
  const reads = g.node<T>(`${id}.reads`)
  const due = g.node<number>(`${id}.due`)
  g.fold(`${id}.interval`, {
    reads: { at: every(clock), read: every(reads), start: every(start) },
    emits: [due],
    initial: { readAt: null as number | null, reading: false },
    applyInput: (state, input) => {
      if (input.from === 'start') return { state: { ...state, readAt: spec.readAt(input.value) } }
      if (input.from === 'read') return { state: { ...state, reading: false } }
      const waiting = state.readAt !== null && input.value - state.readAt < spec.everyMs
      if (state.reading || waiting) return { state }
      return { state: { readAt: input.value, reading: true }, emit: [emitTo(due, input.value)] }
    }
  })
  g.effect(`${id}.refresh`, {
    requests: { at: every(due) },
    results: reads,
    handle: async (_, context) => {
      const refreshed = await tryCatch(spec.refresh())
      if (!refreshed.error) return context.write(refreshed.data)
      spec.logger.error(`${id}.refresh_error`, { detail: revertReason(refreshed.error) })
      context.write(spec.failed)
    }
  })
  return reads
}

/** The whitelist and token prices, each refreshed on a clock, that the world read and pricing read beside. */
const declareSources = (g: GraphBuilder, options: LiquidatorOptions) => {
  const { logger } = options
  if (!Number.isSafeInteger(options.prices.validForMs) || options.prices.validForMs <= 0)
    throw new GraphDefinitionError('prices need a positive safe integer validForMs')
  const clock = g.clock('sources.clock', {
    everyMs: Math.min(SOURCES_CLOCK_MS, options.markets.refreshMs, options.prices.refreshMs),
    value: now => now
  })
  const start = g.occurrences<Start>('sources.start')
  const marketReads = declareRefresh<readonly WhitelistSource[] | null>(
    g,
    'markets',
    clock,
    start,
    {
      everyMs: options.markets.refreshMs,
      readAt: ({ at }) => at,
      refresh: options.markets.refresh,
      failed: null,
      logger
    }
  )
  const markets = g.fold('markets', {
    reads: { sources: every(marketReads), clock: every(clock), start: every(start) },
    initial: { sources: [], now: 0 } as Markets,
    applyInput: (state, input) => ({
      state:
        input.from === 'start'
          ? { sources: input.value.markets, now: Math.max(state.now, input.value.at) }
          : input.from === 'clock'
            ? { ...state, now: Math.max(state.now, input.value) }
            : input.value === null
              ? state
              : { ...state, sources: input.value }
    })
  })
  const priceReads = declareRefresh<KeyedWrite<PricedToken>>(g, 'prices', clock, start, {
    everyMs: options.prices.refreshMs,
    readAt: () => null,
    refresh: async () => priceWriteOf(await options.prices.refresh(), options.prices.validForMs),
    failed: { coverage: 'failed', reason: 'prices' },
    logger
  })
  const prices = keyedLevel(g, 'prices', priceReads)
  const now = g.fold('now', {
    reads: { at: every(clock), start: every(start) },
    initial: 0,
    applyInput: (at, input) => ({
      state: Math.max(at, input.from === 'start' ? input.value.at : input.value)
    })
  })
  return { start, markets, prices, now }
}

/** The world read at its head, as the whitelist stands when the read runs. */
const readListedWorld =
  (options: LiquidatorOptions) =>
  async (
    head: KernelHead,
    now: () => number,
    samples: Readonly<{ markets: () => Markets }>
  ): Promise<KeyedWrite<PositionReading>> => {
    const { logger, stats } = options
    const { sources } = samples.markets()
    const { maxAgeMs } = options.markets
    const at = now()
    const whitelist = {
      ...listedAt(sources, at, maxAgeMs),
      maxAgeMs,
      sources: sources.map(({ source, ids, updatedAt }) => ({
        source,
        markets: ids.length,
        updatedAt,
        expired: updatedAt === null || at - updatedAt > maxAgeMs
      }))
    }
    const read = await tryCatch(readWorld(head, whitelist, { ...options.world, logger }))
    if (read.error) {
      logger.warn('tick.error', { reason: revertReason(read.error) })
      return { coverage: 'failed', reason: 'world' }
    }
    stats.add({ pairs: read.data.pairs })
    return read.data.write
  }

/**
 * The world read at each new kernel head, the whitelist and prices it reads beside, and the
 * position-keyed levels and maps ranking and preparation price against.
 */
const declareWorld = (b: Bot, options: LiquidatorOptions) => {
  const { start, markets, prices, now } = b.raw(g => declareSources(g, options))
  const world = b.source('world', {
    level: 'positions',
    at: 'head',
    queue: WORLD_QUEUE,
    validForMs: options.worldValidMs,
    samples: { markets },
    logger: options.logger,
    read: readListedWorld(options)
  })
  const positions = world.level
  const liquidatable = declareListedFacts(b, positions, markets, options.markets.maxAgeMs)
  const sizing = b.derive('positions.sizing', positions, reading =>
    sizePosition(reading, options.sizing)
  )
  const { routeWrites, routes, curveWrites, curves, pricing } = b.raw(g => {
    const routeWrites = g.node<KeyedWrite<RouteLevel>>('routes.reads')
    const routes = keyedLevel(g, 'routes', routeWrites)
    const curveWrites = g.node<KeyedWrite<PairCurve>>('curves.reads')
    const curves = keyedLevel(g, 'curves', curveWrites)
    const pricing = g.map('liquidations.pricing', {
      reads: { prices: latest(prices), routes: latest(routes), curves: latest(curves) },
      compute: (levels): Pricing => ({
        prices: levels.prices.keys,
        routes: levels.routes.keys,
        curves: levels.curves.keys,
        venues: options.routes.venues
      })
    })
    return { routeWrites, routes, curveWrites, curves, pricing }
  })
  const bids = b.derive(
    'liquidations.bids',
    sizing,
    (sized, _key, { pricing: current, now: at }) =>
      sized.plans.length === 0
        ? undefined
        : { bid: positionBid(sized, current, at), task: taskOf(sized) },
    { with: { pricing: latest(pricing), now: latest(now) } }
  )
  const priced = b.derive(
    'positions.priced',
    positions,
    (reading, _key, { pricing: current }) => ({
      reading,
      pricing: pricingOf(reading.out, current, options.prepare.nativeToken)
    }),
    { with: { pricing: latest(pricing) } }
  )
  return {
    start,
    markets,
    prices,
    worldWrites: world.writes,
    positions,
    liquidatable,
    sizing,
    routeWrites,
    routes,
    curveWrites,
    curves,
    pricing,
    bids,
    priced
  }
}

type World = ReturnType<typeof declareWorld>

/** What route resolution reads beside each world read. */
type ResolvingInputs = {
  sizing: Keyed<Sizing>
  liquidatable: Keyed<unknown>
  routes: Keyed<RouteLevel>
  view: KernelView
  backoff: Backoff
}

/**
 * Resolves the routes and sweeps the curves of the positions that could act now. The fold
 * `routes.resolving` asks `routes.resolve` for each due route it has not already asked for, and
 * applies a resolution only while it answers that route's outstanding request.
 */
const declareRouteSources = (
  g: GraphBuilder,
  world: World,
  view: Node<KernelView>,
  backoff: Node<Backoff>,
  options: LiquidatorOptions
) => {
  const { logger } = options
  const { sizing, liquidatable, routes, curves, routeWrites } = world
  const listedIdle =
    ({ liquidatable: held, view: kernel, backoff }: Partial<Readonly<ResolvingInputs>>) =>
    (position: string) =>
      held?.keys[position]?.status === 'present' &&
      !isBusy(kernel, position) &&
      !isBackedOff(backoff, position, 'liquidate')
  const requests = g.node<RouteRequest>('routes.requests')
  const resolutions = g.node<RouteResolution>('routes.resolutions')
  g.fold('routes.resolving', {
    reads: {
      world: every(world.worldWrites),
      resolution: every(resolutions),
      sizing: watch(sizing),
      liquidatable: watch(liquidatable),
      routes: watch(routes),
      view: watch(view),
      backoff: watch(backoff)
    },
    emits: [requests, routeWrites],
    initial: {
      inputs: {} as Partial<Readonly<ResolvingInputs>>,
      outstanding: {} as Readonly<Record<string, Readonly<{ id: number; at: number }>>>,
      issued: 0,
      read: false
    },
    applyInput: (state, input) => {
      if (input.from === 'world') return { state: { ...state, read: true } }
      if (input.from !== 'resolution')
        return { state: { ...state, inputs: { ...state.inputs, [input.from]: input.value.value } } }
      const resolution = input.value
      const asked = Object.hasOwn(state.outstanding, resolution.key)
        ? state.outstanding[resolution.key]
        : undefined
      if (asked?.id !== resolution.id) return { state }
      const { [resolution.key]: _, ...outstanding } = state.outstanding
      const write = routeWriteOf(resolution, asked.at)
      return { state: { ...state, outstanding }, emit: write ? [emitTo(routeWrites, write)] : [] }
    },
    afterInputs: (state, stamp) => {
      if (!state.read) return { state }
      const { inputs } = state
      const wanted = wantedBy(inputs.sizing, listedIdle(inputs), inputs.routes, stamp.at)
      const due = routesDue(wanted.routes, inputs.routes, state.outstanding, stamp.at)
      const issued = due.map(([key, { collateral, loan }], index) => ({
        id: state.issued + index,
        key,
        collateral,
        loan,
        at: stamp.at
      }))
      const outstanding = {
        ...state.outstanding,
        ...Object.fromEntries(issued.map(({ id, key, at }) => [key, { id, at }]))
      }
      return {
        state: { ...state, outstanding, issued: state.issued + issued.length, read: false },
        emit: issued.map(request => emitTo(requests, request))
      }
    }
  })
  const resolveRoute = createRouteResolver(options.routes)
  g.effect('routes.resolve', {
    requests: { request: every(requests) },
    results: resolutions,
    handle: async ({ value: request }, context) => {
      const resolution = await resolveRoute(request, context.signal)
      if (resolution) context.write(resolution)
    }
  })
  const sweepCurves = createCurveSource(options.routes, logger)
  g.effect('curves.sweep', {
    requests: { world: every(world.worldWrites), routes: every(world.routeWrites) },
    samples: { sizing, liquidatable, routes, curves, view, backoff },
    results: world.curveWrites,
    handle: async (_, context) => {
      const { samples } = context
      const wanted = wantedBy(
        samples.sizing(),
        listedIdle({
          liquidatable: samples.liquidatable(),
          view: samples.view(),
          backoff: samples.backoff()
        }),
        samples.routes(),
        context.now()
      )
      if (wanted.pairs.size > 0)
        logger.info('probe.warmed', { pairs: wanted.pairs.size, candidates: wanted.alternatives })
      await sweepCurves(wanted.pairs, samples.curves(), context.write, context.signal)
    }
  })
}

/**
 * The liquidator as one graph: each new kernel head is a world read of every liquidatable position
 * in a listed market, complete for discovery's scope. A position's fact is that it is still
 * liquidatable in a market the whitelist lists, expiring when the whitelist would age out, so a
 * delisting or a whitelist past its maximum age withdraws it at once. Positions are ranked by their
 * best alternative's USD surplus net of the route costs the world read priced, and prepared in that
 * order within the venue lane, each preparation working down that position's alternatives with the
 * prices, routes and curves of that position its request captured, each read as absent once past its
 * own expiry, so a declined position is prepared again only when one of them is rewritten; a prepared
 * liquidation goes to the kernel resting on its position's fact. A bad-debt write-off is its own task, with its own backoff, so a position's swap failures never
 * back it off. Shared liquidity between positions is neither reserved nor a conflict: simulation and the
 * Executor's onchain bounds stop a squeezed route, at the cost of gas.
 */
export const declareLiquidator = defineBot(
  'midnight-liquidation',
  (b, options: LiquidatorOptions) => {
    const { logger, stats } = options
    const reporter = createReporter({
      stats,
      planSkipLog: options.planSkipLog,
      headroomFloorBps: options.sizing.headroomFloorBps,
      logger
    })
    const kernel = b.kernel({ ...options.kernel, onActivity: reporter.reportActivity })
    const world = declareWorld(b, options)
    const { positions, sizing, liquidatable } = world
    const candidates = world.bids
    const deps = { ...options.prepare, sizing: options.sizing, stats, logger }
    const liquidations = tasks.each(b, 'liquidations', {
      kernel,
      candidates,
      facts: liquidatable,
      inputs: world.priced,
      runId: options.runId,
      maxReservations: options.maxReservations,
      backoff: options.backoff,
      policy: liquidationTask,
      prepare: {
        lane: lane('venue', { ...options.venue, queue: PREPARE_QUEUE }),
        timeoutMs: PREPARE_TIMEOUT_MS,
        handle: async request => {
          const { reading, pricing } = request.input
          const answer = await tryCatch(
            preparePosition({ ...request, input: reading }, pricing, deps)
          )
          if (!answer.error) return answer.data
          logger.warn('prepare.error', {
            id: request.key,
            reason: revertReason(answer.error)
          })
          return { ok: false, reason: 'error', backoff: true }
        }
      }
    })
    const { backoff } = liquidations
    b.raw(g => declareRouteSources(g, world, kernel.view, backoff.state, options))
    b.sink('liquidations.log', {
      finishOnStop: true,
      on: { world: world.worldWrites, acts: liquidations.events, backoff: backoff.events },
      samples: { positions, sizing, liquidatable, view: kernel.view, backoff: backoff.state },
      handle: ({ from, value }, samples) => {
        if (from === 'world')
          return reporter.reportWorld({
            positions: samples.positions(),
            sizing: samples.sizing(),
            liquidatable: samples.liquidatable(),
            view: samples.view(),
            backoff: samples.backoff(),
            complete: value.coverage === 'complete'
          })
        if (from === 'acts') return logTasks(logger, value)
        logBackoff(logger, value)
      }
    })
    return {
      kernel,
      start: world.start,
      markets: world.markets,
      prices: world.prices,
      positions,
      liquidatable,
      routes: world.routes,
      curves: world.curves,
      pricing: world.pricing,
      candidates,
      sizing,
      backoff,
      liquidations
    }
  }
)
