import type {
  BootstrapDecisionDiagnostics,
  BootstrapOffer,
  BootstrapRate,
  PositionBootstrapDecision,
  ValidBootstrapConfig
} from '../../domain/position-bootstrap'
import type { BootstrapPreparation } from '../../infrastructure/bootstrap/production-bootstrap'
import type { Act, Decision, LiveView, Observed, Prepared } from './decision'
import type { BootstrapFacts, Classification, MarketReport } from './market-report'
import type { BootstrapReading, Read, ReferenceReading } from './readings'

import { marketObservationMatured } from '../../domain/market-maturity'
import {
  decidePositionBootstrapTransition,
  decidePositionBootstrapWithDiagnostics,
  effectiveBootstrapPremiumBps
} from '../../domain/position-bootstrap'
import { BootstrapConfigurationError } from '../../errors'
import { operatorErrorName } from '../monitoring/operator-error-name.utils'
import { decisionClassification } from './market-report'

/** What a bootstrap act carries: the plan's data and the outcome to report once it settles. */
export type BootstrapActPayload =
  | Readonly<{ cancel: readonly string[]; report: Classification }>
  | Readonly<{
      cancel: readonly string[]
      offer: BootstrapOffer
      publication: NonNullable<BootstrapPreparation['publication']>
      report: Classification
    }>

/**
 * What the bootstrap prepare need returns: the preparation, or a sanitized failure. A Router
 * minimum-size rejection carries the floor it reported as `minimumAssets`.
 */
export type BootstrapPrepareAnswer =
  | Extract<Read<BootstrapPreparation>, { ok: true }>
  | (Extract<Read<BootstrapPreparation>, { ok: false }> & Readonly<{ minimumAssets?: bigint }>)

/**
 * A bootstrap offer's semantic identity: what decides whether an active offer still rests.
 * @param offer - Desired bootstrap offer.
 * @returns A stable key; equal keys mean the resting offer needs no replacement.
 */
export const bootstrapIdentity = (offer: BootstrapOffer) =>
  [
    'bootstrap',
    offer.marketId.toLowerCase(),
    offer.assets,
    offer.rateBps,
    offer.referenceObservationId
  ].join('|')

type DecisionWithDetail = Decision & Readonly<{ detail: Classification }>

type BootstrapInput = Readonly<{
  config: ValidBootstrapConfig
  reading: BootstrapReading
  reference: Observed<ReferenceReading>
  view: LiveView
  prepare: Prepared<BootstrapPrepareAnswer>
}>

const cancel = (ids: readonly string[], condition: string, report: Classification): Act => ({
  kind: 'cancel',
  identity: `cancel:${ids.join(',')}`,
  payload: { cancel: [...ids], report } as never,
  condition
})

type Planned =
  | Readonly<{ waiting: true }>
  | Readonly<{ halt: string; stage: string; errorName: string; rate?: BootstrapRate }>
  | Readonly<{
      decision: PositionBootstrapDecision
      rate?: BootstrapRate
      diagnostics?: BootstrapDecisionDiagnostics
    }>

