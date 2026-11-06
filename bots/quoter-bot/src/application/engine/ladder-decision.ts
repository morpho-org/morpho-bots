import type {
  LadderDiagnostics,
  LadderMarketState,
  LadderQuoteSet,
  LadderWithdrawnSide,
  ValidLadderConfig
} from '../../domain/ladder'
import type { LadderPreparation } from '../../infrastructure/ladder/production-ladder'
import type { LadderBookSideCrossingReport } from '../ladder/ladder-verbose'
import type { Act, Decision, LiveView, Observed, Prepared } from './decision'
import type { Classification, LadderFacts, MarketReport } from './market-report'
import type { LadderReading, Read, ReferenceReading } from './readings'

import {
  effectiveLadderPremiumBps,
  generateLadderWithDiagnostics,
  shouldRecenter
} from '../../domain/ladder'
import { lendHalt } from '../../domain/loss-factor'
import { marketObservationMatured } from '../../domain/market-maturity'
import { operatorErrorName } from '../monitoring/operator-error-name.utils'
import { decisionClassification } from './market-report'

const SIDES = ['lower', 'higher'] as const

/** A kernel commitment the quoter holds, as its decisions read it. */
type LiveGroup = Readonly<{ groupId: string; buy: boolean }>

/** Per side, the block timestamp of the last settled replacement that saw a clearable crossing. */
export type LadderCrossings = Readonly<{ lower?: bigint; higher?: bigint }>

/** Why a ladder replacement runs, as today's cycle outcomes name it. */
type LadderReason = 'publish' | 'recenter' | 'resize' | 'book-crossed'

/** What a ladder act carries: the plan's data and the outcome to report once it settles. */
export type LadderActPayload =
  | Readonly<{ cancel: readonly string[]; report: Classification }>
  | Readonly<{
      cancel: readonly string[]
      publication: NonNullable<LadderPreparation['publication']>
      reconciliation: LadderPreparation['reconciliation']
      report: Classification
    }>

/** What the ladder prepare need returns: the preparation, or a sanitized failure. */
export type LadderPrepareAnswer = Read<LadderPreparation>

/**
 * A ladder quote's semantic identity: every publication-relevant domain value, as one string.
 * @param quote - Desired ladder quote set.
 * @returns A stable key; equal keys mean the resting quote needs no replacement.
 */
export const ladderIdentity = (quote: LadderQuoteSet) =>
  [
    'ladder',
    quote.marketId.toLowerCase(),
    quote.centerRateBps,
    quote.referenceObservationId ?? '',
    quote.groupMode,
    quote.debtCapable === true,
    ...SIDES.map(side =>
      quote[side].map(rung => `${rung.index}@${rung.rateBps}x${rung.assets}`).join(',')
    )
  ].join('|')

type DecisionWithDetail = Decision & Readonly<{ detail: Classification }>

type LadderInput = Readonly<{
  config: ValidLadderConfig
  reading: LadderReading
  reference: Observed<ReferenceReading>
  view: LiveView
  crossings: LadderCrossings
  prepare: Prepared<LadderPrepareAnswer>
}>

const liveOf = (view: LiveView) =>
  view.live.map(commitment => ({ id: commitment.id, ...(commitment.detail as LiveGroup) }))

const cancel = (ids: readonly string[], condition: string, report: Classification): Act => ({
  kind: 'cancel',
  identity: `cancel:${ids.join(',')}`,
  payload: { cancel: [...ids], report } as never,
  condition
})

/**
 * The prepare need's request: asked only while the decision would replace the ladder, and again
 * whenever the kernel epoch moves, so a preparation is never reused across one of our own acts.
 */
const ladderPrepareParams = (input: {
  reading: LadderReading
  desired?: LadderQuoteSet
  reason?: LadderReason
  bookCrossedSides?: readonly ('lower' | 'higher')[]
}) =>
  input.desired && input.reason
    ? {
        marketId: input.reading.marketId,
        desired: input.desired,
        reason: input.reason,
        ...(input.bookCrossedSides ? { bookCrossedSides: [...input.bookCrossedSides] } : {}),
        block: input.reading.block
      }
    : undefined

