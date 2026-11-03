import type { Backoff, BackoffPolicy } from '@repo/controller'
import type { Keyed, KeyedWrite, KeyRecord } from '@repo/engine'
import type { KernelHead } from '@repo/kernel'
import type { Logger } from '@repo/kit'
import type { QuoteOutcome, SwapPlan } from '@repo/swaps'

import { backoffWait, isBackedOff, logBackoff } from '@repo/controller'
import { keyRecord } from '@repo/engine'
import { lensKey, tryCatch } from '@repo/utils'

import type { BorrowerCandidate } from './discovery/borrowers'
import type { PositionReading } from './liquidation'
import type { LiquidationPlan } from './sizing/plan'
import type { LensInput, LensOut } from './state/lens.sol'
import type { TickStats } from './stats'

import { QuoteTimeoutError } from './errors'
import { sizePosition, unhealthiness } from './liquidation'
import { marketId } from './market'
import { revertReason } from './revert.utils'
import { isLiquidatable } from './runner/eligibility'

export type WorldDeps = Readonly<{
  discover: () => Promise<Readonly<{ candidates: readonly BorrowerCandidate[]; complete: boolean }>>
  /** Reads the lens pinned to `at` by its hash, so it can never answer from another fork. */
  readLens: (pairs: readonly LensInput[], at: KernelHead) => Promise<Map<string, LensOut>>
  onHead?: (head: KernelHead) => void
  logger: Logger
}>

/** One world read: what it writes, and how many pairs discovery handed the lens. */
type WorldRead = Readonly<{ write: KeyedWrite<PositionReading>; pairs: number }>

const failed = (reason: string): WorldRead => ({
  write: { coverage: 'failed', reason },
  pairs: 0
})

/**
 * Reads every liquidatable position at the kernel's head `at`. A failed discovery or lens read
 * changes no position, and a pair the lens did not answer, or answered as an invalid read, is
 * failed. Only a discovery that walked its whole scope and a lens that read every pair vouch for
 * the positions they did not return; otherwise the read carries just what it read.
 */
export const readWorld = async (at: KernelHead, deps: WorldDeps): Promise<WorldRead> => {
  const { logger } = deps
  deps.onHead?.(at)
  const discovered = await tryCatch(deps.discover())
  if (discovered.error) {
    logger.warn('discover.error', { error: discovered.error.message })
    return failed('discovery')
  }
  const pairs = discovered.data.candidates.map(({ marketParams, borrower }) => ({
    params: marketParams,
    borrower
  }))
  const lens = await tryCatch(deps.readLens(pairs, at))
  if (lens.error) {
    logger.warn('tick.error', { reason: revertReason(lens.error) })
    return failed('lens')
  }
  logger.info('lens.read', { pairs: pairs.length, returned: lens.data.size })
  const entries: Record<string, PositionReading> = {}
  const absent: string[] = []
  const unread: string[] = []
  for (const pair of pairs) {
    const id = marketId(pair.params)
    const key = lensKey(id, pair.borrower)
    const out = lens.data.get(key)
    if (!out?.valid) unread.push(key)
    else if (isLiquidatable(out))
      entries[key] = { marketId: id, borrower: pair.borrower, out, block: at.number }
    else absent.push(key)
  }
  const basis = { block: at.number, blockHash: at.hash }
  const empty = Object.keys(entries).length === 0
  return {
    pairs: pairs.length,
    write:
      discovered.data.complete && unread.length === 0
        ? { coverage: 'complete', entries, basis, ...(empty && { empty: true as const }) }
        : { coverage: 'carried', entries, absent, failed: unread, basis }
  }
}

/** {@link readWorld} as the world source reads it: it counts its pairs, and a throw is a failed read. */
export const readPositions =
  (deps: WorldDeps & Readonly<{ stats: TickStats }>) =>
  async (head: KernelHead): Promise<KeyedWrite<PositionReading>> => {
    const read = await tryCatch(readWorld(head, deps))
    if (read.error) {
      deps.logger.warn('tick.error', { reason: revertReason(read.error) })
      return { coverage: 'failed', reason: 'world' }
    }
    deps.stats.add({ pairs: read.data.pairs })
    return read.data.write
  }

/**
 * A position's quote: a route selling `seizedAssets`, or why it has none. A quote that failed
 * `failures` times running is not quoted again before block `until`, spaced as a failing
 * preparation's {@link BackoffPolicy} spaces it.
 */
export type PositionQuote =
  | Readonly<{ kind: 'route'; seizedAssets: bigint; swap: SwapPlan }>
  | Readonly<{ kind: 'no_swap_path' }>
  | Readonly<{ kind: 'failed'; reason: string; failures: number; until: number }>

export type RouteQuote = Extract<PositionQuote, { kind: 'route' }>

/** One position to quote, at the reading its seize was sized from, after `failures` failed quotes. */
export type QuoteRequest = Readonly<{ key: string; reading: PositionReading; failures: number }>

/** How far a position's seize may grow past its route's before the route is quoted again. */
const QUOTE_DRIFT_BPS = 50n
const BPS = 10_000n

/** A route covers a seize it does not exceed and trails by no more than {@link QUOTE_DRIFT_BPS}. */
export const covers = (quote: PositionQuote, seizedAssets: bigint) =>
  quote.kind !== 'route' ||
  (quote.seizedAssets <= seizedAssets &&
    (seizedAssets - quote.seizedAssets) * BPS <= seizedAssets * QUOTE_DRIFT_BPS)

