import type { Pruned } from './activity'
import type {
  Candidate,
  CandidateKind,
  CommitmentSpec,
  Command,
  DurableLedger,
  EndCode,
  Entry,
  BlockRef,
  Fact,
  GasFees,
  Hash,
  Id,
  KernelActivity,
  KernelConfig,
  KernelEvent,
  KernelState,
  Log,
  NonceRecord,
  Notice,
  Observation,
  OkValidatorReading,
  Origin,
  Payload,
  Phase,
  Plan,
  PlanInput,
  Refusal,
  RefusalCode,
  ValidatorReading,
  Release,
  ReleasePayload,
  Resolution,
  Resources,
  SignedBid,
  SignTerms,
  Step,
  StepSpec,
  TxPayload,
  TypedPayload,
  Validator
} from './types'

import { activityOf } from './activity'
import { asStored, encodeLedger, encodeStored, isHeld, toDurable } from './durable'
import { KernelConfigError } from './errors'
import { isChainFact } from './types'
import {
  authorityDefect,
  conflictsDefect,
  isCalldata,
  payloadDefect,
  recordedAuthority,
  sameAddress,
  validateLedger
} from './validation'

type ReduceResult = { state: KernelState; commands: Command[]; activity: KernelActivity[] }

const NOTHING: OkValidatorReading = {
  ok: true,
  creates: [],
  exposes: [],
  carries: [],
  retires: [],
  consumes: {}
}
const NEVER = Number.MAX_SAFE_INTEGER
/** Half the exact range, so no single event can issue enough requests to reach an inexact id. */
const REQUEST_CEILING = 2 ** 52
/** Far past any bot's need, and small enough that a block plus it stays a safe integer. */
const MAX_EVIDENCE_AGE_BLOCKS = 2 ** 32
const NO_PRUNE: Pruned = { nonces: [], plans: [] }
const NOTHING_TO_RESEND = 'a nonce at the fee ceiling has no recovery bid to re-send'

const larger = (a: bigint, b: bigint) => (a > b ? a : b)

/** Blocks and times from outside are compared, and `NaN` passes every comparison. */
const isBlockOrTime = (n: number) => Number.isSafeInteger(n) && n >= 0
/** Phases before the commit point of the current step's bid; a parked plan's next step has none. */
const UNCOMMITTED = new Set<Phase>([
  'ready',
  'materialize',
  'awaiting-advance',
  'simulate',
  'await-slot',
  'sign'
])
const biddingUncommitted = (plan: Plan) => UNCOMMITTED.has(plan.phase)
const OPEN_ENTRY = new Set(['exposed', 'live'])
const UNRETIRED = new Set(['intended', 'signed', 'exposed', 'live', 'revoking'])

/** A zero-value self-transfer with no calldata: it consumes a nonce and does nothing else. */
const fillPayload = (account: string): TxPayload => ({
  kind: 'tx',
  to: account,
  data: '0x',
  value: 0n
})

const initialState = (): KernelState => ({
  lifecycle: { kind: 'idle' },
  now: 0,
  finalized: { number: -1, timestamp: 0n },
  headers: {},
  entries: {},
  nonces: {},
  plans: {},
  planOrder: [],
  outstanding: {},
  nextRequest: 1,
  seq: 0,
  lastDurable: '',
  ackedSeq: 0,
  capacity: {},
  watermarks: {},
  conflictMarks: {},
  evidenceFloor: 0,
  releases: {},
  observations: {},
  submissions: {}
})

/** The ledger's encoding apart from its sequence number, so it changes only with the content. */
const durableText = (ledger: DurableLedger) =>
  encodeLedger({ ...ledger, header: { ...ledger.header, seq: 0 } })

/** Steps are taken in their stored form, so a restart re-reads exactly what was admitted and signed. */
const UNSTORABLE = 'step does not survive the ledger codec'

const asRefusal = (code: RefusalCode, reason: string): Refusal => ({ code, reason })

const EVIDENCE_EXPIRED = asRefusal('evidence_expired', 'evidence expired')
const PREDATES_OWN = 'predates our own'

/**
 * {@link authorityDefect}, tightened for live input: only a ledger's record may hold a fact with no
 * basis, and evidence must hold a chain fact to anchor the decision's basis.
 */
const liveAuthorityDefect = (evidence: readonly Fact[] | undefined, decision: unknown) => {
  const defect = authorityDefect(evidence, decision)
  if (defect) return defect
  if (!evidence?.length) return undefined
  if (evidence.some(fact => fact.basis === undefined)) return 'evidence names no basis'
  if (!evidence.some(isChainFact)) return 'evidence names no block'
  return undefined
}

const chainBlocks = (evidence: readonly Fact[] = []) =>
  evidence.filter(isChainFact).map(fact => fact.basis.block)

const STEP_KINDS: readonly unknown[] = ['sign', 'tx', 'release']

/** Plan steps are untrusted: their shape is checked before anything canonicalizes or reads them. */
const stepsDefect = (steps: unknown): string | undefined => {
  if (!Array.isArray(steps)) return 'steps are not a list'
  for (const [i, step] of steps.entries()) {
    const at = `step ${i}`
    if (typeof step !== 'object' || step === null || !STEP_KINDS.includes(step.kind))
      return `${at} has no known kind`
    if (step.payload !== undefined) {
      const defect = payloadDefect(step.payload, `${at} payload`)
      if (defect) return defect
    }
  }
  return undefined
}

const originOf = (step: Step): Origin => ({
  payload: step.payload!,
  ...(step.witness === undefined ? {} : { witness: step.witness })
})

const addTo = (total: Record<string, bigint>, resources: Resources, sign = 1n) => {
  for (const [key, amount] of Object.entries(resources))
    total[key] = (total[key] ?? 0n) + sign * amount
}

const remainingOf = (entry: Entry): Resources =>
  Object.fromEntries(
    Object.entries(entry.spec.resources).map(([key, amount]) => [
      key,
      amount - (entry.consumedFinal < amount ? entry.consumedFinal : amount)
    ])
  )

/**
 * Whether `plan`'s current transaction is counted against a recorded nonce instead of a reservation
 * of its own: the record at its terms holds a candidate of this step, or is a recovery plan's target.
 */
export const occupiesNonce = (state: KernelState, plan: Plan): boolean =>
  plan.terms !== undefined &&
  state.nonces[plan.terms.nonce] !== undefined &&
  (plan.recovery !== undefined || stepCandidates(state, plan).length > 0)

/** The candidates the plan's current step has committed, all at the one nonce its terms name. */
const stepCandidates = (state: KernelState, plan: Plan): Candidate[] =>
  state.nonces[plan.terms?.nonce ?? -1]?.candidates.filter(
    c => c.intentId === plan.intentId && c.step === plan.cursor
  ) ?? []

/**
 * Everything currently reserved, derived from state so it can never drift from the ledger. A
 * nonce's fee reserve is held until its transaction resolves, and again if a reorg undoes that.
 * Hazard: a reorg over-commits fees by one reserve per resolution it undoes, until it is observed,
 * and admission stops while holds exceed the cap.
 */
export const holds = (config: KernelConfig, state: KernelState): Record<string, bigint> => {
  const total: Record<string, bigint> = {}
  for (const entry of Object.values(state.entries)) {
    if (UNRETIRED.has(entry.state)) addTo(total, remainingOf(entry))
  }
  for (const record of Object.values(state.nonces)) {
    const exclusive: Record<string, bigint> = {}
    for (const candidate of record.candidates) {
      for (const [key, amount] of Object.entries(candidate.consumes)) {
        exclusive[key] = (exclusive[key] ?? 0n) > amount ? exclusive[key]! : amount
      }
    }
    addTo(total, exclusive)
    if (!record.resolution) addTo(total, { native: config.feeReserve })
  }
  for (const plan of Object.values(state.plans)) {
    if (plan.status !== 'executing') continue
    const remaining: Record<string, bigint> = { ...plan.envelope.consumes }
    addTo(remaining, plan.committedConsumes, -1n)
    for (const [key, amount] of Object.entries(remaining))
      if (amount > 0n) addTo(total, { [key]: amount })
    const committed = occupiesNonce(state, plan) ? plan.cursor + 1 : plan.cursor
    const txSteps = plan.steps.slice(committed).filter(step => step.kind === 'tx').length
    addTo(total, { native: config.feeReserve * BigInt(txSteps) })
  }
  return total
}

export const available = (config: KernelConfig, state: KernelState, resource: string): bigint => {
  const cap = config.caps[resource]
  const observed = state.capacity[resource]?.amount
  const limit =
    cap === undefined ? observed : observed === undefined ? cap : cap < observed ? cap : observed
  return (limit ?? 0n) - (holds(config, state)[resource] ?? 0n)
}

/** An `unknown` candidate is covered, and adds no uncertainty, once a higher bid at its nonce is accepted. */
const uncovered = (record: Pick<NonceRecord, 'candidates'>, c: Candidate) =>
  c.sent === 'unknown' &&
  !record.candidates.some(d => d.feeLevel > c.feeLevel && d.sent === 'accepted')

/**
 * A candidate read back from the ledger may have been sent, so it is `unknown` unless it was rejected
 * or withheld. Only one uncovered when stored keeps its age; the rest start one at the next head.
 */
const reloaded = (record: Pick<NonceRecord, 'candidates'>, c: Candidate): Candidate => {
  const { unknownSince, ...rest } = c
  const sent = c.sent === 'rejected' || c.sent === 'withheld' ? c.sent : 'unknown'
  const aged = unknownSince !== undefined && uncovered(record, c)
  return { ...rest, sent, ...(aged ? { unknownSince } : {}) }
}

/** How long a nonce has been uncertain: since the oldest of its uncovered `unknown` candidates. */
const uncertainSince = (record: NonceRecord): number | undefined => {
  const since = record.candidates.flatMap(c =>
    uncovered(record, c) && c.unknownSince !== undefined ? [c.unknownSince] : []
  )
  return since.length > 0 ? Math.min(...since) : undefined
}

/**
 * An unresolved nonce whose recovery could not outbid it under the fee ceiling: it bids no more and
 * re-sends what it signed, live but blocking every later nonce, until it resolves.
 */
export const waitsAtCeiling = (state: KernelState, record: NonceRecord): boolean =>
  !record.resolution &&
  Object.values(state.plans).some(
    p =>
      p.status === 'executing' &&
      p.recovery !== undefined &&
      p.terms?.nonce === record.nonce &&
      p.terms.capped === true
  )

/** Some unresolved nonce may be executing something the kernel cannot yet account for. */
export const latched = (state: KernelState): boolean =>
  Object.values(state.nonces).some(
    r => !r.resolution && (r.foreign === true || r.candidates.some(c => uncovered(r, c)))
  )

/** Nonces the chain has consumed that no evidence resolved yet: the transaction there must be identified. */
export const unidentifiedNonces = (state: KernelState) =>
  Object.values(state.nonces)
    .filter(r => !r.resolution && r.nonce < (state.chainNonce ?? 0))
    .map(r => r.nonce)

/** What the kernel's own chain sources poll each block, independent of the engine's frames. */
export const pollSet = (state: KernelState) => ({
  receipts: Object.values(state.nonces).flatMap(r =>
    r.resolution ? [] : r.candidates.map(c => c.hash)
  ),
  commitments: Object.values(state.entries)
    .filter(e => isHeld(e.state))
    .map(e => e.spec.id)
})

export const querySubmission = (state: KernelState, submissionId: Id) => {
  const record = state.submissions[submissionId]
  const active = Object.values(state.plans).find(
    p =>
      p.submissionId === submissionId && (p.status === 'executing' || p.status === 'compensating')
  )
  if (active) return 'in-progress'
  if (!record) return 'unknown'
  return record.status === 'exposed' ? 'interrupted' : record.status
}

/** A transaction's address and calldata are bytes, so their letter case is not part of the plan; nothing else is folded. */
const digestStep = (step: StepSpec) =>
  step.payload?.kind === 'tx'
    ? {
        ...step,
        payload: {
          ...step.payload,
          to: step.payload.to.toLowerCase(),
          data: step.payload.data.toLowerCase()
        }
      }
    : step

const digestOf = (input: PlanInput) => {
  const steps = input.steps.map(digestStep)
  return input.maxSpendWei === undefined
    ? encodeStored(steps)
    : encodeStored({ steps, maxSpendWei: input.maxSpendWei })
}