type Generated = Readonly<{
  targetRateBps: bigint
  diagnostics: LadderDiagnostics
  desired: LadderQuoteSet
  publication?: LadderQuoteSet
  reason: LadderReason | 'rest'
  bookCrossedSides: readonly ('lower' | 'higher')[]
  snapshotWithdrawnSides: readonly LadderWithdrawnSide[]
  bookCrossing?: Readonly<Record<'lower' | 'higher', LadderBookSideCrossingReport>>
}>

/**
 * The pre-decision crossing per side, marking a side its cooldown still throttles. A side with no
 * recorded replacement, or an observation without a block timestamp, has elapsed: the throttle only
 * suppresses on positive evidence that it is too soon.
 */
const crossingReport = (
  config: ValidLadderConfig,
  market: LadderMarketState,
  crossings: LadderCrossings
) => {
  const crossing = market.bookCrossing
  if (!crossing) return undefined
  const report = (side: (typeof SIDES)[number]): LadderBookSideCrossingReport => {
    const previous = crossings[side]
    const elapsed =
      previous === undefined ||
      market.observedTimestamp === undefined ||
      market.observedTimestamp - previous >= BigInt(config.bookCrossedCooldownSeconds)
    return {
      ...crossing[side],
      suppressed: crossing[side].crossed && crossing[side].clearable && !elapsed
    }
  }
  return { lower: report('lower'), higher: report('higher') }
}

/** Today's decision kind: publish without an active quote, rest on an equal one, else move it. */
const reasonOf = (input: {
  active?: LadderQuoteSet
  desired: LadderQuoteSet
  recenter: boolean
  publication?: LadderQuoteSet
  snapshotWithdrawnSides: readonly LadderWithdrawnSide[]
}): Generated['reason'] => {
  if (!input.active)
    return !input.publication && input.snapshotWithdrawnSides.length === 0 ? 'rest' : 'publish'
  if (ladderIdentity(input.active) === ladderIdentity(input.desired)) return 'rest'
  return input.recenter ? 'recenter' : 'resize'
}

/**
 * Today's generation step for one market: retained center inside the movement tolerance, fresh
 * sizes, snapshot-withdrawn sides, and the `book-crossed` upgrade of a resting ladder.
 * @throws `LadderConfigurationError` and generation errors, which halt the bot.
 */
const generateLadderDecision = (input: {
  config: ValidLadderConfig
  reading: LadderReading
  reference: ReferenceReading & { ok: true }
  crossings: LadderCrossings
}): Generated => {
  const { config, reading, crossings } = input
  const market = (reading.market as Read<NonNullable<LadderReading['market']>> & { ok: true })
    .value as NonNullable<Extract<LadderReading['market'], { ok: true }>>['value']
  const active = (reading.active as Extract<LadderReading['active'], { ok: true }>).value.quote
  const { rateBps: referenceRateBps, observationId, secondsToMaturity } = input.reference.value
  const targetRateBps = referenceRateBps + effectiveLadderPremiumBps(config, secondsToMaturity)
  const recenter = active
    ? shouldRecenter(active.centerRateBps, targetRateBps, config.movementToleranceBps)
    : true
  const maturity = secondsToMaturity === undefined ? {} : { secondsToMaturity }
  const generation = generateLadderWithDiagnostics({
    config,
    referenceRateBps,
    capacities: market,
    ...(active && !recenter ? { retainedCenterRateBps: active.centerRateBps } : {}),
    ...maturity
  })
  const generated = generation.quote
  const snapshotWithdrawnSides = SIDES.filter(
    side => market.withdrawnSides?.includes(side) && generated[side].length > 0
  )
  const desired: LadderQuoteSet = {
    ...generated,
    ...(snapshotWithdrawnSides.includes('lower') ? { lower: [] } : {}),
    ...(snapshotWithdrawnSides.includes('higher') ? { higher: [] } : {}),
    referenceObservationId: observationId
  }
  const publication =
    desired.lower.length === 0 && desired.higher.length === 0 ? undefined : desired
  let reason = reasonOf({ active, desired, recenter, publication, snapshotWithdrawnSides })

  const bookCrossing = crossingReport(config, market, crossings)
  const bookCrossedSides = bookCrossing
    ? SIDES.filter(
        side =>
          bookCrossing[side].crossed &&
          bookCrossing[side].clearable &&
          !bookCrossing[side].suppressed
      )
    : []
  if (reason === 'rest' && active && publication && bookCrossedSides.length > 0)
    reason = 'book-crossed'
  return {
    targetRateBps,
    diagnostics: generation.diagnostics,
    desired,
    ...(publication ? { publication } : {}),
    reason,
    bookCrossedSides,
    snapshotWithdrawnSides,
    ...(bookCrossing ? { bookCrossing: bookCrossing as Generated['bookCrossing'] & object } : {})
  }
}