/** Whether `quote` still stands for a position read at `block` whose seize is `seizedAssets`. */
const stands = (
  quote: KeyRecord<PositionQuote>,
  { block, seizedAssets, now }: Readonly<{ block: number; seizedAssets: bigint; now: number }>
) => {
  if (quote.status !== 'present') return false
  if (quote.value.kind === 'failed') return block < quote.value.until
  return (quote.expiry === undefined || quote.expiry > now) && covers(quote.value, seizedAssets)
}

/**
 * A quote not asked because its position was backed off by the time it could start: it adds no
 * failure and waits on nothing past that backoff.
 */
export const deferredQuote = ({ reading, failures }: QuoteRequest): PositionQuote => ({
  kind: 'failed',
  reason: 'backed_off',
  failures,
  until: reading.block
})

/**
 * The quotes to mark absent at `block`: each still present whose position reads absent, except a
 * failed one through its wait and one maximum wait after (as the controller keeps a failing
 * preparation's backoff). A quote already absent is never listed again.
 */
export const quotesGone = (
  quotes: Keyed<PositionQuote>,
  positions: Keyed<PositionReading>,
  { block, policy }: Readonly<{ block: number; policy: BackoffPolicy }>
) =>
  Object.entries(quotes.keys)
    .filter(
      ([key, quote]) =>
        quote.status === 'present' &&
        keyRecord(positions, key).status === 'absent' &&
        !(quote.value.kind === 'failed' && quote.value.until + policy.maxBlocks > block)
    )
    .map(([key]) => key)

/**
 * The positions to quote now, least healthy first and at most `slots`: each with a plan, none
 * `held` or backed off, whose quote is missing, expired, failed past its wait, or no longer covers
 * its seize.
 */
export const quotesDue = (
  positions: Keyed<PositionReading>,
  quotes: Keyed<PositionQuote>,
  {
    held,
    backoff,
    slots,
    now
  }: Readonly<{ held: readonly string[]; backoff?: Backoff; slots: number; now: number }>
): QuoteRequest[] =>
  Object.entries(positions.keys)
    .flatMap(([key, record]) => {
      if (record.status !== 'present' || held.includes(key) || isBackedOff(backoff, key)) return []
      if (record.expiry !== undefined && record.expiry <= now) return []
      const { plan } = sizePosition(record.value.out)
      if (!plan) return []
      const quote = keyRecord(quotes, key)
      const { seizedAssets } = plan
      if (stands(quote, { block: record.value.block, seizedAssets, now })) return []
      const failures =
        quote.status === 'present' && quote.value.kind === 'failed' ? quote.value.failures : 0
      const request = { key, reading: record.value, failures }
      return [{ request, bid: unhealthiness(record.value.out) }]
    })
    .toSorted((a, b) => (a.bid === b.bid ? 0 : a.bid > b.bid ? -1 : 1))
    .slice(0, Math.max(slots, 0))
    .map(({ request }) => request)

export type QuoteDeps = Readonly<{
  quoteFor: (plan: LiquidationPlan, out: LensOut, label: string) => Promise<QuoteOutcome>
  /** How long a quote may take before it is read as failed. */
  timeoutMs: number
  backoff: BackoffPolicy
  stats: TickStats
  logger: Logger
}>

/** `promise`, or a rejection once `ms` pass. */
const within = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QuoteTimeoutError()), ms)
  })
  try {
    return await Promise.race([promise, late])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Quotes one position's seize-exact plan at the reading it was asked at. Never throws: a venue
 * failure, a timeout or a route that forwards native value reads as a failed quote, which waits
 * from the reading's block as one more consecutive failure.
 */
export const readQuote = async (request: QuoteRequest, deps: QuoteDeps): Promise<PositionQuote> => {
  const { key, reading } = request
  const fields = { id: key, marketId: reading.marketId, borrower: reading.borrower }
  const fail = (reason: string): PositionQuote => {
    const failures = request.failures + 1
    const until = reading.block + backoffWait(deps.backoff, failures)
    logBackoff(deps.logger, {
      type: 'backoff',
      key,
      task: 'quote',
      reason,
      failures,
      block: reading.block,
      until
    })
    return { kind: 'failed', reason, failures, until }
  }
  const { plan } = sizePosition(reading.out)
  if (!plan) return fail('no_plan')
  const quoted = await tryCatch(within(deps.quoteFor(plan, reading.out, key), deps.timeoutMs))
  if (quoted.error) {
    deps.stats.add({ quoteFailed: 1 })
    deps.logger.warn('quote.error', { ...fields, reason: revertReason(quoted.error) })
    return fail('error')
  }
  const quote = quoted.data
  if (quote.kind === 'no_config') {
    deps.stats.add({ noSwapPath: 1 })
    deps.logger.info('config.no_swap_path', fields)
    return { kind: 'no_swap_path' }
  }
  if (quote.kind === 'failed') {
    deps.stats.add({ quoteFailed: 1 })
    return fail(quote.reason)
  }
  if (quote.plan.steps.some(step => step.value !== 0n)) {
    deps.stats.add({ quoteFailed: 1 })
    deps.logger.warn('quote.native_value', fields)
    return fail('native_value')
  }
  deps.logger.info('quote.ok', { ...fields, seizedAssets: plan.seizedAssets })
  return { kind: 'route', seizedAssets: plan.seizedAssets, swap: quote.plan }
}