/** Today's planning pass for one market: the transitions that need no reference, then sizing. */
const planBootstrap = (
  input: Omit<BootstrapInput, 'view' | 'prepare'>,
  position: Extract<BootstrapReading['position'], { ok: true }>['value']
): Planned => {
  const { config, reading } = input
  let transition: ReturnType<typeof decidePositionBootstrapTransition>
  try {
    transition = decidePositionBootstrapTransition({
      config,
      position,
      lossFactor: position.lossFactor,
      ...(position.activeOffer ? { activeOffer: position.activeOffer } : {}),
      initialTargetCompleted: reading.initialTargetCompleted
    })
  } catch (error) {
    return {
      halt: 'bootstrap-decision-failed',
      stage: 'decision',
      errorName: operatorErrorName(error)
    }
  }
  if (transition) return { decision: transition }
  const reference = input.reference
  if (reference.status === 'unobserved') return { waiting: true }
  if (reference.status !== 'ready' || !reference.value.ok)
    return {
      halt: 'reference-read-failed',
      stage: 'reference-read',
      errorName:
        reference.status === 'ready' && !reference.value.ok
          ? reference.value.errorName
          : reference.status === 'failed'
            ? reference.failure.code
            : 'UnknownError'
    }
  const rate = reference.value.value
  try {
    const derived = decidePositionBootstrapWithDiagnostics({
      config,
      position,
      lossFactor: position.lossFactor,
      rate,
      ...(position.activeOffer ? { activeOffer: position.activeOffer } : {}),
      ...(position.requiresReconciliation ? { requiresReconciliation: true } : {}),
      initialTargetCompleted: reading.initialTargetCompleted
    })
    return { ...derived, rate }
  } catch (error) {
    return {
      halt: 'bootstrap-decision-failed',
      stage: 'decision',
      errorName: operatorErrorName(error),
      rate
    }
  }
}

/**
 * The prepare need's request: asked only while a publication or replacement is decided.
 * @param input - The market's reading and config, without the view or prepared answer.
 * @returns The offer to prepare at the reading's block, or `undefined` when nothing is prepared.
 */
export const bootstrapPrepareRequest = (input: Omit<BootstrapInput, 'view' | 'prepare'>) => {
  if (!input.reading.position.ok || marketObservationMatured(input.reading.position.value))
    return undefined
  const planned = planBootstrap(input, input.reading.position.value)
  if (!('decision' in planned)) return undefined
  const { decision } = planned
  return decision.kind === 'publish' || decision.kind === 'replace'
    ? {
        marketId: input.reading.marketId,
        desiredOffer: decision.offer,
        block: input.reading.block
      }
    : undefined
}

const invalidateAction = (reason: string) =>
  reason === 'loss-factor-mismatch' ? 'lend-halted' : 'invalidate'

/**
 * One bootstrap market's decision, in today's order: the position read, maturity, the transitions
 * that need no reference, then sizing at the reference. A publication is prepared against the
 * complete book first; a live group that already matches is kept, and anything else is replaced by
 * one act that cancels the market's groups and publishes the prepared offer.
 * @param input - The market's reading, config, live view, and prepared answer.
 * @returns The decision with its act, if any, and the market report detail.
 */
export const decideBootstrap = (
  input: BootstrapInput
): Decision & Readonly<{ detail: MarketReport }> => {
  const derived: { planned?: Planned } = {}
  const decision = decide(input, derived)
  return {
    ...decision,
    detail: {
      workflow: 'bootstrap',
      marketId: input.reading.marketId,
      ...decisionClassification(decision.detail, decision.act !== undefined),
      facts: bootstrapFacts(input, derived.planned)
    }
  }
}

const decide = (input: BootstrapInput, derived: { planned?: Planned }): DecisionWithDetail => {
  const { reading, view } = input
  const ids = view.live.map(commitment => commitment.id)
  const at = (decision: DecisionWithDetail): DecisionWithDetail => decision

  if (!reading.position.ok) {
    const guard = reading.position.adapterOperation === 'loss-factor-read'
    const report: Classification = {
      status: 'failed',
      stage: guard ? 'guard-read' : 'position-read',
      invalidated: ids.length > 0,
      errorName: reading.position.errorName
    }
    return ids.length > 0
      ? at({
          keep: [],
          act: cancel(ids, 'market-read-failed', report),
          steady: false,
          detail: report
        })
      : at({ keep: [], steady: true, detail: report })
  }
  if (marketObservationMatured(reading.position.value))
    return at({ keep: ids, steady: true, detail: { status: 'observed', action: 'matured' } })

  const planned = planBootstrap(input, reading.position.value)
  derived.planned = planned
  if ('waiting' in planned)
    return at({ keep: ids, steady: false, detail: { status: 'observed', action: 'rest' } })
  if ('halt' in planned)
    return at({
      keep: ids,
      steady: false,
      halt: planned.halt,
      detail: { status: 'halted', stage: planned.stage, errorName: planned.errorName }
    })
  return decided(input, planned, ids, at)
}