const withdrawnField = (sides: readonly LadderWithdrawnSide[]) =>
  sides.length === 0 ? {} : { withdrawnSides: [...sides] }

type Context = Readonly<{
  ids: readonly string[]
  buys: readonly string[]
  sells: readonly string[]
  at: (decision: DecisionWithDetail) => DecisionWithDetail
}>

const halted = (c: Context, stage: string, reason: string, error: { errorName: string }) =>
  c.at({
    keep: c.ids,
    steady: false,
    halt: reason,
    detail: { status: 'halted', stage, errorName: error.errorName, strategyInvalidated: true }
  })

/** Cancels `ids` when any is live; otherwise the market rests with what it reports. */
const withdrawing = (
  c: Context,
  ids: readonly string[],
  condition: string,
  report: Classification,
  rest: Partial<Omit<DecisionWithDetail, 'detail'>> & { keep: readonly string[] },
  idle: Classification = report
) =>
  ids.length > 0
    ? c.at({ ...rest, act: cancel(ids, condition, report), steady: false, detail: report })
    : c.at({ ...rest, steady: true, detail: idle })

/**
 * The lending guard: a halted or unreadable guard cancels only the market's buys; a guard that failed
 * with its market's position read leaves the whole market to the failed market read.
 */
const guarded = (c: Context, reading: LadderReading) => {
  if (!reading.guard.ok && reading.market?.ok === false) return undefined
  if (!reading.guard.ok) {
    const report: Classification = {
      status: 'failed',
      stage: 'guard-read',
      invalidated: true,
      errorName: reading.guard.errorName,
      ...(reading.guard.adapterOperation
        ? { adapterOperation: reading.guard.adapterOperation }
        : {})
    }
    return withdrawing(c, c.buys, 'guard-read-failed', report, { keep: c.sells })
  }
  const lend = lendHalt(reading.guard.value)
  if (!lend) return undefined
  const report: Classification = {
    status: 'applied',
    action: 'lend-halted',
    reason: 'loss-factor-mismatch',
    ...lend
  }
  return withdrawing(
    c,
    c.buys,
    'loss-factor-mismatch',
    report,
    { keep: c.sells },
    {
      ...report,
      status: 'observed'
    }
  )
}

/** The active quote, the market read, maturity, and the reference, before anything is generated. */
const observed = (c: Context, input: LadderInput) => {
  const { reading } = input
  if (!reading.active?.ok)
    return halted(
      c,
      'decision',
      'ladder-decision-failed',
      reading.active ?? { errorName: 'UnknownError' }
    )
  if (!reading.market?.ok) {
    const report: Classification = {
      status: 'failed',
      stage: 'market-read',
      invalidated: c.ids.length > 0,
      errorName: reading.market?.errorName ?? 'UnknownError'
    }
    return withdrawing(c, c.ids, 'market-read-failed', report, { keep: [] })
  }
  if (marketObservationMatured(reading.market.value))
    return withdrawing(
      c,
      c.ids,
      'market-matured',
      { status: 'applied', action: 'matured' },
      { keep: [] },
      {
        status: 'observed',
        action: 'matured'
      }
    )
  // A reference not yet read waits; only a failed or stale one halts.
  if (input.reference.status === 'unobserved')
    return c.at({ keep: c.ids, steady: false, detail: { status: 'observed', action: 'rest' } })
  if (input.reference.status === 'ready' && !input.reference.value.ok)
    return halted(c, 'reference-read', 'reference-read-failed', input.reference.value)
  if (input.reference.status === 'failed')
    return halted(c, 'reference-read', 'reference-read-failed', {
      errorName: input.reference.failure.code
    })
  return undefined
}

