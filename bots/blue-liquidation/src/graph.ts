import type { Backoff, BackoffPolicy } from '@repo/controller'
import type { Budget, Keyed, KeyedWrite } from '@repo/engine'
import type { KernelHostOptions } from '@repo/kernel'
import type { Logger } from '@repo/kit'

import { defineBot, isBackedOff, logBackoff, logTasks, tasks } from '@repo/controller'
import {
  emitTo,
  every,
  keyedLevel,
  keyRecord,
  lane,
  latest,
  sample,
  UNREAD,
  watch
} from '@repo/engine'

import type { PositionReading } from './liquidation'
import type { PrepareDeps } from './prepare'
import type { PositionQuote, QuoteDeps, QuoteRequest, RouteQuote, WorldDeps } from './sources'
import type { TickStats } from './stats'

import { liquidationTask, sizePosition, unhealthiness } from './liquidation'
import { createPositionPreparer } from './prepare'
import { createReporter } from './report'
import { covers, deferredQuote, quotesDue, quotesGone, readPositions, readQuote } from './sources'

/** World reads queued behind the one in flight; a read for a head the kernel has passed is skipped. */
const WORLD_QUEUE = 256
/** Preparations waiting for a simulation slot; the family never has more out than it runs. */
const PREPARE_QUEUE = 64
/** A simulation, with its retries. */
const PREPARE_TIMEOUT_MS = 10_000
/** A firm quote with its retries. */
const QUOTE_TIMEOUT_MS = 20_000

export type LiquidatorOptions = Readonly<{
  kernel: Omit<KernelHostOptions, 'requests' | 'facts' | 'onActivity'>
  world: Omit<WorldDeps, 'logger'>
  /** How long a world read authorizes liquidations, from when it started. */
  worldValidMs: number
  quotes: Omit<QuoteDeps, 'timeoutMs' | 'backoff' | 'stats' | 'logger'> &
    Readonly<{
      /** How long a route authorizes liquidations, and so how often a liquidatable position is quoted. */
      validForMs: number
      /** How long a position waits to be quoted again after its quote found no path. */
      retryMs: number
    }>
  prepare: Omit<PrepareDeps, 'stats' | 'logger'>
  /** How many quotes run at once, and how many may start in a window. */
  venue: Readonly<{ concurrency: number; budget?: Budget }>
  /** How many preparations simulate at once. */
  simulations: number
  /** Spaces a position's failed preparations, refused acts and failed quotes alike. */
  backoff: BackoffPolicy
  /** Names this run in its intent ids, so a restart's acts never collide with an earlier run's. */
  runId: string
  /** How many native reservations the kernel's caps allow. */
  maxReservations: number
  stats: TickStats
  logger: Logger
}>

/**
 * The liquidator: each new head is a world read of every liquidatable position; each one with a
 * plan and no backoff is quoted, and quoted again only once its route expires or no longer covers its
 * seize, or its failed quote has waited out its own backoff. A
 * liquidation rests on two facts, that its position is still liquidatable and that its route is the
 * one quoted, so it holds exactly as long as both do. Shared liquidity between positions is neither
 * reserved nor a conflict: simulation and the Executor's onchain bounds stop a squeezed route, at
 * the cost of gas.
 */