export const createKernel = (config: KernelConfig) => {
  const bound = config.maxEvidenceAgeBlocks
  if (!isBlockOrTime(bound) || bound > MAX_EVIDENCE_AGE_BLOCKS)
    throw new KernelConfigError(
      `maxEvidenceAgeBlocks must be an integer in [0, ${MAX_EVIDENCE_AGE_BLOCKS}]`
    )
  const readsVersion = (recorded: string) =>
    config.validators.some(
      v =>
        `${v.id}@${v.version}` === recorded ||
        (v.accepts ?? []).some(n => `${v.id}@${n}` === recorded)
    )

  const prunedFrom = new WeakMap<KernelState, Pruned>()
  const alarmsFrom = new WeakMap<KernelState, string[]>()
  const alarm = (s: KernelState, reason: string) => void alarmsFrom.get(s)?.push(reason)

  const reduce = (previous: KernelState, event: KernelEvent): ReduceResult => {
    const s = structuredClone(previous)
    const out: Command[] = []
    const closed =
      s.lifecycle.kind === 'stopped' || (s.lifecycle.kind === 'idle' && event.type !== 'Start')
    if (closed) {
      answerClosed(out, event, s.lifecycle.kind)
      return { state: s, commands: out, activity: activityOf(previous, event, s, out, NO_PRUNE) }
    }
    const pruned: Pruned = { nonces: [], plans: [] }
    prunedFrom.set(s, pruned)
    const alarms: string[] = []
    alarmsFrom.set(s, alarms)
    let cloned: KernelEvent | undefined
    try {
      cloned = structuredClone(event)
    } catch {
      refuseUncloneable(s, out, event)
    }
    if (cloned) handle(s, out, cloned)
    if (s.lifecycle.kind !== 'stopped') afterEvent(s, out)
    if (event.type === 'Head') pruneHeaders(s)
    return {
      state: s,
      commands: structuredClone(out),
      activity: structuredClone(activityOf(previous, event, s, out, pruned, alarms))
    }
  }

  /** A kernel that takes no requests still answers each one, so nothing waits on an answer. */
  const answerClosed = (out: Command[], event: KernelEvent, lifecycle: string) => {
    if (event.type === 'Submit' && typeof event.plan?.intentId === 'string')
      refuse(out, event.plan.intentId, asRefusal('lifecycle', lifecycle))
    if (event.type === 'Advance' && typeof event.intentId === 'string')
      notify(out, event.intentId, 'stalled', lifecycle)
  }

  /** An event holding a function or other uncloneable value is refused or ignored, never thrown. */
  const refuseUncloneable = (s: KernelState, out: Command[], event: KernelEvent) => {
    if (event.type === 'Submit' && typeof event.plan.intentId === 'string')
      return refuse(out, event.plan.intentId, asRefusal('malformed', UNSTORABLE))
    const taken =
      event.type === 'Materialized' && Number.isSafeInteger(event.request)
        ? take(s, event.request, ['materialize'])
        : undefined
    if (taken) return failPlan(s, out, taken.plan, UNSTORABLE)
    alarm(s, `malformed ${event.type} event ignored`)
  }

  const emit = (out: Command[], command: Command): void => {
    out.push(command)
  }
  const notify = (
    out: Command[],
    intentId: Id,
    notice: Exclude<Notice, 'refused'>,
    reason?: string
  ): void => emit(out, { type: 'notify', intentId, notice, ...(reason ? { reason } : {}) })
  const refuse = (out: Command[], intentId: Id, refusal: Refusal): void =>
    emit(out, { type: 'notify', intentId, notice: 'refused', ...refusal })
  /**
   * A plan's last notice carries its inclusions, since the nonce records behind them may be pruned
   * first, and says `cancelled` only when a cancel ended it and nothing of it ran ({@link Plan.cancelled}),
   * or the `code` {@link failPlan} gives an unexposed plan when nothing of it ran.
   */
  const notifyEnded = (
    out: Command[],
    plan: Plan,
    notice: Exclude<Notice, 'refused'>,
    reason?: string,
    code?: Exclude<EndCode, 'cancelled'>
  ): void => {
    const included = [...(plan.included ?? [])]
    const body = {
      type: 'notify',
      intentId: plan.intentId,
      ...(reason ? { reason } : {}),
      included
    } as const
    const ended = notice === 'abandoned' || notice === 'compensated'
    if (ended && plan.cancelled && !plan.neutralized && included.length === 0)
      return emit(out, { ...body, notice, code: 'cancelled' })
    if (notice === 'abandoned' && code !== undefined && included.length === 0)
      return emit(out, { ...body, notice, code })
    emit(out, { ...body, notice })
  }

  const canonical = (s: KernelState, e: BlockRef) => s.headers[e.block] === e.blockHash
  const isFinal = (s: KernelState, e: BlockRef) => e.block <= s.finalized.number && canonical(s, e)

  const validatorFor = (payload: Payload): Validator | ValidatorReading => {
    const claimed: Validator[] = []
    for (const v of config.validators) {
      try {
        if (v.claims(payload)) claimed.push(v)
      } catch {
        return { ok: false, reason: `validator ${v.id} threw in claims` }
      }
    }
    if (claimed.length === 0) return { ok: false, reason: 'no validator recognizes the action' }
    if (claimed.length > 1) return { ok: false, reason: 'ambiguous validator' }
    return claimed[0]!
  }

  const readSafely = (
    validator: Validator,
    payload: Payload,
    witness: unknown
  ): ValidatorReading => {
    try {
      return validator.read(payload, witness, { account: config.account, chainId: config.chainId })
    } catch {
      return { ok: false, reason: `validator ${validator.id} threw` }
    }
  }

  const authorize = (
    payload: Payload,
    witness: unknown,
    mode: 'normal' | 'recovery'
  ): ValidatorReading => {
    if (payload.kind === 'tx' && !isCalldata(payload.data))
      return { ok: false, reason: 'calldata is not whole bytes of hex' }
    if (payload.kind === 'tx' && sameAddress(payload.to, config.account)) {
      return mode === 'recovery' && payload.value === 0n && payload.data === '0x'
        ? NOTHING
        : { ok: false, reason: 'fill outside recovery' }
    }
    const validator = validatorFor(payload)
    if ('ok' in validator) return validator
    const reading = readSafely(validator, payload, witness)
    if (!reading.ok) return reading
    if (unrecorded(payload, reading))
      return {
        ok: false,
        reason: `a ${payload.kind} payload reads effects its act does not record`
      }
    if (payload.kind === 'tx') {
      const allowed = mode === 'normal' ? config.policy.targets : config.policy.recoveryTargets
      if (!allowed.some(target => sameAddress(target, payload.to)))
        return { ok: false, reason: `policy: target ${payload.to}` }
    }
    const risky =
      reading.creates.length > 0 || reading.exposes.length > 0 || positive(reading.consumes)
    if (mode === 'recovery' && risky)
      return { ok: false, reason: 'recovery policy: not risk-reducing' }
    return reading
  }

  const positive = (resources: Resources) => Object.values(resources).some(amount => amount > 0n)
  /** Only a transaction's commit records retirement and consumption, and a release records no creation. */
  const unrecorded = (payload: Payload, reading: OkValidatorReading) =>
    (payload.kind !== 'tx' && (reading.retires.length > 0 || positive(reading.consumes))) ||
    (payload.kind === 'release' && reading.creates.length > 0)
  /**
   * Exposure is what the bytes commit beyond their own transaction: commitments, and resources the
   * validators read them consuming. Fees are reserved apart under `feeReserve`, never in the envelope.
   */
  const riskIncreasing = (plan: Plan) =>
    plan.envelope.ids.length > 0 || positive(plan.envelope.consumes)
  const mayIncreaseRisk = (s: KernelState) => s.lifecycle.kind === 'running' && !latched(s)

  const riskReducing = (plan: Plan) =>
    !riskIncreasing(plan) && plan.steps.some(step => (step.reading?.retires.length ?? 0) > 0)

  /** Only neutralizing work runs outside `running` or while latched; neutral work is new exposure too. */
  const lifecycleAllows = (s: KernelState, plan: Plan) =>
    plan.recovery !== undefined ||
    mayIncreaseRisk(s) ||
    (riskReducing(plan) && s.lifecycle.kind !== 'stopped')

  /** Why a plan may not go on past its deadline, in any phase: its evidence, or the intent, expired. */
  const expired = (s: KernelState, plan: Plan): string | undefined => {
    if (s.now < plan.notAfter) return undefined
    return plan.evidence?.length ? EVIDENCE_EXPIRED.reason : 'intent expired'
  }

  /** Past its commit, the clock and {@link withholdReason} hold a step to its deadline. */
  const decisionRefusal = (s: KernelState, plan: Plan): string | undefined => {
    if (!lifecycleAllows(s, plan)) return 'lifecycle forbids this action'
    if (plan.recovery || !biddingUncommitted(plan)) return undefined
    return expired(s, plan)
  }

  const predatesOwnEffect = (s: KernelState, plan: Plan): string | undefined => {
    if (plan.recovery) return undefined
    const specs = plan.envelope.ids.flatMap(id => s.entries[id]?.spec ?? [])
    return staleBasis(s, plan, specs)?.reason
  }

  /** No fact read below it is admitted, so a conflict mark at or below it can refuse nothing. */
  const evidenceFloor = (s: KernelState) =>
    Math.max(s.evidenceFloor, (s.head?.number ?? 0) - config.maxEvidenceAgeBlocks, 0)

  /** Why the facts a plan rests on no longer hold, as the kernel last observed them. */
  const factRefusal = (s: KernelState, plan: Plan): Refusal | undefined => {
    const conflicts = [...(plan.conflicts?.reads ?? []), ...(plan.conflicts?.writes ?? [])]
    const floor = evidenceFloor(s)
    for (const fact of plan.evidence ?? []) {
      const chain = isChainFact(fact)
      if (chain && fact.basis.block < floor)
        return asRefusal('evidence_too_old', `evidence ${fact.id} read below block ${floor}`)
      const invalid = (why: string) => asRefusal('evidence_invalid', `evidence ${fact.id} ${why}`)
      const seen = s.observations[fact.id]
      if (!seen) return invalid('unobserved')
      if ('unavailable' in seen) return invalid(seen.unavailable)
      if (seen.version !== fact.version) return invalid('changed')
      if (!chain) {
        if (seen.expiry === undefined) return invalid('is offchain with no expiry')
        continue
      }
      const held = s.headers[fact.basis.block]
      if (held === undefined) return invalid('read at a block the kernel does not hold')
      if (held !== fact.basis.blockHash) return invalid('read on an orphaned block')
      const stale = conflicts.find(id => fact.basis.block < (s.conflictMarks[id] ?? -1))
      if (stale !== undefined)
        return asRefusal(
          'evidence_predates_own_effect',
          `evidence ${fact.id} ${PREDATES_OWN} effect on ${stale}`
        )
    }
    return undefined
  }

  /**
   * Facts bind a neutral plan until its bid commits and a risk-increasing one until dispatch; a
   * risk-reducing one never. The deadline binds every non-recovery plan in every phase: {@link expired}.
   */
  const evidenceRefusal = (s: KernelState, plan: Plan): Refusal | undefined => {
    if (plan.recovery || riskReducing(plan)) return undefined
    if (!biddingUncommitted(plan) && !riskIncreasing(plan)) return undefined
    if (s.now >= plan.notAfter) return EVIDENCE_EXPIRED
    return factRefusal(s, plan)
  }

  const stillAuthorized = (s: KernelState, plan: Plan): string | undefined =>
    decisionRefusal(s, plan) ?? predatesOwnEffect(s, plan) ?? evidenceRefusal(s, plan)?.reason

  /**
   * A decision sized against a resource before our own final effect on it is refused at admission,
   * at the act, and at each `Advance`, whose basis must also follow the plan's own inclusion. Each
   * fact it read is held to that, not only the latest.
   */
  const staleBasis = (
    s: KernelState,
    plan: Plan,
    specs: readonly { resources: Record<string, bigint> }[]
  ): Refusal | undefined => {
    const resources = [
      ...Object.keys(plan.envelope.consumes),
      ...specs.flatMap(spec => Object.keys(spec.resources))
    ]
    const oldest = Math.min(plan.basisBlock, ...chainBlocks(plan.evidence))
    const stale = resources.find(resource => oldest < (s.watermarks[resource] ?? 0))
    if (stale === undefined) return undefined
    return asRefusal(
      'decision_predates_own_effect',
      `decision ${PREDATES_OWN} final effect on ${stale}`
    )
  }

  /** Policy is the mode in force now, not at admission: a halt narrows every later step. */
  const reauthorized = (s: KernelState, plan: Plan): string | undefined => {
    const step = plan.steps[plan.cursor]!
    const mode = plan.recovery || !mayIncreaseRisk(s) ? 'recovery' : 'normal'
    const reading = authorize(step.payload!, step.witness, mode)
    return reading.ok ? undefined : `policy now refuses: ${reading.reason}`
  }

  const simFresh = (s: KernelState, plan: Plan) =>
    plan.sim !== undefined &&
    s.head !== undefined &&
    canonical(s, plan.sim) &&
    plan.sim.block >= s.head.number - config.maxSimLagBlocks &&
    (plan.lastInclusion === undefined || plan.sim.block >= plan.lastInclusion)

  const request = (
    s: KernelState,
    plan: Plan,
    kind: 'materialize' | 'simulate' | 'sign' | 'broadcast' | 'release'
  ) => {
    const n = s.nextRequest++
    const hash = kind === 'broadcast' ? plan.pending?.hash : undefined
    s.outstanding[n] = { kind, plan: plan.intentId, ...(hash ? { hash } : {}) }
    plan.request = n
    return n
  }

  const releaseSlot = (s: KernelState, n: number) => {
    delete s.outstanding[n]
    if (s.slot === n) s.slot = undefined
  }

  const take = (s: KernelState, n: number, kinds: readonly string[]) => {
    const outstanding = s.outstanding[n]
    if (!outstanding || !kinds.includes(outstanding.kind)) return undefined
    releaseSlot(s, n)
    const plan = s.plans[outstanding.plan]
    return plan && plan.status === 'executing' ? { plan, outstanding } : undefined
  }

  const findCandidate = (s: KernelState, hash: string): [NonceRecord, Candidate] | undefined => {
    for (const record of Object.values(s.nonces)) {
      const candidate = record.candidates.find(c => c.hash === hash)
      if (candidate) return [record, candidate]
    }
    return undefined
  }

  const owned = (s: KernelState, id: Id) => isHeld(s.entries[id]?.state)

  const referencesUnresolved = (s: KernelState, intentId: Id) =>
    Object.values(s.entries).some(e => e.intentId === intentId && UNRETIRED.has(e.state)) ||
    Object.values(s.nonces).some(r => r.candidates.some(c => c.intentId === intentId))

  const beginRecovering = (s: KernelState, out: Command[], reason: string) => {
    if (s.lifecycle.kind !== 'running' && s.lifecycle.kind !== 'starting') return
    s.lifecycle = { kind: 'recovering', reason, since: s.now, alarmed: false }
    for (const id of s.planOrder) {
      const plan = s.plans[id]!
      if (plan.status !== 'executing' || !biddingUncommitted(plan) || lifecycleAllows(s, plan))
        continue
      const why = `recovering: ${reason}`
      if (occupiesNonce(s, plan)) cancel(s, out, plan, why)
      else failPlan(s, out, plan, why)
    }
  }

  const enterRecovering = (s: KernelState, out: Command[], reason: string) => {
    beginRecovering(s, out, reason)
    if (s.lifecycle.kind !== 'recovering' || s.lifecycle.alarmed) return
    s.lifecycle.alarmed = true
    alarm(s, reason)
  }

  const stop = (
    s: KernelState,
    out: Command[],
    outcome: 'clean' | 'unsafe' | 'refused',
    reason: string
  ) => {
    s.lifecycle = { kind: 'stopped', outcome, reason }
    emit(out, {
      type: 'report',
      outcome,
      reason,
      open: {
        entries: Object.values(s.entries)
          .filter(e => UNRETIRED.has(e.state))
          .map(e => e.spec.id),
        nonces: Object.values(s.nonces).map(r => r.nonce)
      }
    })
  }

  const STEP_PAYLOAD = { sign: 'typed', tx: 'tx', release: 'release' } as const

  type Admitted = {
    steps: Step[]
    specs: { spec: CommitmentSpec; validator: string }[]
    consumes: Record<string, bigint>
  }

  /** Reads every payload the plan already carries; the envelope is what those readings say, nothing else. */
  const readSteps = (
    s: KernelState,
    input: PlanInput,
    mode: 'normal' | 'recovery'
  ): Admitted | Refusal => {
    const admitted: Admitted = { steps: [], specs: [], consumes: {} }
    const created = () => admitted.specs.map(c => c.spec.id)
    const unauthorized = (reason: string) => asRefusal('unauthorized', reason)
    for (const spec of input.steps) {
      if (!spec.payload) {
        admitted.steps.push({ ...spec })
        continue
      }
      if (STEP_PAYLOAD[spec.kind] !== spec.payload.kind)
        return asRefusal('malformed', 'step kind does not match payload')
      const reading = authorize(spec.payload, spec.witness, mode)
      if (!reading.ok) return unauthorized(reading.reason)
      if (reading.exposes.some(id => !created().includes(id)))
        return unauthorized('exposes a commitment no earlier step signs')
      if (reading.retires.some(id => !owned(s, id)))
        return unauthorized('neutralizes a commitment the kernel does not own')
      const validator = validatorFor(spec.payload) as Validator
      for (const commitment of reading.creates) {
        if (s.entries[commitment.id] || created().includes(commitment.id))
          return unauthorized(`commitment ${commitment.id} exists`)
        admitted.specs.push({ spec: commitment, validator: `${validator.id}@${validator.version}` })
      }
      addTo(admitted.consumes, reading.consumes)
      admitted.steps.push({ ...spec, reading })
    }
    return admitted
  }

  /** Admission and reservation are one transition: a refusal here leaves no trace in state. */
  const capacityRefusal = (s: KernelState, admitted: Admitted): Refusal | undefined => {
    const need: Record<string, bigint> = { ...admitted.consumes }
    for (const { spec } of admitted.specs) addTo(need, spec.resources)
    const txSteps = admitted.steps.filter(step => step.kind === 'tx').length
    addTo(need, { native: config.feeReserve * BigInt(txSteps) })
    for (const [resource, amount] of Object.entries(need)) {
      if (amount === 0n) continue
      const observedAt = s.capacity[resource]?.block ?? -1
      if (
        config.observedResources.includes(resource) &&
        observedAt < (s.watermarks[resource] ?? 0)
      ) {
        return asRefusal(
          'capacity',
          `capacity of ${resource} not observed since our last effect on it`
        )
      }
      if (available(config, s, resource) < amount)
        return asRefusal('capacity', `insufficient ${resource}`)
    }
    return undefined
  }

  /** A submission id is claimed by an active plan from admission, or by its durable record from first exposure. */
  const firstDigest = (s: KernelState, sid: Id) =>
    Object.values(s.plans).find(
      p => p.submissionId === sid && (p.status === 'executing' || p.status === 'compensating')
    )?.digest ?? s.submissions[sid]?.digest

  /** Refusals that need no validator reading: duplicates, a bad fee ceiling, a closed lifecycle. */
  const earlyRefusal = (s: KernelState, input: PlanInput): Refusal | undefined => {
    const existing = s.plans[input.intentId]
    if (existing && (existing.status === 'executing' || existing.status === 'compensating'))
      return asRefusal('duplicate', 'duplicate')
    if (referencesUnresolved(s, input.intentId))
      return asRefusal('duplicate', 'duplicate: unresolved exposure')
    if (input.maxSpendWei !== undefined && input.maxSpendWei <= 0n)
      return asRefusal('malformed', 'fee ceiling must be positive')
    if (![input.basisBlock, input.notAfter, input.validUntil ?? 0].every(isBlockOrTime))
      return asRefusal('malformed', 'basis block and expiry must be non-negative safe integers')
    if (s.now >= input.notAfter) return EVIDENCE_EXPIRED
    const lifecycle = s.lifecycle.kind
    if (lifecycle !== 'running' && lifecycle !== 'recovering' && lifecycle !== 'starting')
      return asRefusal('lifecycle', lifecycle)
    return undefined
  }

  /** The earliest of `notAfter` and each expiry the kernel holds for `facts`. */
  const withDeadline = (s: KernelState, notAfter: number, facts: readonly Fact[] = []) => {
    let deadline = notAfter
    for (const fact of facts) {
      const seen = s.observations[fact.id]
      if (seen && 'expiry' in seen && seen.expiry !== undefined)
        deadline = Math.min(deadline, seen.expiry)
    }
    return deadline
  }

  const admittedPlan = (
    s: KernelState,
    input: PlanInput,
    digest: string,
    admitted: Admitted
  ): Plan => ({
    intentId: input.intentId,
    ...(input.submissionId ? { submissionId: input.submissionId } : {}),
    digest,
    steps: admitted.steps,
    cursor: 0,
    phase: 'ready',
    status: 'executing',
    stage: 0,
    signatures: [],
    envelope: { ids: admitted.specs.map(c => c.spec.id), consumes: admitted.consumes },
    committedConsumes: {},
    exposed: false,
    basisBlock: input.basisBlock,
    notAfter: withDeadline(s, Math.min(input.notAfter, input.validUntil ?? NEVER), input.evidence),
    ...(input.validUntil !== undefined && { validUntil: input.validUntil }),
    ...(input.maxSpendWei !== undefined ? { maxSpendWei: input.maxSpendWei } : {}),
    ...(input.evidence ? { evidence: input.evidence.map(fact => ({ ...fact })) } : {}),
    ...(input.conflicts ? { conflicts: conflictsOf(input.conflicts) } : {}),
    ...(input.decision ? { decision: { ...input.decision } } : {}),
    admittedHead: s.head?.number ?? 0
  })

  const conflictsOf = (conflicts: NonNullable<PlanInput['conflicts']>) => ({
    reads: [...(conflicts.reads ?? [])],
    writes: [...(conflicts.writes ?? [])]
  })

  const meets = (left: readonly string[] = [], right: readonly string[] = []) =>
    left.some(id => right.includes(id))

  /** An executing plan whose writes meet `plan`'s reads or writes, or the reverse. */
  const conflicting = (s: KernelState, plan: Plan) =>
    Object.values(s.plans).find(other => {
      if (other.status !== 'executing' || other.intentId === plan.intentId) return false
      const mine = plan.conflicts
      const theirs = other.conflicts
      return (
        meets(theirs?.writes, [...(mine?.reads ?? []), ...(mine?.writes ?? [])]) ||
        meets(mine?.writes, [...(theirs?.reads ?? []), ...(theirs?.writes ?? [])])
      )
    })

  /** Whether `plan` may replace `replaced`: never recovery, and a risk-reducing plan only by another. */
  const supersessionRefusal = (replaced: Plan, plan: Plan): Refusal | undefined => {
    if (replaced.recovery) return asRefusal('supersession', 'recovery is never superseded')
    if (riskReducing(replaced) && !riskReducing(plan))
      return asRefusal('supersession', 'only a risk-reducing plan supersedes a risk-reducing one')
    return undefined
  }

  /**
   * Admission, in order: a superseded plan is set aside first, so conflicts are judged without it;
   * then policy and validators, conflicts, the lifecycle, reservation, and evidence. It runs on a
   * copy when a plan is superseded, so a refusal leaves no trace but the observations it carried, and
   * the superseded plan, which must not have committed a step, fails only once this one is admitted.
   */
  const admission = (s: KernelState, input: PlanInput, digest: string) => {
    const superseded = input.supersedes === undefined ? undefined : s.plans[input.supersedes]
    const replaced = superseded?.status === 'executing' ? superseded : undefined
    if (replaced && (occupiesNonce(s, replaced) || !biddingUncommitted(replaced)))
      return asRefusal(
        'supersession',
        `${replaced.intentId} is past its commit and cannot be superseded`
      )
    const trial = replaced ? structuredClone(s) : s
    if (trial !== s) alarmsFrom.set(trial, [])
    const setAside: Command[] = []
    if (replaced)
      failPlan(trial, setAside, trial.plans[replaced.intentId]!, `superseded by ${input.intentId}`)
    const lifecycle = trial.lifecycle.kind
    const admitted = readSteps(trial, input, mayIncreaseRisk(trial) ? 'normal' : 'recovery')
    if ('code' in admitted) return admitted
    const plan = admittedPlan(trial, input, digest, admitted)
    const blocked = replaced && supersessionRefusal(replaced, plan)
    if (blocked) return blocked
    const conflict = conflicting(trial, plan)
    if (conflict) return asRefusal('conflict', `conflicts with ${conflict.intentId}`)
    if (!lifecycleAllows(trial, plan))
      return asRefusal('lifecycle', latched(trial) ? 'latched' : `lifecycle ${lifecycle}`)
    const specs = admitted.specs.map(({ spec }) => spec)
    return (
      capacityRefusal(trial, admitted) ??
      staleBasis(trial, plan, specs) ??
      evidenceRefusal(trial, plan) ?? { trial, setAside, plan, admitted }
    )
  }

  const adopt = (s: KernelState, trial: KernelState) => {
    if (trial === s) return
    Object.assign(s, trial)
    for (const reason of alarmsFrom.get(trial) ?? []) alarm(s, reason)
  }

  const submit = (
    s: KernelState,
    out: Command[],
    submitted: PlanInput,
    observations: readonly Observation[] = []
  ): void => {
    const refuseAs = (refusal: Refusal) => refuse(out, submitted.intentId, refusal)
    const malformed = (reason: string) => refuseAs(asRefusal('malformed', reason))
    const ids = [submitted.intentId, submitted.submissionId ?? '', submitted.supersedes ?? '']
    if (!ids.every(id => typeof id === 'string')) return malformed('ids are not strings')
    if (submitted.maxSpendWei !== undefined && typeof submitted.maxSpendWei !== 'bigint')
      return malformed('fee ceiling is not an amount')
    const inherited = [submitted.intentId, submitted.submissionId, submitted.supersedes].find(
      id => id !== undefined && id in Object.prototype
    )
    if (inherited !== undefined) return malformed(`id ${inherited} names an inherited property`)
    const steps = asStored(submitted.steps)
    if (!steps) return malformed(UNSTORABLE)
    const defect =
      stepsDefect(steps.value) ??
      liveAuthorityDefect(submitted.evidence, submitted.decision) ??
      conflictsDefect(submitted.conflicts)
    if (defect) return malformed(defect)
    observe(s, observations)
    const input = { ...submitted, steps: steps.value as PlanInput['steps'] }
    const digest = digestOf(input)
    const first = input.submissionId ? firstDigest(s, input.submissionId) : undefined
    if (first !== undefined && first !== digest) {
      return refuseAs(
        asRefusal('duplicate', `submission ${input.submissionId} conflicts with its first payload`)
      )
    }
    if (first !== undefined) {
      return notify(out, input.intentId, 'known', querySubmission(s, input.submissionId!))
    }
    const early = earlyRefusal(s, input)
    if (early) return refuseAs(early)
    const admitted = admission(s, input, digest)
    if ('code' in admitted) return refuseAs(admitted)
    const { trial, setAside, plan } = admitted
    adopt(s, trial)
    out.push(...setAside)
    for (const { spec, validator } of admitted.admitted.specs) {
      s.entries[spec.id] = {
        spec,
        state: 'intended',
        intentId: plan.intentId,
        validator,
        creators: [],
        deadCreators: [],
        consumedFinal: 0n,
        recoveryAttempts: 0,
        stuck: false,
        compensate: false,
        affirmedAt: s.now
      }
    }
    s.plans[plan.intentId] = plan
    s.planOrder.push(plan.intentId)
    notify(out, plan.intentId, 'admitted')
    advance(s, out, plan)
  }

  /** The ids a batch names more than once, whose last reading alone cannot vouch for the fact. */
  const repeated = (observations: readonly Observation[]) => {
    const ids = observations.map(observation => (observation as { id?: unknown }).id)
    return new Set(ids.filter((id, i) => typeof id === 'string' && ids.indexOf(id) !== i))
  }

  /**
   * Takes in observations; one that is malformed is dropped with an alarm, never trusted, and one
   * whose expiry is malformed reads as failed. Once the whole batch is in, an expiry shortens the
   * `notAfter` of each executing plan whose current stage rests on the fact, unless the plan is
   * {@link resting} and every fact it rests on reads as decided.
   */
  const observe = (s: KernelState, observations: readonly Observation[]) => {
    const expiries = new Map<Id, number>()
    const seenTwice = repeated(observations)
    for (const observation of observations) {
      const { id, version, unavailable, expiry } = observation as Record<string, unknown>
      const wellFormed =
        typeof id === 'string' &&
        !(id in Object.prototype) &&
        (typeof version === 'string' || unavailable === 'unknown' || unavailable === 'failed')
      if (!wellFormed) {
        alarm(s, 'malformed observation ignored')
        continue
      }
      if (typeof version !== 'string') {
        s.observations[id] = { id, unavailable: unavailable as 'unknown' | 'failed' }
        continue
      }
      if (expiry === undefined) {
        s.observations[id] = { id, version }
        continue
      }
      if (typeof expiry !== 'number' || !isBlockOrTime(expiry)) {
        alarm(s, 'malformed observation expiry')
        s.observations[id] = { id, unavailable: 'failed' }
        continue
      }
      s.observations[id] = { id, version, expiry }
      expiries.set(id, Math.min(expiries.get(id) ?? expiry, expiry))
    }
    for (const plan of Object.values(s.plans)) {
      if (plan.status !== 'executing') continue
      const seen = (plan.evidence ?? []).flatMap(fact => expiries.get(fact.id) ?? [])
      if (seen.length === 0) continue
      const settled = !plan.evidence!.some(fact => seenTwice.has(fact.id))
      const refreshed = settled && resting(s, plan) ? reread(s, plan) : undefined
      plan.notAfter =
        refreshed === undefined
          ? Math.min(plan.notAfter, ...seen)
          : Math.min(refreshed, plan.validUntil ?? NEVER)
    }
  }

  /** A {@link resting} plan's deadline while every fact it rests on still reads as decided. */
  const reread = (s: KernelState, plan: Plan): number | undefined => {
    if (!plan.evidence?.length) return undefined
    const expiries = plan.evidence.map(fact => {
      const seen = s.observations[fact.id]
      return seen && 'version' in seen && seen.version === fact.version ? seen.expiry : undefined
    })
    return expiries.every(expiry => expiry !== undefined) ? Math.min(...expiries) : undefined
  }

  /**
   * Whether no step of `plan` is judged on its evidence again before it bids or an `Advance` decides
   * afresh, so an equal re-read only keeps it alive; a plan already past its deadline is never revived.
   */
  const resting = (s: KernelState, plan: Plan) =>
    (plan.phase === 'include' || plan.phase === 'awaiting-advance') && s.now < plan.notAfter

  /** Keeps only what an executing plan rests on, so state is bounded by live work. */
  const pruneObservations = (s: KernelState) => {
    const named = new Set(
      Object.values(s.plans).flatMap(plan =>
        plan.status === 'executing' ? (plan.evidence ?? []).map(fact => fact.id) : []
      )
    )
    for (const id of Object.keys(s.observations)) if (!named.has(id)) delete s.observations[id]
  }

  const raiseConflictMarks = (s: KernelState, writes: readonly Id[], block: number) => {
    for (const id of writes) s.conflictMarks[id] = Math.max(s.conflictMarks[id] ?? -1, block)
  }

  /** Raises the durable floor to each mark it prunes, in the state the next flush records. */
  const pruneConflictMarks = (s: KernelState) => {
    const floor = evidenceFloor(s)
    for (const [id, mark] of Object.entries(s.conflictMarks)) {
      if (mark > floor) continue
      s.evidenceFloor = Math.max(s.evidenceFloor, mark)
      delete s.conflictMarks[id]
    }
  }

  /** A step after a transaction or a release begins a new stage, which needs its own evidence. */
  const atStageBoundary = (plan: Plan) =>
    !plan.recovery &&
    !riskReducing(plan) &&
    plan.cursor > plan.stage &&
    plan.steps[plan.cursor - 1]!.kind !== 'sign'

  /**
   * A plan at a stage boundary parks before anything judges it, so the stage it just finished is
   * never refused again on its own evidence; only an `Advance` with the next stage's moves it, and
   * only before the finished stage's deadline, which may pass while its last step is included.
   */
  const advance = (s: KernelState, out: Command[], plan: Plan): void => {
    if (plan.status !== 'executing' || plan.phase !== 'ready') return
    if (plan.cursor >= plan.steps.length) return settlePlan(s, out, plan)
    if (atStageBoundary(plan)) {
      plan.phase = 'awaiting-advance'
      const lapsed = expired(s, plan)
      return lapsed ? failPlan(s, out, plan, lapsed) : undefined
    }
    const refusal = decisionRefusal(s, plan)
    if (refusal) return failPlan(s, out, plan, refusal)
    const step = plan.steps[plan.cursor]!
    if (!step.reading) {
      plan.phase = 'materialize'
      const n = request(s, plan, 'materialize')
      return emit(out, {
        type: 'materialize',
        request: n,
        intentId: plan.intentId,
        step: plan.cursor,
        signatures: plan.signatures,
        ...(step.witness !== undefined && { witness: step.witness })
      })
    }
    if (step.kind === 'tx') {
      if (!predecessorsExecuted(s, plan)) return
      plan.phase = 'simulate'
      const n = request(s, plan, 'simulate')
      return emit(out, {
        type: 'simulate',
        request: n,
        intentId: plan.intentId,
        payload: step.payload as TxPayload
      })
    }
    if (step.kind === 'sign') {
      plan.phase = 'sign'
      const n = request(s, plan, 'sign')
      return emit(out, {
        type: 'sign',
        request: n,
        intentId: plan.intentId,
        payload: step.payload as TypedPayload
      })
    }
    plan.phase = 'await-slot'
  }

  const exceeds = (limit: Resources, amounts: Resources) =>
    Object.entries(amounts).some(([key, amount]) => amount > (limit[key] ?? 0n))

  /** What a dependent step may still consume: the envelope minus what is committed and what later known steps were admitted with. */
  const unallocated = (plan: Plan): Resources => {
    const remaining: Record<string, bigint> = { ...plan.envelope.consumes }
    addTo(remaining, plan.committedConsumes, -1n)
    for (const later of plan.steps.slice(plan.cursor + 1))
      if (later.reading) addTo(remaining, later.reading.consumes, -1n)
    return remaining
  }

  const creationRefusal = (
    s: KernelState,
    plan: Plan,
    reading: OkValidatorReading
  ): string | undefined => {
    for (const c of reading.creates) {
      const admitted = s.entries[c.id]
      if (!plan.envelope.ids.includes(c.id) || admitted?.intentId !== plan.intentId) {
        return `creates ${c.id} outside the admitted envelope`
      }
      if (admitted.state !== 'intended') return `creates ${c.id} that is already out`
      const larger = Object.entries(c.resources).some(
        ([key, amount]) => amount > (admitted.spec.resources[key] ?? 0n)
      )
      if (c.expiry > admitted.spec.expiry || c.cap > admitted.spec.cap || larger) {
        return `creates ${c.id} beyond its admitted bounds`
      }
    }
    return undefined
  }

  const materialized = (
    s: KernelState,
    out: Command[],
    plan: Plan,
    payload: Payload,
    witness: unknown
  ): void => {
    const step = plan.steps[plan.cursor]!
    if (STEP_PAYLOAD[step.kind] !== payload.kind)
      return failPlan(s, out, plan, 'step kind does not match payload')
    const mode = mayIncreaseRisk(s) ? 'normal' : 'recovery'
    const reading = authorize(payload, witness, mode)
    if (!reading.ok) return failPlan(s, out, plan, reading.reason)
    if (reading.retires.some(id => !owned(s, id))) {
      return failPlan(s, out, plan, 'neutralizes a commitment the kernel does not own')
    }
    const envelopeRefusal = creationRefusal(s, plan, reading)
    if (envelopeRefusal) return failPlan(s, out, plan, envelopeRefusal)
    if (exceeds(unallocated(plan), reading.consumes)) {
      return failPlan(s, out, plan, 'consumes beyond the admitted envelope')
    }
    if (reading.exposes.some(id => s.entries[id]?.intentId !== plan.intentId)) {
      return failPlan(s, out, plan, 'exposes a commitment outside the plan')
    }
    plan.steps[plan.cursor] = { ...step, payload, witness, reading }
    plan.phase = 'ready'
    advance(s, out, plan)
  }

  const dispatchSlot = (s: KernelState, out: Command[]) => {
    if (s.slot !== undefined) return
    const waiting = s.planOrder
      .map(id => s.plans[id]!)
      .filter(p => p.status === 'executing' && p.phase === 'await-slot')
      .toSorted((a, b) => Number(b.recovery !== undefined) - Number(a.recovery !== undefined))
    for (const plan of waiting) {
      const refusal = stillAuthorized(s, plan) ?? reauthorized(s, plan)
      if (refusal) {
        failPlan(s, out, plan, refusal)
        continue
      }
      const step = plan.steps[plan.cursor]!
      if (step.kind === 'release') {
        commit(s, out, plan)
        return
      }
      if (!simFresh(s, plan)) {
        plan.phase = 'ready'
        advance(s, out, plan)
        continue
      }
      const unbound = targetRefusal(s, plan, plan.terms?.generation)
      if (unbound) {
        failPlan(s, out, plan, unbound)
        continue
      }
      const wait = waitingPhase(s, plan)
      if (wait) {
        plan.phase = wait
        continue
      }
      const nonce = plan.terms?.nonce ?? s.nextNonce
      if (nonce === undefined) continue
      const feeLevel = 1 + Math.max(0, ...(s.nonces[nonce]?.candidates.map(c => c.feeLevel) ?? []))
      const fee = feeFor(s, plan, nonce, feeLevel)
      if (fee === undefined) {
        failPlan(s, out, plan, 'fee policy gave no usable fee')
        continue
      }
      return askToSign(s, out, plan, { nonce, feeLevel, fee })
    }
  }

  /**
   * A bid at the plan's recorded nonce is checked against that nonce at the slot, the signing guard,
   * `Signed`, and hand-off: still the plan's, unresolved, and resolved nowhere since it was asked.
   */
  const targetRefusal = (s: KernelState, plan: Plan, generation: number | undefined) => {
    if (generation !== plan.terms?.generation) return 'its nonce resolved'
    if (!plan.terms) return undefined
    return occupiesNonce(s, plan) && !s.nonces[plan.terms.nonce]!.resolution
      ? undefined
      : 'target nonce already resolved'
  }

  /** A step bids only after its earlier transactions executed, and never again at its nonce while latched. */
  const waitingPhase = (s: KernelState, plan: Plan): 'ready' | 'include' | undefined => {
    if (!predecessorsExecuted(s, plan)) return 'ready'
    return !plan.recovery && occupiesNonce(s, plan) && latched(s) ? 'include' : undefined
  }

  /**
   * Every earlier transaction step resolved to its own successful winner: read at its nonce while
   * the record stands, which a plan awaiting it keeps, and from `included` once pruned at finality.
   */
  const predecessorsExecuted = (s: KernelState, plan: Plan) =>
    plan.steps.slice(0, plan.cursor).every((step, i) => {
      if (step.kind !== 'tx') return true
      const inclusion = plan.included?.find(included => included.step === i)
      if (!inclusion) return false
      const found = findCandidate(s, inclusion.hash)
      return (
        !found || (found[0].resolution !== undefined && executedBy(found[0].resolution, found[1]))
      )
    })

  const askToSign = (s: KernelState, out: Command[], plan: Plan, terms: SignTerms) => {
    plan.phase = 'sign'
    const n = request(s, plan, 'sign')
    s.outstanding[n] = {
      ...s.outstanding[n]!,
      terms,
      ...(plan.terms ? { generation: plan.terms.generation } : {})
    }
    s.slot = n
    const outbid = highestFees(s.nonces[terms.nonce])
    emit(out, {
      type: 'sign',
      request: n,
      intentId: plan.intentId,
      payload: plan.steps[plan.cursor]!.payload as TxPayload,
      kind: plan.recovery?.kind ?? 'step',
      ...terms,
      ...(outbid ? { outbid } : {})
    })
  }

  const highestFees = (record: NonceRecord | undefined): GasFees | undefined =>
    record?.candidates.reduce<GasFees | undefined>(
      (highest, c) => ({
        maxFeePerGas: larger(highest?.maxFeePerGas ?? 0n, c.maxFeePerGas),
        maxPriorityFeePerGas: larger(highest?.maxPriorityFeePerGas ?? 0n, c.maxPriorityFeePerGas)
      }),
      undefined
    )

  /**
   * A plan's own candidates are bounded by the tighter of the policy and plan ceilings; recovery
   * candidates only by the policy's, so a low plan ceiling can never stop its exposure being cancelled.
   */
  const feeFor = (s: KernelState, plan: Plan, nonce: number, level: number) => {
    const kind: CandidateKind = plan.recovery?.kind ?? 'step'
    const ceiling =
      kind === 'step' && plan.maxSpendWei !== undefined && plan.maxSpendWei < config.feeReserve
        ? plan.maxSpendWei
        : config.feeReserve
    const context = {
      kind,
      nonce,
      level,
      head: s.head?.number ?? 0,
      admittedHead: plan.admittedHead ?? 0
    }
    let proposed: bigint
    try {
      proposed = config.feePolicy(context)
    } catch {
      return kind === 'step' ? undefined : ceiling
    }
    if (proposed <= 0n) return kind === 'step' ? undefined : ceiling
    return proposed < ceiling ? proposed : ceiling
  }

  /** What the commit point re-proves from state, since the reading alone cannot see ownership. */
  const commitRefusal = (
    s: KernelState,
    plan: Plan,
    reading: OkValidatorReading
  ): string | undefined => {
    const ours = (id: Id, states: readonly string[]) => {
      const entry = s.entries[id]
      return entry?.intentId === plan.intentId && states.includes(entry.state)
    }
    if (reading.carries.some(signature => !plan.signatures.includes(signature))) {
      return 'carries a signature this plan did not produce'
    }
    if (!reading.exposes.every(id => ours(id, ['signed', 'exposed', 'live']))) {
      return 'exposes a commitment this plan has not signed'
    }
    const nonce = plan.terms?.nonce
    const recreates = (id: Id) => {
      const creating = s.nonces[nonce ?? -1]?.candidates.filter(c => c.creates.includes(id)) ?? []
      return (
        ours(id, ['exposed']) &&
        creating.length > 0 &&
        creating.every(c => c.intentId === plan.intentId && c.step === plan.cursor) &&
        s.entries[id]!.creators.every(n => n === nonce)
      )
    }
    if (!reading.creates.every(c => ours(c.id, ['intended', 'signed']) || recreates(c.id))) {
      return 'creates a commitment that is already out'
    }
    if (!reading.retires.every(id => owned(s, id)))
      return 'neutralizes a commitment the kernel does not own'
    const committed: Record<string, bigint> = { ...plan.committedConsumes }
    if (stepCandidates(s, plan).length === 0) addTo(committed, reading.consumes)
    if (exceeds(plan.envelope.consumes, committed)) return 'consumes beyond the admitted envelope'
    return undefined
  }

  const writesOf = (plan: Plan) => [...(plan.conflicts?.writes ?? [])]
  const releaseOf = (s: KernelState, plan: Plan): Release => ({
    writes: writesOf(plan),
    after: (s.head?.number ?? 0) + 1
  })

  /** What a candidate records of its plan's authorization: none for the kernel's own recovery. */
  const authorityOf = (plan: Plan): { authority?: Candidate['authority'] } => {
    const authority = recordedAuthority(plan.evidence, plan.decision)
    return authority ? { authority } : {}
  }

  /** The commit point: after this transition the exposure is recorded and the act will be dispatched. */
  const commit = (
    s: KernelState,
    out: Command[],
    plan: Plan,
    signed?: { hash: string; raw: string; bid: SignedBid; terms: SignTerms }
  ): void => {
    const step = plan.steps[plan.cursor]!
    const reading = step.reading!
    const refusal = commitRefusal(s, plan, reading)
    if (refusal) {
      s.slot = undefined
      return failPlan(s, out, plan, refusal)
    }
    for (const id of reading.exposes)
      if (s.entries[id]!.state === 'signed') s.entries[id]!.state = 'exposed'
    if (signed) recordCandidate(s, plan, signed)
    else s.releases[plan.intentId] = releaseOf(s, plan)
    plan.exposed = plan.exposed || !plan.recovery
    if (plan.submissionId)
      s.submissions[plan.submissionId] = {
        intentId: plan.intentId,
        status: 'exposed',
        digest: plan.digest
      }
    plan.phase = 'commit'
    plan.flushSeq = s.seq + 1
    plan.committedAt = s.now
    if (s.slot === undefined) s.slot = -1
  }

  const recordCandidate = (
    s: KernelState,
    plan: Plan,
    signed: { hash: string; raw: string; bid: SignedBid; terms: SignTerms }
  ) => {
    const step = plan.steps[plan.cursor]!
    const reading = step.reading!
    const { nonce, feeLevel, fee } = signed.terms
    const firstOfStep = stepCandidates(s, plan).length === 0
    const sendHead = s.head?.number ?? 0
    const record = (s.nonces[nonce] ??= {
      nonce,
      candidates: [],
      lastActionHead: sendHead,
      openedAt: s.now
    })
    record.candidates.push({
      hash: signed.hash,
      raw: signed.raw,
      payload: step.payload as TxPayload,
      kind: plan.recovery?.kind ?? 'step',
      intentId: plan.intentId,
      step: plan.cursor,
      creates: reading.creates.map(c => c.id),
      exposes: [...reading.exposes],
      retires: [...reading.retires],
      consumes: reading.consumes,
      feeLevel,
      fee,
      ...signed.bid,
      sendHead,
      sent: 'unsent',
      writes: writesOf(plan),
      ...authorityOf(plan)
    })
    record.lastActionHead = s.head?.number ?? record.lastActionHead
    if (nonce === s.nextNonce) s.nextNonce = nonce + 1
    plan.terms ??= { nonce, generation: 0 }
    recordEntries(s, step, nonce)
    if (firstOfStep) addTo(plan.committedConsumes as Record<string, bigint>, reading.consumes)
    plan.pending = { hash: signed.hash, raw: signed.raw }
    const entry = plan.recovery?.entry === undefined ? undefined : s.entries[plan.recovery.entry]
    const owner = entry && s.plans[entry.intentId]
    if (owner) owner.neutralized = true
  }

  /** The entries a committed candidate at `nonce` creates or retires, recorded against that nonce. */
  const recordEntries = (s: KernelState, step: Step, nonce: number) => {
    for (const c of step.reading!.creates) {
      const entry = s.entries[c.id]!
      entry.state = 'exposed'
      if (!entry.creators.includes(nonce)) entry.creators.push(nonce)
      entry.origin = originOf(step)
    }
    for (const id of step.reading!.retires) {
      const entry = s.entries[id]!
      if (OPEN_ENTRY.has(entry.state)) entry.prior = entry.state as 'exposed' | 'live'
      entry.state = 'revoking'
      entry.neutralizing = { nonce }
    }
  }

  const settlePlan = (s: KernelState, out: Command[], plan: Plan) => {
    dropUnexposed(s, plan)
    plan.status = 'settled'
    if (plan.submissionId)
      s.submissions[plan.submissionId] = {
        intentId: plan.intentId,
        status: 'settled',
        digest: plan.digest
      }
    if (!plan.recovery) notifyEnded(out, plan, 'settled')
  }

  const dropUnexposed = (s: KernelState, plan: Plan) => {
    for (const [id, entry] of Object.entries(s.entries)) {
      if (
        entry.intentId === plan.intentId &&
        (entry.state === 'intended' || entry.state === 'signed')
      )
        delete s.entries[id]
    }
  }

  /** Ends the work a plan has in flight; bytes already handed to a send are left to its answer. */
  const withdraw = (s: KernelState, plan: Plan) => {
    for (const [n, outstanding] of Object.entries(s.outstanding)) {
      if (
        outstanding.plan !== plan.intentId ||
        outstanding.kind === 'broadcast' ||
        outstanding.kind === 'release'
      )
        continue
      releaseSlot(s, Number(n))
    }
    if (plan.phase !== 'commit') return
    const found = pendingAtNonce(s, plan)
    if (found) withhold(s, ...found)
    s.slot = undefined
  }

  /** Ends a plan whose current transaction is out at its nonce, which a fill then races. */
  const cancel = (s: KernelState, out: Command[], plan: Plan, reason: string) => {
    plan.cancelled = true
    failPlan(s, out, plan, reason)
  }

  /** `code` says why an unexposed plan was abandoned; an exposed one's compensation carries none. */
  const failPlan = (
    s: KernelState,
    out: Command[],
    plan: Plan,
    reason: string,
    code?: Exclude<EndCode, 'cancelled'>
  ): void => {
    withdraw(s, plan)
    plan.reason = reason
    if (plan.recovery) {
      plan.status = 'failed'
      if (plan.recovery.kind === 'fill' && plan.terms) {
        const record = s.nonces[plan.terms.nonce]
        if (record) record.failedFillHead = s.head?.number ?? 0
      }
      const entry = plan.recovery.entry ? s.entries[plan.recovery.entry] : undefined
      if (entry && entry.recoveryAttempts >= config.maxRecoveryAttempts) markStuck(s, out, entry)
      return
    }
    dropUnexposed(s, plan)
    if (!plan.exposed) {
      plan.status = 'abandoned'
      return notifyEnded(out, plan, 'abandoned', reason, code)
    }
    plan.status = 'compensating'
    for (const entry of Object.values(s.entries)) {
      if (entry.intentId === plan.intentId && OPEN_ENTRY.has(entry.state)) entry.compensate = true
    }
    if (plan.submissionId)
      s.submissions[plan.submissionId] = {
        intentId: plan.intentId,
        status: 'exposed',
        digest: plan.digest
      }
    notify(out, plan.intentId, 'compensating', reason)
  }

  const markStuck = (s: KernelState, out: Command[], entry: Entry) => {
    entry.stuck = true
    enterRecovering(s, out, 'compensation_failed')
  }

  const activeRecovery = (s: KernelState, match: (plan: Plan) => boolean) =>
    Object.values(s.plans).some(
      p => p.status === 'executing' && p.recovery !== undefined && match(p)
    )

  const rejectedOnly = (record: NonceRecord) =>
    !record.foreign && record.candidates.every(c => c.sent === 'rejected' || c.sent === 'withheld')

  /** A nonce recovery may compete for: unresolved, not already contested by recovery, and not racing a live plan. */
  const occupiable = (s: KernelState, record: NonceRecord) =>
    !record.resolution &&
    !record.foreign &&
    !record.candidates.some(
      c => c.kind !== 'step' && c.sent !== 'rejected' && c.sent !== 'withheld'
    ) &&
    !activeRecovery(s, p => p.terms?.nonce === record.nonce) &&
    (s.lifecycle.kind === 'recovering' ||
      rejectedOnly(record) ||
      record.candidates.every(c => s.plans[c.intentId]?.status !== 'executing'))

  const recoverTarget = (s: KernelState) =>
    Object.values(s.nonces)
      .filter(r => occupiable(s, r) && (s.lifecycle.kind === 'recovering' || rejectedOnly(r)))
      .toSorted((a, b) => a.nonce - b.nonce)[0]?.nonce

  /** A `continued` neutralizer bids again at its stuck nonce, which spends none of the entry's attempts. */
  const startRecovery = (
    s: KernelState,
    out: Command[],
    kind: 'neutralizer' | 'fill',
    { entry, nonce, continued }: { entry?: Entry; nonce?: number; continued?: true } = {}
  ) => {
    const payload = kind === 'fill' ? fillPayload(config.account) : entry!.spec.neutralizer
    const registered = !entry || readsVersion(entry.validator)
    const reading = registered ? authorize(payload, undefined, 'recovery') : undefined
    if (entry) {
      if (!reading?.ok || !reading.retires.includes(entry.spec.id)) return markStuck(s, out, entry)
      if (!continued && entry.recoveryAttempts >= config.maxRecoveryAttempts)
        return markStuck(s, out, entry)
      if (!continued) entry.recoveryAttempts++
    }
    const target = nonce ?? (kind === 'neutralizer' ? recoverTarget(s) : undefined)
    const intentId = `recovery:${kind}:${entry?.spec.id ?? target}:${s.nextRequest++}`
    const plan: Plan = {
      intentId,
      digest: encodeStored(payload),
      recovery: { kind, ...(entry ? { entry: entry.spec.id } : {}) },
      ...(target !== undefined ? { terms: { nonce: target, generation: 0 } } : {}),
      steps: [{ kind: 'tx', payload, reading: reading as OkValidatorReading }],
      cursor: 0,
      stage: 0,
      phase: 'ready',
      status: 'executing',
      signatures: [],
      envelope: { ids: [], consumes: {} },
      committedConsumes: {},
      exposed: false,
      basisBlock: 0,
      notAfter: NEVER
    }
    s.plans[intentId] = plan
    s.planOrder.push(intentId)
    advance(s, out, plan)
  }

  /**
   * An executing plan whose next, uncommitted step retires `entry`: a superseding plan that begins
   * by cancelling what it replaced is that compensation, so recovery does not race it.
   */
  const retiredNextBy = (s: KernelState, entry: Entry) =>
    Object.values(s.plans).some(
      plan =>
        plan.status === 'executing' &&
        !plan.recovery &&
        !occupiesNonce(s, plan) &&
        (plan.steps[plan.cursor]?.reading?.retires.includes(entry.spec.id) ?? false)
    )

  /** An open entry the kernel must withdraw now, and that no plan is already withdrawing. */
  const owesNeutralizer = (s: KernelState, entry: Entry) => {
    if (!OPEN_ENTRY.has(entry.state) || entry.stuck) return false
    const recovering = s.lifecycle.kind === 'recovering'
    const stale = s.now - entry.affirmedAt > config.revokeAfterStaleMs
    if (!(recovering || entry.compensate || stale)) return false
    if (!recovering && !stale && retiredNextBy(s, entry)) return false
    return !activeRecovery(s, p => p.recovery?.entry === entry.spec.id)
  }

  const recover = (s: KernelState, out: Command[]) => {
    const kind = s.lifecycle.kind
    if (kind !== 'running' && kind !== 'recovering') return
    for (const entry of Object.values(s.entries)) {
      if (!owesNeutralizer(s, entry)) continue
      startRecovery(s, out, 'neutralizer', { entry })
      if (s.lifecycle.kind !== kind) return
    }
    for (const record of Object.values(s.nonces).toSorted((a, b) => a.nonce - b.nonce)) {
      if (!occupiable(s, record) || !rejectedOnly(record) || fillFailedHere(s, record)) continue
      startRecovery(s, out, 'fill', { nonce: record.nonce })
    }
  }

  /** Bytes at `record` handed to a send whose answer has not come back. */
  const sending = (s: KernelState, record: NonceRecord) =>
    Object.values(s.outstanding).some(
      o => o.kind === 'broadcast' && record.candidates.some(c => c.hash === o.hash)
    )

  const fillFailedHere = (s: KernelState, record: NonceRecord) =>
    record.failedFillHead !== undefined && (s.head?.number ?? 0) <= record.failedFillHead

  const executedBy = (resolution: Resolution, candidate: Candidate) =>
    resolution.winner === candidate.hash && resolution.success && resolution.confirmed

  /** Our own final effect on `resources` at `block`: a decision read before it is stale. */
  const raiseWatermark = (s: KernelState, resources: Iterable<string>, block: number) => {
    for (const resource of resources)
      s.watermarks[resource] = Math.max(s.watermarks[resource] ?? 0, block)
  }

  const retire = (s: KernelState, entry: Entry, why: string, block: number) => {
    entry.state = 'retired'
    entry.retiredBy = why
    entry.compensate = false
    raiseWatermark(s, Object.keys(entry.spec.resources), block)
  }

  /**
   * Owned hand-back: until its nonce resolves an entry stays revoking while any candidate there that
   * was not withheld retires it, since only `withheld` proves the bytes never left. Once resolved,
   * only an executed winner that retires it keeps it, retiring it at finality; anything else hands
   * it back to its prior state.
   */
  const reviewRevocations = (s: KernelState, record: NonceRecord) => {
    const resolution = record.resolution
    const winner = resolution && record.candidates.find(c => c.hash === resolution.winner)
    for (const id of new Set(record.candidates.flatMap(c => c.retires))) {
      const entry = s.entries[id]
      if (entry?.state !== 'revoking' || entry.neutralizing?.nonce !== record.nonce) continue
      if (!resolution) {
        if (!record.candidates.some(c => c.sent !== 'withheld' && c.retires.includes(id)))
          handBack(s, entry)
      } else if (!winner || !executedBy(resolution, winner) || !winner.retires.includes(id)) {
        handBack(s, entry)
      } else if (isFinal(s, resolution)) retire(s, entry, 'neutralized', resolution.block)
      else entry.retireEvidence = resolution
    }
  }

  const handBack = (s: KernelState, entry: Entry) => {
    entry.state = entry.prior ?? 'exposed'
    delete entry.neutralizing
    delete entry.retireEvidence
    reclaim(s, entry)
  }

  /**
   * An open entry goes back to revoking under any unresolved nonce still holding a candidate that was
   * not withheld and retires it, as after a reorg undoes the resolution that handed it back.
   */
  const reclaim = (s: KernelState, entry: Entry) => {
    if (!OPEN_ENTRY.has(entry.state)) return
    const owner = Object.values(s.nonces).find(
      r =>
        !r.resolution &&
        r.candidates.some(c => c.sent !== 'withheld' && c.retires.includes(entry.spec.id))
    )
    if (!owner) return
    entry.prior = entry.state as 'exposed' | 'live'
    entry.state = 'revoking'
    entry.neutralizing = { nonce: owner.nonce }
  }

  /**
   * An `inclusion` commitment whose every creating nonce is final and whose winner there did not
   * create it never existed. A success counts as creating even unconfirmed: only a winner that did
   * not succeed, or did not create it, proves absence.
   */
  const applyCreation = (s: KernelState, record: NonceRecord, resolution: Resolution) => {
    const winner = record.candidates.find(c => c.hash === resolution.winner)
    const ran = winner !== undefined && resolution.success ? winner : undefined
    for (const id of [...(ran?.creates ?? []), ...(ran?.exposes ?? [])]) markLive(s, id, resolution)
    if (!isFinal(s, resolution)) return
    for (const id of new Set(record.candidates.flatMap(c => c.creates))) {
      const entry = s.entries[id]
      if (!entry || entry.state === 'retired' || entry.spec.exposure !== 'inclusion') continue
      if (ran?.creates.includes(id)) continue
      if (!entry.deadCreators.includes(record.nonce)) entry.deadCreators.push(record.nonce)
      if (entry.creators.every(n => entry.deadCreators.includes(n)))
        retire(s, entry, 'creator did not execute', resolution.block)
    }
    if (ran) raiseWatermark(s, Object.keys(ran.consumes), resolution.block)
  }

  const markLive = (s: KernelState, id: Id, resolution: Resolution) => {
    const entry = s.entries[id]
    if (!entry || entry.state === 'retired') return
    if (entry.state === 'exposed') entry.state = 'live'
    if (entry.state === 'revoking' && entry.prior === 'exposed') entry.prior = 'live'
    entry.liveAt = resolution
  }

  const settleNonces = (s: KernelState) => {
    for (const record of Object.values(s.nonces)) {
      const resolution = record.resolution
      if (!resolution) continue
      const final = isFinal(s, resolution)
      reviewRevocations(s, record)
      applyCreation(s, record, resolution)
      const awaited = Object.values(s.plans).some(
        p =>
          p.status === 'executing' &&
          ((p.terms?.nonce === record.nonce && occupiesNonce(s, p)) ||
            awaitsPredecessor(p, record, resolution))
      )
      if (!final || awaited || sending(s, record) || record.foreign) continue
      const spent = record.candidates.flatMap(c => Object.keys(c.consumes))
      raiseWatermark(s, ['native', ...spent], resolution.block)
      prunedFrom.get(s)?.nonces.push(record)
      delete s.nonces[record.nonce]
    }
  }

  /** A plan whose earlier step bid here and did not execute here waits on this record ({@link predecessorsExecuted}). */
  const awaitsPredecessor = (plan: Plan, record: NonceRecord, resolution: Resolution) => {
    const earlier = record.candidates.filter(
      c => c.intentId === plan.intentId && c.step < plan.cursor
    )
    return earlier.length > 0 && !earlier.some(c => executedBy(resolution, c))
  }

  const releaseInFlight = (s: KernelState, intentId: Id) =>
    (s.plans[intentId]?.status === 'executing' && s.plans[intentId].phase === 'commit') ||
    Object.values(s.outstanding).some(o => o.kind === 'release' && o.plan === intentId)

  /** A release is offchain, so a read at any head seen while it may still leave may predate it. */
  const settleReleases = (s: KernelState) => {
    if (!s.head) return
    for (const [intentId, release] of Object.entries(s.releases)) {
      const lag = release.restored ? config.maxEvidenceAgeBlocks + 1 : 0
      release.after = Math.max(release.after + lag, s.head.number + lag + 1)
      if (releaseInFlight(s, intentId)) continue
      raiseConflictMarks(s, release.writes, release.after)
      delete s.releases[intentId]
    }
  }

  const settleEntries = (s: KernelState) => {
    for (const entry of Object.values(s.entries)) {
      if (!isHeld(entry.state)) continue
      const observed = entry.observed
      if (observed && isFinal(s, observed) && observed.consumed > entry.consumedFinal) {
        entry.consumedFinal = observed.consumed
        raiseWatermark(s, Object.keys(entry.spec.resources), observed.block)
      }
      if (observed && isFinal(s, observed) && observed.neutralized)
        retire(s, entry, 'neutralized', observed.block)
      else if (entry.consumedFinal >= entry.spec.cap)
        retire(s, entry, 'filled', observed?.block ?? s.finalized.number)
      else if (s.finalized.timestamp > entry.spec.expiry)
        retire(s, entry, 'expired', s.finalized.number)
    }
  }

  /** Complete only when every exposure is retired at finality and no candidate that could recreate or undo it is open. */
  const settleCompensation = (s: KernelState, out: Command[], plan: Plan) => {
    const mine = Object.values(s.entries).filter(e => e.intentId === plan.intentId)
    if (mine.some(e => e.stuck)) {
      plan.status = 'failed'
      return notifyEnded(out, plan, 'failed', 'compensation could not complete')
    }
    if (mine.some(e => UNRETIRED.has(e.state))) return
    const ids = mine.map(e => e.spec.id)
    const open = Object.values(s.nonces).some(r =>
      r.candidates.some(c => c.intentId === plan.intentId || c.retires.some(id => ids.includes(id)))
    )
    if (open) return
    plan.status = 'compensated'
    if (plan.submissionId)
      s.submissions[plan.submissionId] = {
        intentId: plan.intentId,
        status: 'compensated',
        digest: plan.digest
      }
    notifyEnded(out, plan, 'compensated', plan.reason)
  }

  const progressPlans = (s: KernelState, out: Command[]) => {
    for (const id of s.planOrder) {
      const plan = s.plans[id]!
      if (plan.status === 'compensating') {
        settleCompensation(s, out, plan)
        continue
      }
      if (plan.status !== 'executing') continue
      if (occupiesNonce(s, plan) && s.nonces[plan.terms!.nonce]!.resolution)
        settleByWinner(s, out, plan)
      else if (plan.phase === 'ready') advance(s, out, plan)
    }
  }

  /**
   * Once its nonce resolves, in whatever phase, a plan withdraws what it has in flight and the
   * winner settles it: one of its own step's candidates, or for recovery one of its own kind.
   */
  const settleByWinner = (s: KernelState, out: Command[], plan: Plan) => {
    const record = s.nonces[plan.terms!.nonce]!
    const resolution = record.resolution!
    withdraw(s, plan)
    const winner = record.candidates.find(c => c.hash === resolution.winner)
    const recovery = plan.recovery
    const own = winner?.intentId === plan.intentId && winner.step === plan.cursor
    const ours = recovery
      ? winner?.kind === recovery.kind &&
        (recovery.entry === undefined || winner.retires.includes(recovery.entry))
      : own
    if (own) {
      plan.included = [
        ...(plan.included ?? []),
        {
          step: plan.cursor,
          hash: winner.hash,
          block: resolution.block,
          success: resolution.success
        }
      ]
    }
    if (!ours || !executedBy(resolution, winner!))
      return failPlan(s, out, plan, 'step did not execute')
    plan.lastInclusion = resolution.block
    plan.cursor++
    plan.phase = 'ready'
    delete plan.pending
    delete plan.terms
    advance(s, out, plan)
  }

  const confirmSafely = (validator: Validator, payload: TxPayload, logs: readonly Log[]) => {
    try {
      return validator.confirm(payload, logs)
    } catch {
      return false
    }
  }

  const resolveWith = (
    s: KernelState,
    record: NonceRecord,
    winner: string,
    at: BlockRef,
    status: 'success' | 'reverted',
    logs: readonly Log[]
  ) => {
    const candidate = record.candidates.find(c => c.hash === winner)
    const validator = candidate ? validatorFor(candidate.payload) : undefined
    const confirmed =
      status === 'success' &&
      candidate !== undefined &&
      (candidate.kind === 'fill' ||
        (validator !== undefined &&
          !('ok' in validator) &&
          confirmSafely(validator, candidate.payload, logs)))
    record.resolution = { ...at, winner, success: status === 'success', confirmed }
    staleTerms(s, record.nonce)
    if (status === 'success' && !confirmed)
      alarm(s, `${winner} succeeded without its expected transition`)
    if (candidate) raiseConflictMarks(s, candidate.writes, at.block)
    reinclude(s, candidate, at.block, status === 'success')
  }

  const staleTerms = (s: KernelState, nonce: number) => {
    for (const plan of Object.values(s.plans))
      if (plan.status === 'executing' && plan.terms?.nonce === nonce) plan.terms.generation++
  }

  /**
   * A step that lands after its plan stopped reading its nonce is named in its inclusions: one a reorg
   * orphaned after the plan moved on, or the current step of a plan that ended, as a cancelled one.
   */
  const reinclude = (
    s: KernelState,
    candidate: Candidate | undefined,
    block: number,
    success: boolean
  ) => {
    if (candidate?.kind !== 'step') return
    const plan = s.plans[candidate.intentId]
    const { step, hash } = candidate
    if (!plan || plan.included?.some(i => i.step === step)) return
    if (step > plan.cursor || (step === plan.cursor && plan.status === 'executing')) return
    const inclusion = { step, hash, block, success }
    plan.included = [...(plan.included ?? []), inclusion].toSorted((a, b) => a.step - b.step)
    plan.lastInclusion = Math.max(plan.lastInclusion ?? 0, block)
  }

  /** Why the current policy, validators, and caps refuse to keep a loaded entry; checked against those kept so far. */
  const adoptionRefusal = (entry: Entry, adopted: Record<string, bigint>): string | undefined => {
    const reading = authorize(entry.origin!.payload, entry.origin!.witness, 'normal')
    if (!reading.ok) return `policy now refuses: ${reading.reason}`
    const current = reading.creates.find(c => c.id === entry.spec.id)
    if (!current) return 'the validator no longer reads it as this commitment'
    const larger = Object.entries(current.resources).some(
      ([key, amount]) => amount > (entry.spec.resources[key] ?? 0n)
    )
    if (current.exposure !== entry.spec.exposure)
      return 'the validator now reads its exposure differently'
    if (current.expiry > entry.spec.expiry || current.cap > entry.spec.cap || larger)
      return 'the validator now reads it beyond its recorded bounds'
    for (const [key, amount] of Object.entries(remainingOf(entry))) {
      const cap = config.caps[key]
      if (cap === undefined && config.observedResources.includes(key)) continue
      if ((adopted[key] ?? 0n) + amount > (cap ?? 0n))
        return `with what is kept and in flight it exceeds the ${key} cap`
    }
    return undefined
  }

  /**
   * A restart keeps what it can attribute and never extends it: the rest is withdrawn once running.
   * A revoking entry is checked too, since a losing cancellation hands it back.
   */
  const withdrawUnadoptable = (s: KernelState, out: Command[]) => {
    const adopted = holds(config, { ...s, entries: {} })
    for (const entry of Object.values(s.entries)) {
      if (entry.compensate) continue
      const refusal = adoptionRefusal(entry, adopted)
      if (refusal === undefined) {
        addTo(adopted, remainingOf(entry))
        continue
      }
      entry.compensate = true
      notify(out, entry.intentId, 'compensating', `restart withdraws ${entry.spec.id}: ${refusal}`)
    }
  }

  const start = (
    s: KernelState,
    out: Command[],
    event: Extract<KernelEvent, { type: 'Start' }>
  ): void => {
    if (!isBlockOrTime(event.now)) return stop(s, out, 'refused', 'malformed clock reading')
    s.now = event.now
    if (event.accountCode !== '0x')
      return stop(s, out, 'refused', 'the account has code, so a nonce fill would run it')
    if (event.enrollment === 'enrolled' && !event.ledger)
      return stop(s, out, 'refused', 'ledger missing for enrolled account')
    if (event.enrollment === 'enrolling' && event.ledger)
      return stop(s, out, 'refused', 'account already has a ledger')
    if (event.ledger) {
      const ledger = validateLedger(event.ledger, config)
      if (typeof ledger === 'string') return stop(s, out, 'refused', ledger)
      for (const [id, stored] of Object.entries(ledger.entries)) {
        const registered = readsVersion(stored.validator)
        const reading = registered
          ? authorize(stored.spec.neutralizer, undefined, 'recovery')
          : undefined
        if (!reading?.ok || !reading.retires.includes(id)) {
          return stop(
            s,
            out,
            'refused',
            `recovery cannot neutralize ${id} under current policy and validators`
          )
        }
        const { affirmedBy, ...rest } = stored
        s.entries[id] = {
          ...rest,
          adopted: true,
          recoveryAttempts: 0,
          stuck: false,
          affirmedAt: Math.min(affirmedBy, event.now)
        }
      }
      for (const stored of Object.values(ledger.nonces)) {
        s.nonces[stored.nonce] = {
          nonce: stored.nonce,
          lastActionHead: 0,
          openedAt: event.now,
          ...(stored.foreign ? { foreign: true as const } : {}),
          candidates: stored.candidates.map(c => reloaded(stored, c))
        }
      }
      for (const entry of Object.values(s.entries)) reclaim(s, entry)
      withdrawUnadoptable(s, out)
      if (ledger.nextNonce !== null) s.nextNonce = ledger.nextNonce
      s.seq = ledger.header.seq
      s.ackedSeq = ledger.header.seq
      s.submissions = ledger.submissions
      s.watermarks = ledger.watermarks
      s.conflictMarks = Object.fromEntries(ledger.conflictMarks)
      s.evidenceFloor = ledger.evidenceFloor
      for (const [intentId, release] of Object.entries(ledger.releases))
        s.releases[intentId] = { ...release, restored: true }
    }
    s.lifecycle = { kind: 'starting', since: event.now, nonceChecked: false }
    s.lastDurable = durableText(toDurable(s, config))
  }

  const nonceAt = (
    s: KernelState,
    out: Command[],
    event: Extract<KernelEvent, { type: 'NonceAt' }>
  ): void => {
    if (!canonical(s, event)) return
    s.chainNonce = event.latest
    if (s.nextNonce === undefined) {
      if (event.pending !== event.latest)
        return stop(s, out, 'refused', 'unrecorded pending transaction')
      if (event.safe !== event.latest) return
      s.nextNonce = event.latest
    } else if (event.latest > s.nextNonce || event.pending > s.nextNonce) {
      if (s.lifecycle.kind === 'starting')
        return stop(s, out, 'refused', 'chain nonce ahead of the ledger')
      const through = Math.max(event.latest, event.pending)
      for (let nonce = s.nextNonce; nonce < through; nonce++) {
        s.nonces[nonce] = {
          nonce,
          candidates: [],
          lastActionHead: event.block,
          openedAt: s.now,
          foreign: true
        }
      }
      s.nextNonce = through
      enterRecovering(s, out, 'unrecorded nonce')
    }
    if (s.lifecycle.kind === 'starting') s.lifecycle.nonceChecked = true
  }

  type Handler<T extends KernelEvent['type']> = (
    s: KernelState,
    out: Command[],
    event: Extract<KernelEvent, { type: T }>
  ) => void

  /** Why a parked plan's next stage may not rest on `facts`: one read before our own last effect. */
  const predatesInclusion = (plan: Plan, basisBlock: number, facts: readonly Fact[] = []) => {
    const floor = plan.lastInclusion ?? 0
    const stale = facts.filter(isChainFact).find(fact => fact.basis.block < floor)
    if (stale) return `evidence ${stale.id} ${PREDATES_OWN} inclusion`
    return basisBlock < floor ? `decision ${PREDATES_OWN} inclusion` : undefined
  }

  /** The plan as it stands once `event` moves it onto its next stage, replacing that stage's terms. */
  const nextStage = (
    s: KernelState,
    plan: Plan,
    event: Extract<KernelEvent, { type: 'Advance' }>
  ): Plan => {
    const { evidence: _e, decision: _d, validUntil: _v, ...rest } = plan
    const validUntil = event.validUntil ?? plan.validUntil
    return {
      ...rest,
      stage: plan.cursor,
      basisBlock: event.basisBlock,
      phase: 'ready',
      notAfter: withDeadline(s, Math.min(event.notAfter, validUntil ?? NEVER), event.evidence),
      ...(validUntil !== undefined && { validUntil }),
      ...(event.evidence && { evidence: event.evidence.map(fact => ({ ...fact })) }),
      ...(event.decision && { decision: { ...event.decision } })
    }
  }

  /** Why `next` may not begin its stage: the refusals a submission meets, but no capacity check. */
  const stageRefusal = (s: KernelState, next: Plan): string | undefined => {
    if (!lifecycleAllows(s, next)) return latched(s) ? 'latched' : `lifecycle ${s.lifecycle.kind}`
    const specs = next.envelope.ids.flatMap(id => s.entries[id]?.spec ?? [])
    return (
      decisionRefusal(s, next) ??
      predatesInclusion(next, next.basisBlock, next.evidence) ??
      staleBasis(s, next, specs)?.reason ??
      evidenceRefusal(s, next)?.reason
    )
  }

  /** Why an advance is not well formed for the plan it names, before anything of it is taken in. */
  const advanceDefect = (
    plan: Plan | undefined,
    event: Extract<KernelEvent, { type: 'Advance' }>
  ): string | undefined => {
    if (plan?.status !== 'executing' || plan.recovery) return 'no executing plan'
    if (plan.phase !== 'awaiting-advance' || event.stage !== plan.cursor)
      return `not awaiting stage ${event.stage}`
    const times = [event.basisBlock, event.notAfter, event.validUntil ?? 0]
    if (!times.every(isBlockOrTime))
      return 'basis block and expiry must be non-negative safe integers'
    return liveAuthorityDefect(event.evidence, event.decision)
  }

  /**
   * Admits a parked plan's next stage through the same refusals as a submission, but against the
   * reservation it already holds: a refusal leaves it parked, and expiry or supersession ends it.
   */
  const advanceStage: Handler<'Advance'> = (s, out, event) => {
    if (typeof event.intentId !== 'string' || event.intentId in Object.prototype) {
      alarm(s, 'malformed Advance event ignored')
      return
    }
    const plan = s.plans[event.intentId]
    const defect = advanceDefect(plan, event)
    if (defect) return notify(out, event.intentId, 'stalled', defect)
    const lapsed = expired(s, plan!)
    if (lapsed) return failPlan(s, out, plan!, lapsed)
    observe(s, event.observations ?? [])
    const next = nextStage(s, plan!, event)
    const refusal = stageRefusal(s, next)
    if (refusal) return notify(out, event.intentId, 'stalled', refusal)
    s.plans[next.intentId] = next
    notify(out, next.intentId, 'advanced')
    advance(s, out, next)
  }

  const simulated: Handler<'Simulated'> = (s, out, event) => {
    const taken = take(s, event.request, ['simulate'])
    if (!taken) return
    if (!event.ok) return failPlan(s, out, taken.plan, 'simulation failed', 'reverted')
    taken.plan.sim = { block: event.block, blockHash: event.blockHash }
    taken.plan.phase = 'await-slot'
  }

  /** The last check before the commit point: only a condition no event reports is new here. */
  const signed: Handler<'Signed'> = (s, out, event) => {
    const taken = take(s, event.request, ['sign'])
    if (!taken) return
    const plan = taken.plan
    const step = plan.steps[plan.cursor]!
    if (step.kind === 'sign') {
      const refusal = stillAuthorized(s, plan) ?? reauthorized(s, plan)
      if (refusal) return failPlan(s, out, plan, `final check: ${refusal}`)
      plan.signatures.push(event.signature!)
      for (const c of step.reading!.creates) {
        const entry = s.entries[c.id]
        if (entry?.intentId === plan.intentId && entry.state === 'intended') {
          entry.state = 'signed'
          entry.origin = originOf(step)
        }
      }
      plan.cursor++
      plan.phase = 'ready'
      return advance(s, out, plan)
    }
    s.slot = undefined
    const terms = taken.outstanding.terms!
    if (targetRefusal(s, plan, taken.outstanding.generation)) return resolvedMeanwhile(s, out, plan)
    const wait = waitingPhase(s, plan)
    if (wait) {
      plan.phase = wait
      return
    }
    const refusal = stillAuthorized(s, plan) ?? reauthorized(s, plan)
    if (refusal) return failPlan(s, out, plan, `final check: ${refusal}`)
    if (!simFresh(s, plan)) {
      plan.phase = 'ready'
      return advance(s, out, plan)
    }
    s.slot = event.request
    commit(s, out, plan, { hash: event.hash!, raw: event.raw!, bid: event.bid!, terms })
  }

  /** Nothing is signed at a nonce that resolved since it was asked for; a step's candidate settles it. */
  const resolvedMeanwhile = (s: KernelState, out: Command[], plan: Plan) => {
    if (plan.recovery || stepCandidates(s, plan).length === 0)
      return failPlan(s, out, plan, 'target nonce resolved while signing')
    plan.phase = 'include'
  }

  /**
   * A plan that cannot outbid its nonce waits at its cap, holding no slot, beside its candidates: a
   * step until its deadline cancels it, recovery until the nonce resolves ({@link waitsAtCeiling}).
   * Recovery with no recorded nonce to wait at fails as any recovery attempt does.
   */
  const capReached: Handler<'StepCapReached' | 'FeeCeilingReached'> = (s, out, event) => {
    const taken = take(s, event.request, ['sign'])
    if (!taken) return
    const plan = taken.plan
    if (!occupiesNonce(s, plan))
      return plan.recovery ? failPlan(s, out, plan, 'no bid fits under the fee ceiling') : undefined
    plan.terms!.capped = true
    plan.phase = 'include'
    if (!plan.recovery) return
    const record = s.nonces[plan.terms!.nonce]!
    alarm(s, `nonce ${record.nonce} waits at the fee ceiling`)
    if (!ceilingBytes(record)) enterRecovering(s, out, NOTHING_TO_RESEND)
  }

  /** The bytes a nonce waiting at the ceiling re-sends: its highest recovery bid that was not withheld. */
  const ceilingBytes = (record: NonceRecord) =>
    record.candidates
      .filter(c => c.kind !== 'step' && c.sent !== 'withheld')
      .toSorted((a, b) => a.feeLevel - b.feeLevel)
      .at(-1)

  /** A broadcast that times out is `unknown`, never failed; any other effect failing is pre-exposure. */
  const effectFailed: Handler<'EffectFailed' | 'TimedOut'> = (s, out, event) => {
    const outstanding = s.outstanding[event.request]
    if (!outstanding) return
    const plan = s.plans[outstanding.plan]
    if (outstanding.kind === 'broadcast') {
      const found = outstanding.hash ? findCandidate(s, outstanding.hash) : undefined
      if (found && answerable(found[1])) markUnknown(s, found[1])
      releaseSlot(s, event.request)
      if (plan?.request === event.request && plan.phase === 'expose') plan.phase = 'include'
      return
    }
    if (outstanding.kind === 'release')
      return released(s, out, { type: 'Released', request: event.request, outcome: 'unknown' })
    const taken = take(s, event.request, [outstanding.kind])
    if (taken)
      failPlan(
        s,
        out,
        taken.plan,
        `${outstanding.kind} ${event.type === 'TimedOut' ? 'timed out' : 'failed'}`
      )
  }

  /** Bytes known to be obsolete before dispatch stay home; the record already makes that conservative. */
  const withholdReason = (s: KernelState, plan: Plan) =>
    expired(s, plan) ??
    stillAuthorized(s, plan) ??
    reauthorized(s, plan) ??
    (plan.sim && !canonical(s, plan.sim) ? 'simulation orphaned by a reorg' : undefined) ??
    (s.now - (plan.committedAt ?? s.now) > config.maxDispatchLagMs
      ? 'dispatch window exceeded'
      : undefined)

  /** The candidate a committed plan awaits dispatch of, found at the nonce its terms name. */
  const pendingAtNonce = (s: KernelState, plan: Plan): [NonceRecord, Candidate] | undefined => {
    const record = plan.pending && plan.terms ? s.nonces[plan.terms.nonce] : undefined
    const candidate = record?.candidates.find(c => c.hash === plan.pending!.hash)
    return candidate && [record!, candidate]
  }

  /** A candidate's uncertainty starts once, when it becomes `unknown`, and ends once it is accepted. */
  const markUnknown = (s: KernelState, candidate: Candidate) => {
    candidate.sent = 'unknown'
    if (s.head) candidate.unknownSince = s.head.number
  }

  /**
   * Whose send status any answer to a send replaces: bytes never answered, or refused, which a
   * re-send at the fee ceiling may yet get taken; nothing turns `accepted` or `unknown` into `rejected`.
   */
  const answerable = (candidate: Candidate) =>
    candidate.sent === 'unsent' || candidate.sent === 'rejected'

  const markAccepted = (candidate: Candidate) => {
    candidate.sent = 'accepted'
    delete candidate.unknownSince
  }

  const withhold = (s: KernelState, record: NonceRecord, candidate: Candidate) => {
    candidate.sent = 'withheld'
    reviewRevocations(s, record)
  }

  /** A committed plan waiting on the ledger write `seq`, or on one before it. */
  const waitsOn = (plan: Plan, seq: number) =>
    plan.status === 'executing' && plan.phase === 'commit' && !((plan.flushSeq ?? NEVER) > seq)

  /** An answer naming a flush the kernel never issued releases nothing and fails nothing. */
  const isIssued = (s: KernelState, seq: number) =>
    Number.isSafeInteger(seq) && seq >= 1 && seq <= s.seq

  const flushed: Handler<'Flushed'> = (s, out, event) => {
    if (!isIssued(s, event.seq)) {
      alarm(s, 'malformed Flushed event ignored')
      return
    }
    s.ackedSeq = Math.max(s.ackedSeq, event.seq)
    for (const plan of Object.values(s.plans)) {
      if (!waitsOn(plan, event.seq)) continue
      const step = plan.steps[plan.cursor]!
      const withheld = withholdReason(s, plan)
      if (withheld) {
        const found = pendingAtNonce(s, plan)
        if (found) withhold(s, ...found)
        s.slot = undefined
        plan.phase = 'include'
        failPlan(s, out, plan, `withheld: ${withheld}`)
        continue
      }
      plan.phase = 'expose'
      if (step.kind === 'release') {
        s.slot = request(s, plan, 'release')
        emit(out, { type: 'release', request: s.slot, payload: step.payload as ReleasePayload })
      } else {
        const candidate = findCandidate(s, plan.pending!.hash)?.[1]
        if (candidate?.sent === 'unsent') candidate.sendHead = s.head?.number ?? candidate.sendHead
        s.slot = request(s, plan, 'broadcast')
        emit(out, {
          type: 'broadcast',
          request: s.slot,
          hash: plan.pending!.hash,
          raw: plan.pending!.raw
        })
      }
    }
  }

  /** Bytes go out only after their flush, so a candidate whose flush failed is withheld; the disk may still hold it. */
  const flushFailed: Handler<'FlushFailed'> = (s, out, event) => {
    if (!isIssued(s, event.seq)) {
      alarm(s, 'malformed FlushFailed event ignored')
      return
    }
    for (const plan of Object.values(s.plans)) {
      if (!waitsOn(plan, event.seq)) continue
      const found = pendingAtNonce(s, plan)
      if (found) withhold(s, ...found)
      plan.phase = 'include'
      if (!found) failPlan(s, out, plan, 'flush failed')
    }
    s.slot = undefined
    if (event.reason === 'fenced') return stop(s, out, 'unsafe', 'another process holds the ledger')
    const recovering = s.lifecycle.kind === 'recovering'
    enterRecovering(s, out, `flush failed: ${event.reason}`)
    if (recovering) stop(s, out, 'unsafe', `flush failed: ${event.reason}`)
  }

  const broadcasted: Handler<'Broadcasted'> = (s, out, event) => {
    const found = findCandidate(s, event.hash)
    if (event.outcome === 'withheld') return withheldAtHandoff(s, out, event, found)
    const candidate = found?.[1]
    if (candidate && answerable(candidate) && event.outcome === 'unknown') markUnknown(s, candidate)
    else if (candidate && answerable(candidate)) candidate.sent = event.outcome
    else if (candidate?.sent === 'unknown' && event.outcome === 'accepted') markAccepted(candidate)
    const outstanding = event.request === undefined ? undefined : s.outstanding[event.request]
    if (outstanding?.kind !== 'broadcast') return
    releaseSlot(s, event.request!)
    const plan = s.plans[outstanding.plan]
    if (plan && plan.request === event.request && plan.phase === 'expose') plan.phase = 'include'
  }

  /** As at `Flushed`: bytes the guard kept home are handed back, and their plan fails unsent. */
  const withheldAtHandoff = (
    s: KernelState,
    out: Command[],
    event: Extract<KernelEvent, { type: 'Broadcasted' }>,
    found: [NonceRecord, Candidate] | undefined
  ) => {
    if (found?.[1].sent === 'unsent') withhold(s, ...found)
    const outstanding = event.request === undefined ? undefined : s.outstanding[event.request]
    if (outstanding?.kind !== 'broadcast') return
    releaseSlot(s, event.request!)
    const plan = s.plans[outstanding.plan]
    if (plan?.status !== 'executing' || plan.request !== event.request || plan.phase !== 'expose')
      return
    plan.phase = 'include'
    if (found?.[0].resolution) return
    failPlan(s, out, plan, `withheld at handoff: ${withholdReason(s, plan) ?? 'guard refused'}`)
  }

  const released: Handler<'Released'> = (s, out, event) => {
    const outstanding = s.outstanding[event.request]
    if (outstanding?.kind !== 'release') return
    releaseSlot(s, event.request)
    const plan = s.plans[outstanding.plan]
    if (plan?.status !== 'executing') return
    const after = Math.max(s.releases[plan.intentId]?.after ?? 0, (s.head?.number ?? 0) + 1)
    plan.lastInclusion = Math.max(plan.lastInclusion ?? 0, after)
    plan.cursor++
    plan.phase = 'ready'
    advance(s, out, plan)
  }

  /** A different hash at a known height is a reorg just below it. */
  const learnHeader = (s: KernelState, out: Command[], number: number, hash: Hash) => {
    const known = s.headers[number]
    if (known !== undefined && known !== hash) reorg(s, out, { type: 'Reorg', fork: number - 1 })
    s.headers[number] = hash
  }

  const head: Handler<'Head'> = (s, out, event) => {
    learnHeader(s, out, event.number, event.hash)
    s.head = { number: event.number, hash: event.hash, timestamp: event.timestamp }
    if (event.finalized > s.finalized.number) {
      s.finalized = { number: event.finalized, timestamp: event.finalizedTimestamp }
    }
    for (const record of Object.values(s.nonces)) {
      if (record.lastActionHead === 0) record.lastActionHead = event.number
      for (const c of record.candidates) if (c.sent === 'unknown') c.unknownSince ??= event.number
    }
  }

  /** A historical header vouched for by the kernel's own chain source, so older evidence can be checked. */
  const header: Handler<'Header'> = (s, out, event) => {
    if (!isBlockOrTime(event.number) || s.head === undefined || event.number > s.head.number) return
    learnHeader(s, out, event.number, event.hash)
  }

  /** Heights that stored evidence still names; their headers stay until the evidence is gone. */
  const pinnedHeights = (s: KernelState) =>
    new Set([
      ...Object.values(s.nonces).flatMap(r => (r.resolution ? [r.resolution.block] : [])),
      ...Object.values(s.plans).flatMap(p =>
        p.status === 'executing' && p.sim ? [p.sim.block] : []
      ),
      ...Object.values(s.plans).flatMap(p =>
        p.status === 'executing' ? chainBlocks(p.evidence) : []
      ),
      ...Object.values(s.entries).flatMap(e =>
        e.state === 'retired'
          ? []
          : [e.observed, e.liveAt, e.retireEvidence].flatMap(evidence =>
              evidence ? [evidence.block] : []
            )
      )
    ])

  /**
   * Drops headers below both finality and the oldest usable simulation or fact that no stored
   * evidence names, so the window stays bounded; newer evidence at a dropped height needs a `Header`
   * first.
   */
  const pruneHeaders = (s: KernelState) => {
    const below = Math.min(
      s.finalized.number,
      (s.head?.number ?? 0) - Math.max(config.maxSimLagBlocks, config.maxEvidenceAgeBlocks)
    )
    const pinned = pinnedHeights(s)
    for (const block of Object.keys(s.headers).map(Number))
      if (block < below && !pinned.has(block)) delete s.headers[block]
  }

  const dropInclusionsAbove = (s: KernelState, fork: number) => {
    for (const plan of Object.values(s.plans))
      if (plan.included) plan.included = plan.included.filter(({ block }) => block <= fork)
  }

  /** Rolls back the interpretation of chain evidence above the fork, never the record of exposure. */
  const reorg: Handler<'Reorg'> = (s, out, { fork }) => {
    if (fork < s.finalized.number) enterRecovering(s, out, 'finality violated')
    for (const block of Object.keys(s.headers).map(Number))
      if (block > fork) delete s.headers[block]
    for (const record of Object.values(s.nonces)) {
      if (record.resolution && record.resolution.block > fork) delete record.resolution
    }
    for (const entry of Object.values(s.entries)) reclaim(s, entry)
    dropInclusionsAbove(s, fork)
    for (const [resource, observed] of Object.entries(s.capacity)) {
      if (observed.block > fork) delete s.capacity[resource]
    }
    for (const entry of Object.values(s.entries)) {
      if (entry.observed && entry.observed.block > fork) delete entry.observed
      if (entry.retireEvidence && entry.retireEvidence.block > fork) delete entry.retireEvidence
      if (!entry.liveAt || entry.liveAt.block <= fork) continue
      if (entry.state === 'live') entry.state = 'exposed'
      if (entry.state === 'revoking' && entry.prior === 'live') entry.prior = 'exposed'
      delete entry.liveAt
    }
  }

  const receipt: Handler<'Receipt'> = (s, _out, event) => {
    const found = findCandidate(s, event.hash)
    if (!found || found[0].resolution || !canonical(s, event)) return
    resolveWith(s, found[0], event.hash, event, event.status, event.logs)
  }

  const nonceTx: Handler<'NonceTx'> = (s, out, event) => {
    const record = s.nonces[event.nonce]
    if (!record || record.resolution || !canonical(s, event)) return
    if (record.candidates.some(c => c.hash === event.hash)) {
      return resolveWith(s, record, event.hash, event, event.status, event.logs)
    }
    const { block, blockHash } = event
    record.resolution = { block, blockHash, winner: null, success: false, confirmed: false }
    staleTerms(s, record.nonce)
    record.foreign = true
    enterRecovering(
      s,
      out,
      `nonce ${event.nonce} consumed by a transaction the kernel never signed`
    )
  }

  const commitmentObserved: Handler<'CommitmentObserved'> = (s, _out, event) => {
    const entry = s.entries[event.id]
    if (!entry || !canonical(s, event)) return
    if (!isHeld(entry.state)) return
    const { block, blockHash, consumed, neutralized } = event
    entry.observed = { block, blockHash, consumed, neutralized }
  }

  const tick: Handler<'Tick'> = (s, out, event) => {
    if (!isBlockOrTime(event.now)) {
      alarm(s, 'malformed clock reading')
      return
    }
    s.now = Math.max(s.now, event.now)
    for (const plan of Object.values(s.plans)) {
      if (plan.status !== 'executing' || plan.recovery) continue
      const reason = expired(s, plan)
      if (reason && occupiesNonce(s, plan)) cancel(s, out, plan, reason)
      else if (reason) failPlan(s, out, plan, reason)
    }
  }

  const handlers: { [T in KernelEvent['type']]: Handler<T> } = {
    Start: start,
    Submit: (s, out, event) => submit(s, out, event.plan, event.observations),
    Observed: (s, _out, event) =>
      observe(
        s,
        event.observations.filter(observation => observation.id in s.observations)
      ),
    Advance: advanceStage,
    Affirm: (s, _out, event) => {
      if (!Array.isArray(event.ids) || !event.ids.every(id => typeof id === 'string')) {
        alarm(s, 'malformed Affirm event ignored')
        return
      }
      for (const id of event.ids)
        if (Object.hasOwn(s.entries, id)) s.entries[id]!.affirmedAt = s.now
    },
    Materialized: (s, out, event) => {
      const taken = take(s, event.request, ['materialize'])
      if (!taken) return
      const stored = asStored({ payload: event.payload, witness: event.witness })
      if (!stored) return failPlan(s, out, taken.plan, UNSTORABLE)
      const { payload, witness } = stored.value as { payload: Payload; witness?: unknown }
      const malformed = payloadDefect(payload, 'materialized payload')
      if (malformed) return failPlan(s, out, taken.plan, malformed)
      materialized(s, out, taken.plan, payload, witness)
    },
    Simulated: simulated,
    Signed: signed,
    StepCapReached: (s, out, event) => capReached(s, out, event),
    FeeCeilingReached: (s, out, event) => capReached(s, out, event),
    EffectFailed: (s, out, event) => effectFailed(s, out, event),
    TimedOut: (s, out, event) => effectFailed(s, out, event),
    Flushed: flushed,
    FlushFailed: flushFailed,
    Broadcasted: broadcasted,
    Released: released,
    Seen: (s, _out, event) => {
      const found = findCandidate(s, event.hash)
      if (found?.[1].sent === 'unknown') markAccepted(found[1])
    },
    Head: head,
    Header: header,
    Reorg: reorg,
    Receipt: receipt,
    NonceAt: nonceAt,
    NonceTx: nonceTx,
    CommitmentObserved: commitmentObserved,
    Capacity: (s, _out, event) => {
      if (!canonical(s, event)) return
      const { amount, block, blockHash } = event
      s.capacity[event.resource] = { amount, block, blockHash }
    },
    Tick: tick,
    Stop: (s, out) => beginRecovering(s, out, 'stop requested'),
    Halt: (s, out, event) => enterRecovering(s, out, event.reason),
    Alarm: (s, _out, event) => alarm(s, event.reason),
    Refuse: (s, out, event) => {
      if (s.lifecycle.kind === 'starting') stop(s, out, 'refused', event.reason)
    }
  }

  const handle = <T extends KernelEvent['type']>(
    s: KernelState,
    out: Command[],
    event: Extract<KernelEvent, { type: T }>
  ) => (handlers[event.type] as Handler<T>)(s, out, event)

  const afterEvent = (s: KernelState, out: Command[]) => {
    if (s.nextRequest >= REQUEST_CEILING) return stop(s, out, 'unsafe', 'request ids exhausted')
    progressPlans(s, out)
    settleNonces(s)
    settleEntries(s)
    settleReleases(s)
    progressPlans(s, out)
    for (const record of Object.values(s.nonces)) {
      const since = record.resolution ? undefined : uncertainSince(record)
      if (since !== undefined && (s.head?.number ?? 0) - since > config.latchBoundBlocks)
        enterRecovering(s, out, 'latch bound exceeded')
    }
    if (s.lifecycle.kind === 'starting') checkStarted(s, out)
    unstick(s, out)
    recover(s, out)
    dispatchSlot(s, out)
    pruneConflictMarks(s)
    flushIfChanged(s, out)
    if (s.lifecycle.kind === 'recovering') checkStopped(s, out)
    pruneFinished(s)
    pruneObservations(s)
  }

  /**
   * Drops terminal plans that nothing still names, so plans are bounded by live work rather than by
   * history. Retired entries stay until restart (§15).
   */
  const pruneFinished = (s: KernelState) => {
    const candidates = Object.values(s.nonces).flatMap(r => r.candidates)
    const namedIntents = new Set([
      ...Object.values(s.outstanding).map(o => o.plan),
      ...candidates.map(c => c.intentId),
      ...Object.values(s.entries)
        .filter(e => e.state !== 'retired')
        .map(e => e.intentId)
    ])
    for (const [id, plan] of Object.entries(s.plans)) {
      if (plan.status === 'executing' || plan.status === 'compensating') continue
      if (namedIntents.has(id)) continue
      prunedFrom.get(s)?.plans.push(plan)
      delete s.plans[id]
    }
    s.planOrder = s.planOrder.filter(id => s.plans[id] !== undefined)
  }

  /** A step's recorded bytes are worth re-sending while its plan executes, unexpired, in `running` (§6). */
  const resendable = (s: KernelState, c: Candidate) => {
    if (c.kind !== 'step') return true
    const plan = s.plans[c.intentId]
    return plan?.status === 'executing' && s.now < plan.notAfter && s.lifecycle.kind === 'running'
  }

  /**
   * A nonce is stuck once `stuckBlocks` pass since its newest candidate's send head while one of its
   * candidates is `accepted` or {@link uncovered}. An uncertain one gets one re-send, then a bid.
   */
  const unstick = (s: KernelState, out: Command[]) => {
    if (!s.head) return
    for (const record of Object.values(s.nonces).toSorted((a, b) => a.nonce - b.nonce)) {
      if (record.resolution || record.foreign) continue
      if (waitsAtCeiling(s, record)) {
        resendAtCeiling(s, out, record)
        continue
      }
      const sent = Math.max(...record.candidates.map(c => c.sendHead))
      if (s.head.number - sent < config.stuckBlocks) continue
      if (rejectedOnly(record)) {
        rebidRejected(s, out, record)
        continue
      }
      const live = record.candidates.filter(c => c.sent === 'accepted' || uncovered(record, c))
      if (live.length === 0) continue
      const uncertain = live.some(c => c.sent === 'unknown')
      if (uncertain && !resentInVain(s, out, record)) continue
      bidAgain(s, out, record, uncertain)
    }
  }

  /** Re-sends an uncertain nonce's highest eligible bytes once per process; true once spent and none is in flight. */
  const resentInVain = (s: KernelState, out: Command[], record: NonceRecord) => {
    if (sending(s, record)) return false
    const candidate = record.candidates
      .filter(c => uncovered(record, c) && resendable(s, c) && !record.resent?.includes(c.hash))
      .at(-1)
    if (!candidate) return true
    ;(record.resent ??= []).push(candidate.hash)
    resend(s, out, record, candidate)
    return false
  }

  /**
   * A nonce at the fee ceiling bids no more: every `stuckBlocks` it re-sends the bytes it already
   * signed and flushed, whatever their send status, so they land once the base fee falls below them.
   */
  const resendAtCeiling = (s: KernelState, out: Command[], record: NonceRecord) => {
    if (sending(s, record) || s.head!.number - record.lastActionHead < config.stuckBlocks) return
    const bytes = ceilingBytes(record)
    if (!bytes) return enterRecovering(s, out, NOTHING_TO_RESEND)
    resend(s, out, record, bytes)
  }

  const resend = (s: KernelState, out: Command[], record: NonceRecord, candidate: Candidate) => {
    record.lastActionHead = s.head!.number
    const n = s.nextRequest++
    s.outstanding[n] = { kind: 'broadcast', plan: candidate.intentId, hash: candidate.hash }
    emit(out, { type: 'broadcast', request: n, hash: candidate.hash, raw: candidate.raw })
  }

  const boundTo = (s: KernelState, record: NonceRecord) =>
    Object.values(s.plans).filter(
      p => p.status === 'executing' && p.terms?.nonce === record.nonce && occupiesNonce(s, p)
    )

  /**
   * A stuck recovery bid whose every candidate at its nonce was rejected bids there again, bounded by
   * the fee ceiling; it holds the nonce, so no other recovery takes it. A step's is filled instead.
   */
  const rebidRejected = (s: KernelState, out: Command[], record: NonceRecord) => {
    const lifecycle = s.lifecycle.kind
    if (lifecycle !== 'running' && lifecycle !== 'recovering') return
    const recovery = boundTo(s, record).find(p => p.recovery)
    if (recovery?.phase === 'include') rebid(s, out, recovery)
  }

  /**
   * The plan bound to a stuck nonce bids there again, a step only while it may add risk; otherwise
   * recovery continues the nonce's obligation. A step at an uncertain nonce is cancelled for it.
   */
  const bidAgain = (s: KernelState, out: Command[], record: NonceRecord, uncertain: boolean) => {
    const lifecycle = s.lifecycle.kind
    if (lifecycle !== 'running' && lifecycle !== 'recovering') return
    const bound = boundTo(s, record)
    const recovery = bound.find(p => p.recovery)
    const step = bound.find(p => !p.recovery)
    if (step && uncertain) cancel(s, out, step, 'its nonce stayed uncertain after a re-send')
    else if (step && !recovery) {
      const mayBid = step.phase === 'include' && !step.terms!.capped && !latched(s)
      if (mayBid && lifecycleAllows(s, step)) return rebid(s, out, step)
      if (s.lifecycle.kind !== 'recovering') return
      cancel(s, out, step, `recovering: ${s.lifecycle.reason}`)
    }
    if (recovery) return recovery.phase === 'include' ? rebid(s, out, recovery) : undefined
    continueObligation(s, out, record)
  }

  /** A bound plan bids again at its nonce, back through every check of its first bid. */
  const rebid = (s: KernelState, out: Command[], plan: Plan) => {
    plan.phase = 'ready'
    advance(s, out, plan)
  }

  /** A neutralizer still revoking its entry here bids again as one; anything else is filled. */
  const continueObligation = (s: KernelState, out: Command[], record: NonceRecord) => {
    const last = record.candidates.filter(c => c.kind !== 'step').at(-1)
    const entry =
      last?.kind === 'neutralizer'
        ? last.retires
            .map(id => s.entries[id])
            .find(e => e?.state === 'revoking' && e.neutralizing?.nonce === record.nonce)
        : undefined
    if (entry)
      return startRecovery(s, out, 'neutralizer', { entry, nonce: record.nonce, continued: true })
    if (!fillFailedHere(s, record)) startRecovery(s, out, 'fill', { nonce: record.nonce })
  }

  /** Waiting on a startup read never suspends the dead-man switch: a lapsed affirmation recovers from what is stored. */
  const checkStarted = (s: KernelState, out: Command[]) => {
    if (s.lifecycle.kind !== 'starting') return
    const lapsed = Object.values(s.entries).some(
      e => OPEN_ENTRY.has(e.state) && s.now - e.affirmedAt > config.revokeAfterStaleMs
    )
    if (lapsed) return enterRecovering(s, out, 'affirmation lapsed during startup')
    if (!s.lifecycle.nonceChecked || s.head === undefined) return
    if (Object.values(s.nonces).some(r => r.foreign))
      return enterRecovering(s, out, 'foreign nonce outstanding at start')
    const since = s.lifecycle.startHead ?? (s.lifecycle.startHead = s.head.number)
    const consumedUnresolved = unidentifiedNonces(s).length > 0
    const unobserved = Object.values(s.entries).some(
      e => UNRETIRED.has(e.state) && (e.observed === undefined || e.observed.block < since)
    )
    const noLedgerOnDisk = s.ackedSeq === 0
    if (consumedUnresolved || unobserved || noLedgerOnDisk) return
    s.lifecycle = { kind: 'running' }
  }

  const checkStopped = (s: KernelState, out: Command[]) => {
    if (s.lifecycle.kind !== 'recovering') return
    const openEntries = Object.values(s.entries).some(e => UNRETIRED.has(e.state))
    const openNonces = Object.keys(s.nonces).length > 0
    const inFlight =
      s.slot !== undefined ||
      Object.values(s.plans).some(p => p.status === 'executing' && occupiesNonce(s, p))
    const durable = s.ackedSeq >= s.seq
    if (!openEntries && !openNonces && !inFlight && durable)
      return stop(s, out, 'clean', s.lifecycle.reason)
    if (s.now - s.lifecycle.since >= config.recoveryBoundMs)
      stop(s, out, 'unsafe', 'recovery bound exceeded')
  }

  /**
   * Flushes when the durable projection changed, or when a committed plan awaits a flush that was
   * never emitted because its commit changed nothing durable, as a second release of the same offer.
   */
  const flushIfChanged = (s: KernelState, out: Command[]) => {
    const ledger = toDurable(s, config)
    const text = durableText(ledger)
    const awaited = Object.values(s.plans).some(
      p => p.status === 'executing' && p.phase === 'commit' && (p.flushSeq ?? 0) > s.seq
    )
    if (text === s.lastDurable && !awaited) return
    if (s.seq + 1 >= NEVER) return stop(s, out, 'unsafe', 'flush sequence exhausted')
    s.lastDurable = text
    s.seq++
    emit(out, {
      type: 'flush',
      seq: s.seq,
      ledger: { ...ledger, header: { ...ledger.header, seq: s.seq } }
    })
  }

  /**
   * Why a plan's dispatched bytes must stay home now, as `Flushed` would judge it, or undefined. The
   * executor asks this at network handoff, so the last check and the flush check are one rule; a
   * re-send of bytes already handed off (`hash`) is judged by the rebroadcast rule instead.
   */
  const withholds = (
    state: KernelState,
    intentId: Id,
    now: number,
    hash?: string
  ): string | undefined => {
    const s = { ...state, now }
    const resent = hash === undefined ? undefined : findCandidate(s, hash)
    if (resent?.[0].resolution) return 'its nonce resolved'
    const plan = state.plans[intentId]
    if (plan === undefined || plan.recovery !== undefined) return undefined
    if (plan.status !== 'executing') return `plan ${plan.status}`
    if (resent?.[1].sent !== 'unknown') return withholdReason(s, plan)
    return resendable(s, resent[1]) ? undefined : 're-send revoked'
  }

  /**
   * Why the signer must not be invoked now for the `sign` command `request`, or undefined: the
   * checks the kernel makes when the signature comes back, made before it is produced.
   */
  const signRefusal = (state: KernelState, request: number, now: number): string | undefined => {
    const outstanding = state.outstanding[request]
    if (outstanding?.kind !== 'sign') return 'the request was withdrawn'
    const plan = state.plans[outstanding.plan]
    if (plan?.status !== 'executing') return `plan ${plan?.status ?? 'gone'}`
    const s = { ...state, now }
    const step = plan.steps[plan.cursor]
    const unbound = step?.kind === 'tx' ? targetRefusal(s, plan, outstanding.generation) : undefined
    if (unbound) return unbound
    if (step?.kind === 'tx' && waitingPhase(s, plan)) return 'it may not bid yet'
    return (
      stillAuthorized(s, plan) ??
      reauthorized(s, plan) ??
      (step?.kind === 'tx' && !simFresh(s, plan) ? 'simulation is no longer fresh' : undefined)
    )
  }

  return { initialState, reduce, withholds, signRefusal }
}