/**
 * A prepared replacement: one act cancels the live groups and publishes the prepared tree, and the
 * kernel holds the publication until a decision after the cancellation still desires it.
 */
const replacing = (
  c: Context,
  generated: Generated & { reason: LadderReason },
  desire: string,
  prepare: LadderInput['prepare']
) => {
  const withdrawn = withdrawnField(generated.snapshotWithdrawnSides)
  if (prepare.status === 'pending' || prepare.status === 'unrequested')
    return c.at({
      keep: c.ids,
      desire,
      steady: false,
      detail: { status: 'observed', action: 'preparing' }
    })
  if (prepare.status !== 'ready' || !prepare.value.ok) {
    const failure = prepare.status === 'ready' && !prepare.value.ok ? prepare.value : undefined
    return c.at({
      keep: c.ids,
      desire,
      steady: true,
      detail: {
        status: 'failed',
        stage: 'reconcile',
        invalidated: false,
        errorName: failure?.errorName ?? `Prepare${prepare.status}`,
        ...(failure?.adapterOperation ? { adapterOperation: failure.adapterOperation } : {}),
        ...withdrawn
      }
    })
  }
  const prepared = prepare.value.value
  if (!prepared.reconciliation.applied)
    return c.at({
      keep: c.ids,
      desire,
      steady: true,
      detail: { status: 'observed', action: 'rest', ...withdrawn }
    })
  const withdrawnSides = [
    ...new Set([...generated.snapshotWithdrawnSides, ...(prepared.withdrawnSides ?? [])])
  ]
  if (!prepared.publication)
    return withdrawing(
      c,
      c.ids,
      generated.reason,
      {
        status: c.ids.length > 0 ? 'applied' : 'observed',
        action: 'publication-withdrawn',
        reason: generated.reason,
        withdrawnSides
      },
      { keep: [], desire }
    )
  const report: Classification = {
    status: 'applied',
    action: generated.reason === 'publish' ? 'publish' : 'replace',
    reason: generated.reason,
    ...withdrawnField(withdrawnSides)
  }
  return c.at({
    keep: [],
    desire,
    act: {
      kind: 'replace',
      identity: desire,
      payload: {
        cancel: c.ids,
        publication: prepared.publication,
        reconciliation: prepared.reconciliation,
        report
      } as never,
      condition: `${generated.reason}: ${ladderIdentity(prepared.publication.quote)}`
    },
    steady: false,
    detail: report
  })
}

/** What a ladder market observed and derived, from its decision's inputs. */
const ladderFacts = (input: LadderInput, generated: Generated | undefined): LadderFacts => {
  const { config, reading } = input
  const market = reading.market?.ok ? reading.market.value : undefined
  const active = reading.active?.ok ? reading.active.value : undefined
  const reference =
    input.reference.status === 'ready' && input.reference.value.ok
      ? input.reference.value.value
      : undefined
  const bookCrossing = market && crossingReport(config, market, input.crossings)
  return {
    bounds: { minimumRateBps: config.minimumRateBps, maximumRateBps: config.maximumRateBps },
    ...(reference ? { referenceRateBps: reference.rateBps } : {}),
    ...(generated
      ? { targetRateBps: generated.targetRateBps, diagnostics: generated.diagnostics }
      : {}),
    ...(market ? { market } : {}),
    ...(active?.quote ? { activeQuote: active.quote } : {}),
    ...(active ? { groupConsumption: active.consumption } : {}),
    ...(bookCrossing ? { bookCrossing } : {})
  }
}

/**
 * One ladder market's decision, in today's order of checks: the lending guard, the active quote,
 * the market read, maturity, the reference, then generation. A replacement is prepared against
 * the complete book before anything is cancelled.
 * @param input - The market's reading, config, reference, crossings, live view, and prepared answer.
 * @returns The decision with its act, if any, and the market report detail.
 */