export const declareLiquidator = defineBot('blue-liquidation', (b, o: LiquidatorOptions) => {
  const { logger, stats } = o
  const reporter = createReporter({ stats, logger })
  const kernel = b.kernel({ ...o.kernel, onActivity: reporter.reportActivity })
  const world = b.source('world', {
    level: 'positions',
    at: 'head',
    queue: WORLD_QUEUE,
    validForMs: o.worldValidMs,
    logger,
    read: readPositions({ ...o.world, stats, logger })
  })
  const positions = world.level
  const { writes, quotes } = b.raw(g =>
    g.scope('quotes', s => {
      const writes = s.node<KeyedWrite<PositionQuote>>('reads')
      return { writes, quotes: keyedLevel(g, 'quotes', writes) }
    })
  )
  const routeOf = (key: string, routes: Keyed<PositionQuote>) => {
    const quote = keyRecord(routes, key)
    return quote.status === 'present' && quote.value.kind === 'route' ? quote : undefined
  }
  const routed = { with: { routes: latest(quotes) } }
  const liquidatable = b.fact('positions.liquidatable', positions, ({ marketId, borrower }) => ({
    marketId,
    borrower
  }))
  const route = b.fact('quotes.route', quotes, quote =>
    quote.kind === 'route' ? quote : undefined
  )
  const sizing = b.derive('positions.sizing', positions, r => sizePosition(r.out))
  const inputs = b.derive(
    'liquidations.inputs',
    positions,
    (reading, key, { routes }) => {
      const quoted = routeOf(key, routes)
      if (!quoted) return undefined
      const { plan } = sizePosition(reading.out)
      if (plan && !covers(quoted.value, plan.seizedAssets)) return undefined
      return { reading, quote: quoted.value as RouteQuote }
    },
    routed
  )
  const candidates = b.derive('liquidations.candidates', inputs, ({ reading }) => {
    const { plan } = sizePosition(reading.out)
    return plan ? { bid: unhealthiness(reading.out) } : undefined
  })
  const liquidations = tasks.each(b, 'liquidations', {
    kernel,
    candidates,
    facts: [liquidatable, route],
    inputs,
    runId: o.runId,
    maxReservations: o.maxReservations,
    backoff: o.backoff,
    policy: liquidationTask,
    prepare: {
      lane: lane('simulation', { concurrency: o.simulations, queue: PREPARE_QUEUE }),
      timeoutMs: PREPARE_TIMEOUT_MS,
      handle: createPositionPreparer({ ...o.prepare, stats, logger })
    }
  })
  const { backoff } = liquidations
  b.raw(g =>
    g.scope('quotes', s => {
      const requests = s.node<QuoteRequest>('requests')
      // A re-quote moves the route fact an in-flight act rests on, so busy keys are never quoted.
      // The view and backoff are sampled, as a fact the kernel triggers is refused (controller SPEC
      // §7), so quotes are scheduled only in a step that wrote positions or quotes, which re-reads both.
      const held = s.map('held', {
        reads: {
          positions: latest(positions),
          quotes: latest(quotes),
          view: sample(kernel.view),
          backoff: sample(backoff.state)
        },
        compute: ({ view, backoff }) => ({ busy: view.busy, backoff })
      })
      s.fold('schedule', {
        reads: {
          positions: watch(positions),
          held: watch(held),
          quotes: watch(quotes),
          written: every(writes)
        },
        emits: [requests],
        initial: {
          positions: UNREAD as Keyed<PositionReading>,
          busy: [] as readonly string[],
          backoff: undefined as Backoff | undefined,
          quotes: UNREAD as Keyed<PositionQuote>,
          quoting: [] as readonly string[],
          changed: false
        },
        applyInput: (state, input) => {
          if (input.from === 'held') {
            const { busy = [], backoff } = input.value.value ?? {}
            return { state: { ...state, busy, backoff } }
          }
          if (input.from === 'positions') {
            const read = input.value.value ?? UNREAD
            const changed = state.changed || read !== state.positions
            return { state: { ...state, positions: read, changed } }
          }
          if (input.from === 'quotes') {
            const read = input.value.value ?? UNREAD
            const changed = state.changed || read !== state.quotes
            return { state: { ...state, quotes: read, changed } }
          }
          const write = input.value
          const landed = write.coverage === 'carried' ? Object.keys(write.entries) : []
          return {
            state: { ...state, quoting: state.quoting.filter(key => !landed.includes(key)) }
          }
        },
        afterInputs: (state, stamp) => {
          if (!state.changed) return { state }
          const due = quotesDue(state.positions, state.quotes, {
            held: [...state.quoting, ...state.busy],
            ...(state.backoff && { backoff: state.backoff }),
            slots: o.venue.concurrency - state.quoting.length,
            now: stamp.at
          })
          return {
            state: {
              ...state,
              quoting: [...state.quoting, ...due.map(({ key }) => key)],
              changed: false
            },
            emit: due.map(request => emitTo(requests, request))
          }
        }
      })
      s.effect('read', {
        requests: { request: every(requests) },
        samples: { positions, quotes, backoff: backoff.state },
        results: writes,
        lane: lane('venue', { ...o.venue, queue: o.venue.concurrency }),
        handle: async ({ value: request }, context) => {
          const startedAt = context.now()
          // A preparation may back the key off while its quote waits for the venue budget.
          const quote = isBackedOff(context.samples.backoff(), request.key)
            ? deferredQuote(request)
            : await readQuote(request, {
                ...o.quotes,
                backoff: o.backoff,
                timeoutMs: QUOTE_TIMEOUT_MS,
                stats,
                logger
              })
          // A route holds from when it was priced; a missing path waits its retry from when it ended.
          const expiry =
            quote.kind === 'route'
              ? startedAt + o.quotes.validForMs
              : quote.kind === 'no_swap_path'
                ? context.now() + o.quotes.retryMs
                : undefined
          const gone = quotesGone(context.samples.quotes(), context.samples.positions(), {
            block: request.reading.block,
            policy: o.backoff
          }).filter(key => key !== request.key)
          context.write({
            coverage: 'carried',
            entries: { [request.key]: quote },
            absent: gone,
            basis: { observedAt: startedAt },
            ...(expiry !== undefined && { expiry })
          })
        }
      })
    })
  )
  b.sink('liquidations.log', {
    finishOnStop: true,
    on: { world: world.writes, acts: liquidations.events, backoff: backoff.events },
    samples: { sizing, view: kernel.view, backoff: backoff.state },
    handle: ({ from, value }, samples) => {
      if (from === 'world')
        return reporter.reportWorld({
          sizing: samples.sizing(),
          view: samples.view(),
          backoff: samples.backoff(),
          complete: value.coverage === 'complete' || value.coverage === 'carried'
        })
      if (from === 'acts') return logTasks(logger, value)
      logBackoff(logger, value)
    }
  })
  return { kernel, positions, liquidatable, quotes, route, candidates, sizing, liquidations }
})
