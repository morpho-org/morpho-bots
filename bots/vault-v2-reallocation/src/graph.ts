import type { BackoffPolicy } from '@repo/controller'
import type { KernelHead, KernelHostOptions } from '@repo/kernel'
import type { Logger, SignedFees } from '@repo/kit'
import type { Address } from 'viem'

import { defineBot, logBackoff, logTasks, tasks } from '@repo/controller'
import { emitTo, every, lane } from '@repo/engine'

import type { PrepareDeps } from './prepare'
import type { WorldDeps } from './sources'
import type { Tick } from './stats'
import type { Strategy } from './strategies'

import { readValidMs } from './config'
import { createReallocationPreparer } from './prepare'
import { decide, legsOf, reallocationTask } from './reallocation'
import { createReporter } from './report'
import { readWorld } from './sources'
import { countTick, NO_TICK } from './stats'

/** Reads queued behind the one in flight. */
const WORLD_QUEUE = 16

/** Preparations waiting for the simulation lane; the family never has more out than it runs. */
const PREPARE_LANE = { concurrency: 4, queue: 64 }
/** One simulation through two RPC timeouts, far inside the reallocation interval. */
const PREPARE_TIMEOUT_MS = 60_000

export type ReallocatorOptions = Readonly<{
  kernel: Omit<KernelHostOptions, 'requests' | 'facts' | 'onActivity'>
  world: WorldDeps
  strategy: Strategy
  /** Each whitelisted vault's adapter, as the startup checks resolved it and the validator pins it. */
  adapters: Readonly<Record<Address, Address>>
  prepare: Omit<PrepareDeps, 'logger'>
  /**
   * The whitelist is read at the first head, then at the first head `intervalMs` after the last
   * read started, once that read has landed.
   */
  intervalMs: number
  backoff: BackoffPolicy
  /** Names this run in its intent ids, so a restart's acts never collide with an earlier run's. */
  runId: string
  /** How many native reservations the kernel's caps allow. */
  maxReservations: number
  onHead?: (head: KernelHead) => void
  feesOf?: (hash: string) => SignedFees | undefined
  logger: Logger
}>

/**
 * The reallocator: the whitelist is read at the kernel's head once per interval; each vault's
 * strategy runs purely on that read, and a vault whose strategy finds a reallocation wants it,
 * resting on the markets and directions it moves. Each vault is its own key, so one vault's act
 * never waits on another's.
 */
export const declareReallocator = defineBot('vault-v2-reallocation', (b, o: ReallocatorOptions) => {
  const { logger } = o
  const reporter = createReporter({
    whitelist: o.world.vaults,
    adapters: o.adapters,
    ...(o.feesOf && { feesOf: o.feesOf }),
    logger
  })
  // The only signer: it checks each act with the validator, simulates it again, signs and tracks it.
  const kernel = b.kernel({ ...o.kernel, onActivity: reporter.reportActivity })
  // The whitelist in one block-pinned read per interval; a read authorizes acts for `validForMs`.
  const world = b.source('world', {
    level: 'vaults',
    at: { everyMs: o.intervalMs },
    queue: WORLD_QUEUE,
    validForMs: readValidMs(o.intervalMs),
    read: readWorld(o.world, logger)
  })
  const vaults = world.level
  // Each vault's strategy, run purely on its read.
  const assessments = b.derive('vaults.plans', vaults, reading => ({
    reading,
    decision: decide(reading, o.strategy, o.adapters[reading.vaultAddress]!)
  }))
  // The markets and directions a reallocation moves: the evidence its act rests on.
  const reallocationFacts = b.fact('vaults.reallocation', assessments, ({ decision }) =>
    decision.reallocation ? { legs: legsOf(decision.reallocation) } : undefined
  )
  // What the preparer encodes and simulates for a vault that wants a reallocation.
  const inputs = b.derive('vaults.inputs', assessments, ({ reading, decision }) =>
    decision.reallocation ? { reading, reallocation: decision.reallocation } : undefined
  )
  // The vaults that want an act now, all at the same bid.
  const candidates = b.derive('reallocations.candidates', assessments, ({ decision }) =>
    decision.reallocation ? { bid: 1n } : undefined
  )
  // Every vault's decision, for the per-read report.
  const decisions = b.derive('vaults.decisions', assessments, assessment => assessment.decision)
  // One act per vault: prepare it (encode, simulate), hand it to the kernel, back off on failure.
  const reallocations = tasks.each(b, 'reallocations', {
    kernel,
    candidates,
    facts: reallocationFacts,
    inputs,
    runId: o.runId,
    maxReservations: o.maxReservations,
    backoff: o.backoff,
    policy: reallocationTask,
    prepare: {
      lane: lane('simulation', PREPARE_LANE),
      timeoutMs: PREPARE_TIMEOUT_MS,
      handle: createReallocationPreparer({ ...o.prepare, logger })
    }
  })
  const { backoff } = reallocations
  // Each read with its block and what was counted since the read before, for its `tick.end`.
  const ticks = b.raw(g => {
    const ticks = g.node<Tick>('ticks')
    g.fold('ticks.count', {
      reads: {
        prepared: every(reallocations.prepared),
        activity: every(kernel.nodes.activity),
        head: every(kernel.nodes.heads),
        world: every(world.writes)
      },
      emits: [ticks],
      initial: NO_TICK,
      applyInput: (state, input) => {
        const next = countTick(state, input)
        return { state: next.state, ...(next.tick && { emit: [emitTo(ticks, next.tick)] }) }
      }
    })
    return ticks
  })
  // The operator log: the per-read lines and `tick.end`, then act and backoff events.
  b.sink('reallocations.log', {
    finishOnStop: true,
    on: { tick: ticks, acts: reallocations.events, backoff: backoff.events },
    samples: { vaults, decisions, view: kernel.view },
    handle: ({ from, value }, samples) => {
      if (from === 'tick')
        return reporter.reportRead({
          vaults: samples.vaults(),
          decisions: samples.decisions(),
          view: samples.view(),
          tick: value
        })
      if (from === 'acts') return logTasks(logger, value)
      logBackoff(logger, value)
    }
  })
  // Each kernel head, for the balance monitor.
  const { onHead } = o
  if (onHead)
    b.sink('heads', { on: { head: kernel.nodes.heads }, handle: ({ value }) => onHead(value) })
  return { kernel, vaults, decisions, reallocationFacts, candidates, reallocations }
})