export const decideLadder = (input: LadderInput): Decision & Readonly<{ detail: MarketReport }> => {
  const derived: { generated?: Generated } = {}
  const decision = decide(input, derived)
  return {
    ...decision,
    detail: {
      workflow: 'ladder',
      marketId: input.reading.marketId,
      ...decisionClassification(decision.detail, decision.act !== undefined),
      facts: ladderFacts(input, derived.generated)
    }
  }
}

const decide = (input: LadderInput, derived: { generated?: Generated }): DecisionWithDetail => {
  const { reading } = input
  const live = liveOf(input.view)
  const atBlock = (decision: DecisionWithDetail): DecisionWithDetail => decision
  const c: Context = {
    ids: live.map(group => group.id),
    buys: live.filter(group => group.buy).map(group => group.id),
    sells: live.filter(group => !group.buy).map(group => group.id),
    at: atBlock
  }
  const early = guarded(c, reading) ?? observed(c, input)
  if (early) return early
  const reference = (input.reference as Extract<Observed<ReferenceReading>, { status: 'ready' }>)
    .value as Extract<ReferenceReading, { ok: true }>

  let generated: Generated
  try {
    generated = generateLadderDecision({
      config: input.config,
      reading,
      reference,
      crossings: input.crossings
    })
  } catch (error) {
    return halted(c, 'decision', 'ladder-decision-failed', { errorName: operatorErrorName(error) })
  }
  derived.generated = generated
  const desire = ladderIdentity(generated.desired)
  const withdrawn = withdrawnField(generated.snapshotWithdrawnSides)
  if (generated.reason === 'rest')
    return c.at({
      keep: c.ids,
      desire,
      steady: true,
      detail: { status: 'observed', action: 'rest', ...withdrawn }
    })
  if (!generated.publication)
    return withdrawing(
      c,
      c.ids,
      generated.reason,
      {
        status: c.ids.length > 0 ? 'applied' : 'observed',
        action: generated.snapshotWithdrawnSides.length > 0 ? 'publication-withdrawn' : 'replace',
        reason: generated.reason,
        ...withdrawn
      },
      { keep: [], desire }
    )
  return replacing(c, { ...generated, reason: generated.reason }, desire, input.prepare)
}

/**
 * What a ladder act's prepare need asks for, recovered from the decision inputs.
 * @param input - The decision inputs without the prepared answer.
 * @returns The prepare parameters, or `undefined` when nothing is published or a check fails.
 */
export const ladderPrepareRequest = (input: Omit<LadderInput, 'prepare'>) => {
  const { reading } = input
  if (!reading.guard.ok || lendHalt(reading.guard.value)) return undefined
  if (!reading.active?.ok || !reading.market?.ok) return undefined
  if (marketObservationMatured(reading.market.value)) return undefined
  if (input.reference.status !== 'ready' || !input.reference.value.ok) return undefined
  try {
    const generated = generateLadderDecision({
      config: input.config,
      reading,
      reference: input.reference.value,
      crossings: input.crossings
    })
    if (generated.reason === 'rest' || !generated.publication) return undefined
    return ladderPrepareParams({
      reading,
      desired: generated.publication,
      reason: generated.reason,
      ...(generated.reason === 'book-crossed'
        ? { bookCrossedSides: generated.bookCrossedSides }
        : {})
    })
  } catch {
    return undefined
  }
}

/**
 * Advances a market's cooldown history from one settled replacement (today's quirk included).
 * @param crossings - Each side's last clearable crossing timestamp before the act.
 * @param payload - The settled act's payload; one without a reconciliation changes nothing.
 * @returns The crossings with each clearable crossed side stamped at the preparation time.
 */
export const advanceCrossings = (
  crossings: LadderCrossings,
  payload: LadderActPayload
): LadderCrossings => {
  if (!('reconciliation' in payload)) return crossings
  const next = { ...crossings }
  for (const side of SIDES) {
    const crossing = payload.reconciliation.bookCrossing[side]
    if (crossing.crossed && crossing.clearable)
      next[side] = payload.reconciliation.preparedAtTimestamp
  }
  return next
}