/** What a bootstrap market observed and derived, from its decision's inputs and its sizing. */
const bootstrapFacts = (input: BootstrapInput, planned: Planned | undefined): BootstrapFacts => {
  const { config, reading } = input
  const rate = planned && 'rate' in planned ? planned.rate : undefined
  const diagnostics = planned && 'diagnostics' in planned ? planned.diagnostics : undefined
  return {
    bounds: { minimumRateBps: config.minimumRateBps, maximumRateBps: config.maximumRateBps },
    creditTargetAssets: config.creditTarget,
    ...(reading.position.ok ? { creditAssets: reading.position.value.credit } : {}),
    ...(rate ? { referenceRateBps: rate.rateBps, ...targetOf(config, rate) } : {}),
    ...(diagnostics ? { diagnostics } : {})
  }
}

/** The target rate at a reference; a missing maturity is the decision's to report. */
const targetOf = (config: ValidBootstrapConfig, rate: BootstrapRate) => {
  try {
    return {
      targetRateBps: rate.rateBps + effectiveBootstrapPremiumBps(config, rate.secondsToMaturity)
    }
  } catch (error) {
    if (error instanceof BootstrapConfigurationError) return {}
    throw error
  }
}

/** The planned decision of a market whose position read, as today's mutation pass took it. */
const decided = (
  input: BootstrapInput,
  { decision, diagnostics }: Extract<Planned, { decision: PositionBootstrapDecision }>,
  ids: readonly string[],
  at: (decision: DecisionWithDetail) => DecisionWithDetail
): DecisionWithDetail => {
  const withdraw = (condition: string, report: Classification) =>
    ids.length > 0
      ? at({ keep: [], act: cancel(ids, condition, report), steady: false, detail: report })
      : at({ keep: [], steady: true, detail: { ...report, status: 'observed' } })
  switch (decision.kind) {
    case 'invalidate':
      return withdraw(decision.reason, {
        status: 'applied',
        action: invalidateAction(decision.reason),
        reason: decision.reason,
        ...('halt' in decision ? decision.halt : {})
      })
    case 'observe':
      return at({
        keep: ids,
        steady: true,
        detail: {
          status: 'observed',
          action: decision.reason === 'loss-factor-mismatch' ? 'lend-halted' : decision.reason,
          ...('halt' in decision ? { reason: decision.reason, ...decision.halt } : {})
        }
      })
    case 'target-reached':
      return at({
        keep: ids,
        steady: true,
        detail: { status: 'observed', action: 'target-reached' }
      })
    case 'rest':
      return at({
        keep: ids,
        desire: bootstrapIdentity(decision.offer),
        steady: true,
        detail: { status: 'observed', action: 'rest' }
      })
    case 'publish':
    case 'replace':
      return replacement(input, decision, boundBySpendableCash(diagnostics), ids, at)
    default: {
      const unhandled: never = decision
      throw new TypeError(`unhandled bootstrap decision ${String(unhandled)}`)
    }
  }
}

/** Whether wallet cash or the remaining allowance, the `cash-balance` cap, shrank the offer. */
const boundBySpendableCash = (diagnostics: BootstrapDecisionDiagnostics | undefined) =>
  diagnostics?.cap === 'cash-balance' && diagnostics.cappedAssets < diagnostics.requestedAssets

/**
 * A publication that could not be prepared: an empty rate window, or a cash-bound buy the Router
 * refused as below its minimum size, withholds it, cancelling what is live; a preparation that read
 * behind the world keeps what is live for the next poll; anything else could not prove the
 * publication safe, which halts the bot as before.
 */
const unprepared = (
  prepare: BootstrapInput['prepare'],
  desire: string,
  cashBound: boolean,
  ids: readonly string[],
  at: (decision: DecisionWithDetail) => DecisionWithDetail
): DecisionWithDetail => {
  const failure = prepare.status === 'ready' && !prepare.value.ok ? prepare.value : undefined
  const withhold = (condition: string, report: Classification) =>
    ids.length > 0
      ? at({ keep: [], desire, act: cancel(ids, condition, report), steady: false, detail: report })
      : at({ keep: [], desire, steady: true, detail: { ...report, status: 'observed' } })
  if (failure?.adapterOperation === 'head-behind-world')
    return at({
      keep: ids,
      desire,
      steady: false,
      detail: {
        status: 'failed',
        stage: 'decision',
        errorName: failure.errorName,
        adapterOperation: failure.adapterOperation
      }
    })
  if (failure?.minimumAssets !== undefined && cashBound)
    return withhold('no-capacity', {
      status: 'applied',
      action: 'publication-withheld',
      reason: 'below-minimum-offer',
      minimumAssets: String(failure.minimumAssets)
    })
  if (failure?.adapterOperation === 'rate-window-empty')
    return withhold('rate-out-of-range', {
      status: 'applied',
      action: 'publication-withheld',
      reason: 'rate-out-of-range'
    })
  return at({
    keep: ids,
    desire,
    steady: false,
    halt: 'bootstrap-decision-failed',
    detail: {
      status: 'halted',
      stage: 'decision',
      errorName: failure?.errorName ?? `Prepare${prepare.status}`,
      ...(failure?.adapterOperation ? { adapterOperation: failure.adapterOperation } : {})
    }
  })
}

const replacement = (
  input: BootstrapInput,
  decision: Extract<PositionBootstrapDecision, { kind: 'publish' | 'replace' }>,
  cashBound: boolean,
  ids: readonly string[],
  at: (decision: DecisionWithDetail) => DecisionWithDetail
): DecisionWithDetail => {
  const desire = bootstrapIdentity(decision.offer)
  const prepare = input.prepare
  if (prepare.status === 'pending' || prepare.status === 'unrequested')
    return at({
      keep: ids,
      desire,
      steady: false,
      detail: { status: 'observed', action: 'preparing' }
    })
  if (prepare.status !== 'ready' || !prepare.value.ok)
    return unprepared(prepare, desire, cashBound, ids, at)
  const prepared = prepare.value.value
  const report: Classification = { status: 'applied', action: decision.kind }
  if (prepared.retainedGroupId !== undefined) {
    const retained = input.view.live.find(
      commitment =>
        (commitment.detail as { groupId: string }).groupId.toLowerCase() ===
        prepared.retainedGroupId!.toLowerCase()
    )
    const others = ids.filter(id => id !== retained?.id)
    return others.length > 0
      ? at({
          keep: retained ? [retained.id] : [],
          desire,
          act: cancel(others, 'unchanged', { status: 'observed', action: 'rest' }),
          steady: false,
          detail: { status: 'observed', action: 'rest' }
        })
      : at({
          keep: retained ? [retained.id] : [],
          desire,
          steady: true,
          detail: { status: 'observed', action: 'rest' }
        })
  }
  if (!prepared.offer || !prepared.publication)
    return ids.length > 0
      ? at({
          keep: [],
          desire,
          act: cancel(ids, decision.kind, report),
          steady: false,
          detail: report
        })
      : at({ keep: [], desire, steady: true, detail: { ...report, status: 'observed' } })
  return at({
    keep: [],
    desire,
    act: {
      kind: 'replace',
      identity: desire,
      payload: {
        cancel: [...ids],
        offer: prepared.offer,
        publication: prepared.publication,
        report
      } as never,
      condition: `${decision.kind}: ${bootstrapIdentity(prepared.offer)}`
    },
    steady: false,
    detail: report
  })
}
