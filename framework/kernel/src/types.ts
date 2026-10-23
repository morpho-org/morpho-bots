import type { LEDGER_FORMAT } from './durable'

export type Id = string
export type Hash = string
export type Resources = Readonly<Record<string, bigint>>

/** A transaction as it will be signed: validators decode `data`, and nothing re-encodes it. */
export type TxPayload = {
  kind: 'tx'
  to: string
  data: string
  value: bigint
}
/** EIP-712 typed data exactly as it will be signed, so a validator binds the domain and types too. */
export type TypedPayload = {
  kind: 'typed'
  domain: Readonly<{
    name?: string
    version?: string
    chainId?: bigint
    verifyingContract?: string
    salt?: string
  }>
  types: Readonly<Record<string, readonly Readonly<{ name: string; type: string }>[]>>
  primaryType: string
  message: Readonly<Record<string, unknown>>
}
/** A signature handed to an offchain party (an API), which is exposure without a nonce. */
export type ReleasePayload = {
  kind: 'release'
  channel: string
  message: Readonly<Record<string, unknown>>
}
export type Payload = TxPayload | TypedPayload | ReleasePayload

export type Exposure = 'broadcast' | 'inclusion'

export type CommitmentSpec = {
  id: Id
  /** `inclusion`: exists only if the carrying transaction executes; `broadcast`: exists once the payload leaves. */
  exposure: Exposure
  resources: Resources
  /** Chain time after which the protocol refuses the commitment. */
  expiry: bigint
  /** A cap on consumption: consumed ≥ cap retires the commitment. */
  cap: bigint
  neutralizer: TxPayload
}

export type ValidatorReading =
  | { ok: false; reason: string }
  | {
      ok: true
      creates: readonly CommitmentSpec[]
      /** Commitments whose signature this payload carries out of the process. */
      exposes: readonly Id[]
      carries: readonly string[]
      retires: readonly Id[]
      consumes: Resources
    }
export type OkValidatorReading = Extract<ValidatorReading, { ok: true }>

export type ValidatorContext = { account: string; chainId: number }

export type Validator = {
  id: string
  /**
   * Bumped on any change to what the validator authorizes: the kernel trusts a ledger entry recorded
   * under `id@version` only while a running validator reads that version.
   */
  version: number
  /** Older versions whose recorded entries this validator still reads and neutralizes. */
  accepts?: readonly number[]
  claims(payload: Payload): boolean
  read(payload: Payload, witness: unknown, context: ValidatorContext): ValidatorReading
  /** Whether a successful receipt shows the transition the reading promised. */
  confirm(payload: TxPayload, logs: readonly Log[]): boolean
}

/** What the fee policy is told about the candidate it prices. */
export type FeeContext = {
  kind: CandidateKind
  nonce: number
  /** 1 for the first candidate at a nonce, one higher for each replacement. */
  level: number
  head: number
  /** The head when the candidate's plan was admitted. */
  admittedHead: number
}

/** Proposes a candidate's fee ceiling (native units). The kernel clamps it; it never raises a bound. */
export type FeePolicy = (context: FeeContext) => bigint

export type KernelConfig = {
  chainId: number
  account: string
  validators: readonly Validator[]
  policy: { targets: readonly string[]; recoveryTargets: readonly string[] }
  caps: Resources
  observedResources: readonly string[]
  /** Native-token ceiling reserved per unresolved nonce (policy `maxSpendWei`). */
  feeReserve: bigint
  feePolicy: FeePolicy
  maxSimLagBlocks: number
  /**
   * How far below head a fact may have been read. It must cover the bot's slowest fact source plus
   * its preparation time, and how far a chain source may lag the one a crashed run followed.
   */
  maxEvidenceAgeBlocks: number
  stuckBlocks: number
  latchBoundBlocks: number
  recoveryBoundMs: number
  revokeAfterStaleMs: number
  maxRecoveryAttempts: number
  /** How long after its final check an act may still be dispatched; later, the act is withheld. */
  maxDispatchLagMs: number
}

/**
 * `witness` is what the payload's validator reads it against, such as a tree's preimage, or, for a step
 * with no payload, what its materializer builds it from; the facts an act's decision rests on are
 * {@link PlanInput.evidence}.
 */
export type StepSpec = { kind: 'sign' | 'tx' | 'release'; payload?: Payload; witness?: unknown }

/** What a fact's version reads as when it is known absent, rather than present with a digest. */
export const ABSENT = 'absent'

/**
 * A named fact a plan's authorization rests on, as it stood when the plan was decided: its version
 * (a digest, or {@link ABSENT}), and the block of this kernel's chain it was read at.
 */
export type Fact = { id: Id; version: string; basis: BlockRef }

/**
 * A fact as the engine last saw it; one that is unknown or failed authorizes nothing. An `expiry`
 * bounds the `notAfter` of every plan whose current stage rests on the fact, and extends it only
 * while the plan rests and every fact it rests on reads as decided.
 */
export type Observation =
  | { id: Id; version: string; expiry?: number }
  | { id: Id; unavailable: 'unknown' | 'failed' }

/**
 * Semantic identities a plan reads and writes, such as `position:<market>:<borrower>`: a plan whose
 * writes meet another executing plan's reads or writes, or the reverse, is not admitted beside it.
 */
export type Conflicts = { reads?: readonly Id[]; writes?: readonly Id[] }

/** Why the bot decided an act, in a few named scalars, so the ledger can say why beside what. */
export type DecisionRecord = Readonly<Record<string, string | number | boolean>>

/** What a candidate's bytes were authorized on; kept as a record, it authorizes nothing again. */
export type Authority = { evidence: readonly Fact[]; decision?: DecisionRecord }

/** Everything in a plan is untrusted: the kernel derives exposure from validator readings only. */
export type PlanInput = {
  intentId: Id
  submissionId?: Id
  steps: readonly StepSpec[]
  /**
   * The plan's deadline, the earliest expiry of the evidence it rests on: a plan submitted past it
   * is refused, and once admitted nothing of it leaves past it.
   */
  notAfter: number
  basisBlock: number
  /** A tighter ceiling on each own candidate's total fee, in wei (not per gas); recovery ignores it. */
  maxSpendWei?: bigint
  /** The facts it rests on; a risk-reducing plan's are never checked. */
  evidence?: readonly Fact[]
  conflicts?: Conflicts
  /** An executing plan this one replaces, failed only if this one is admitted. */
  supersedes?: Id
  decision?: DecisionRecord
}

declare const authored: unique symbol

/**
 * Marks a `K` built by `@repo/controller`'s constructors for kernel domain `D`, which compute its
 * evidence, basis and deadline; a hand-built one needs a visible cast. A phantom brand survives a
 * spread, so overriding a field of an authored value is as deliberate as a cast.
 */
export type Authored<K extends 'plan' | 'advance', D extends string = string> = Readonly<{
  [authored]: Readonly<{ kind: K; domain: D }>
}>

export type BlockRef = { block: number; blockHash: Hash }

/** A receipt log as the chain reports it; a validator decodes `topics` and `data` with its ABI. */
export type Log = Readonly<{ address: string; topics: readonly string[]; data: string }>

export type EntryState = 'intended' | 'signed' | 'exposed' | 'live' | 'revoking' | 'retired'

/** The states in which a commitment is out and the kernel's to withdraw: the only ones its ledger keeps. */
export const HELD_STATES = ['exposed', 'live', 'revoking'] as const
export type HeldState = (typeof HELD_STATES)[number]

/** The payload that created a commitment, kept so a restart can ask whether current policy still allows it. */
export type Origin = { payload: Payload; witness?: unknown }

export type Entry = {
  spec: CommitmentSpec
  state: EntryState
  intentId: Id
  validator: string
  creators: Hash[]
  deadCreators: Hash[]
  /** Set when the entry leaves `intended`. */
  origin?: Origin
  /** Loaded from an earlier run's ledger, which cannot say whether that run's later stages ran. */
  adopted?: true
  consumedFinal: bigint
  prior?: 'exposed' | 'live'
  neutralizing?: { nonce: number; hash: Hash }
  retiredBy?: string
  recoveryAttempts: number
  stuck: boolean
  compensate: boolean
  affirmedAt: number
  liveAt?: BlockRef
  observed?: BlockRef & { consumed: bigint; neutralized: boolean }
  retireEvidence?: BlockRef
}

export type CandidateKind = 'step' | 'neutralizer' | 'fill'
/** `withheld`: committed and recorded, then deliberately never sent. */
export type SendStatus = 'unsent' | 'accepted' | 'unknown' | 'rejected' | 'withheld'

export type Candidate = {
  hash: Hash
  raw: string
  payload: TxPayload
  kind: CandidateKind
  intentId: Id
  step: number
  creates: Id[]
  exposes: Id[]
  retires: Id[]
  consumes: Resources
  feeLevel: number
  fee: bigint
  sent: SendStatus
  /** The conflict ids its plan writes: whichever run sees it land raises their marks. */
  writes: Id[]
  /** Persisted in the flush that gates the send, so the ledger records why it went. */
  authority?: Authority
}

/** The nonce, replacement level and native fee ceiling a transaction is signed at. */
export type SignTerms = { nonce: number } & Pick<Candidate, 'feeLevel' | 'fee'>

/**
 * `restored`: read back from the ledger, so the crashed run may have seen heads this run has not,
 * though none more than {@link KernelConfig.maxEvidenceAgeBlocks} past this run's or its own `after`.
 */
export type Release = { writes: Id[]; after: number; restored?: true }

export type Resolution = BlockRef & {
  /** `null`: a transaction the kernel never signed consumed the nonce. */
  winner: Hash | null
  success: boolean
  confirmed: boolean
}

export type NonceRecord = {
  nonce: number
  candidates: Candidate[]
  resolution?: Resolution
  lastActionHead: number
  failedFillHead?: number
  unknownSince?: number
  /** Consumed or pending at the chain by a transaction the kernel never recorded. */
  foreign?: true
}

export type Phase =
  | 'ready'
  | 'materialize'
  | 'awaiting-advance'
  | 'simulate'
  | 'await-slot'
  | 'sign'
  | 'commit'
  | 'expose'
  | 'include'

export type PlanStatus =
  | 'executing'
  | 'settled'
  | 'abandoned'
  | 'compensating'
  | 'compensated'
  | 'failed'

export type Step = StepSpec & { reading?: OkValidatorReading }

export type Plan = {
  intentId: Id
  submissionId?: Id
  /** Canonical digest of the submitted steps; a submission id is bound to it. */
  digest: string
  committedAt?: number
  recovery?: { kind: 'neutralizer' | 'fill'; entry?: Id; targetNonce?: number }
  steps: Step[]
  cursor: number
  /** The step the current stage began at; evidence and `notAfter` are this stage's own. */
  stage: number
  phase: Phase
  status: PlanStatus
  request?: number
  signatures: string[]
  envelope: { ids: Id[]; consumes: Resources }
  committedConsumes: Resources
  exposed: boolean
  basisBlock: number
  notAfter: number
  maxSpendWei?: bigint
  evidence?: readonly Fact[]
  conflicts?: Conflicts
  decision?: DecisionRecord
  admittedHead?: number
  lastInclusion?: number
  included?: Inclusion[]
  sim?: BlockRef
  /** What the transaction in progress is signed at, kept for the candidate it commits. */
  terms?: SignTerms
  pending?: { hash: Hash; raw: string }
  flushSeq?: number
  reason?: string
}

export type Inclusion = { step: number; hash: Hash; block: number }

export type Lifecycle =
  | { kind: 'idle' }
  | { kind: 'starting'; since: number; startHead?: number; nonceChecked: boolean }
  | { kind: 'running' }
  | { kind: 'recovering'; reason: string; since: number }
  | { kind: 'stopped'; outcome: 'clean' | 'unsafe' | 'refused'; reason: string }

export type Outstanding = {
  kind: 'materialize' | 'simulate' | 'sign' | 'broadcast' | 'release'
  plan: Id
  /** For a broadcast: the candidate these bytes belong to, which a timeout marks `unknown`. */
  hash?: Hash
}

export type Submission = {
  intentId: Id
  status: 'exposed' | 'settled' | 'compensated' | 'failed'
  digest: string
}

export type KernelState = {
  lifecycle: Lifecycle
  now: number
  head?: { number: number; hash: Hash; timestamp: bigint }
  finalized: { number: number; timestamp: bigint }
  headers: Record<number, Hash>
  chainNonce?: number
  nextNonce?: number
  entries: Record<Id, Entry>
  nonces: Record<number, NonceRecord>
  plans: Record<Id, Plan>
  planOrder: Id[]
  outstanding: Record<number, Outstanding>
  slot?: number
  nextRequest: number
  seq: number
  lastDurable: string
  capacity: Record<string, { amount: bigint; block: number; blockHash: Hash }>
  /** Highest flush sequence the runtime has acknowledged as durable. */
  ackedSeq: number
  /** The block of our own last final effect on each resource. */
  watermarks: Record<string, number>
  /**
   * The highest block at which a plan writing each conflict id was included or released. Durable;
   * a mark the evidence floor reaches can refuse nothing, so it is pruned.
   */
  conflictMarks: Record<Id, number>
  /**
   * The durable part of the evidence floor, at least every conflict mark pruned; no fact read below
   * the floor is admitted. See {@link KernelConfig.maxEvidenceAgeBlocks}.
   */
  evidenceFloor: number
  /**
   * What each plan's release owes from the flush that gates it until it can no longer leave: its
   * conflict writes, and one past the highest head seen meanwhile, which marks them then.
   */
  releases: Record<Id, Release>
  /** The latest observation of each fact an executing plan rests on; seeded by its `Submit`. */
  observations: Record<Id, Observation>
  submissions: Record<Id, Submission>
}

export type KernelEvent =
  | {
      type: 'Start'
      /** Parsed file contents, untrusted until {@link validateLedger} accepts them; `null` when absent. */
      ledger: unknown
      enrollment: 'enrolled' | 'enrolling'
      now: number
      /** The account's code; the kernel runs only on an account with none (EIP-7702 delegation runs on every call). */
      accountCode: string
    }
  | {
      type: 'Submit'
      plan: PlanInput
      /** The current observation of each fact the plan names, delivered with it. */
      observations?: readonly Observation[]
    }
  /** Changes to facts that executing plans may rest on; others are ignored. */
  | { type: 'Observed'; observations: readonly Observation[] }
  /**
   * Moves a plan parked awaiting `stage`, the step it waits at, onto that stage's own evidence,
   * read after the plan's last inclusion. A refusal leaves the plan parked.
   */
  | {
      type: 'Advance'
      intentId: Id
      stage: number
      basisBlock: number
      notAfter: number
      evidence?: readonly Fact[]
      decision?: DecisionRecord
      /** The current observation of each fact the stage names, delivered with it. */
      observations?: readonly Observation[]
    }
  | { type: 'Affirm'; ids: readonly Id[] }
  | { type: 'Materialized'; request: number; payload: Payload; witness?: unknown }
  | { type: 'Simulated'; request: number; ok: boolean; block: number; blockHash: Hash }
  | { type: 'Signed'; request: number; hash?: Hash; raw?: string; signature?: string }
  | { type: 'EffectFailed'; request: number }
  | { type: 'TimedOut'; request: number }
  | { type: 'Flushed'; seq: number }
  | { type: 'FlushFailed'; seq: number; reason: 'io' | 'fenced' }
  | {
      type: 'Broadcasted'
      request?: number
      hash: Hash
      /** `withheld`: the send guard never let the bytes go, so they provably never left. */
      outcome: 'accepted' | 'rejected' | 'unknown' | 'withheld'
    }
  | { type: 'Released'; request: number; outcome: 'ok' | 'unknown' }
  | { type: 'Seen'; hash: Hash }
  | {
      type: 'Head'
      number: number
      hash: Hash
      timestamp: bigint
      finalized: number
      finalizedTimestamp: bigint
    }
  | { type: 'Reorg'; fork: number }
  /** A canonical header at or below the head; evidence at a block the kernel has no header for is ignored. */
  | { type: 'Header'; number: number; hash: Hash }
  | {
      type: 'Receipt'
      hash: Hash
      block: number
      blockHash: Hash
      status: 'success' | 'reverted'
      logs: readonly Log[]
    }
  | { type: 'NonceAt'; block: number; blockHash: Hash; latest: number; pending: number }
  | {
      type: 'NonceTx'
      nonce: number
      hash: Hash
      block: number
      blockHash: Hash
      status: 'success' | 'reverted'
      logs: readonly Log[]
    }
  | {
      type: 'CommitmentObserved'
      id: Id
      block: number
      blockHash: Hash
      consumed: bigint
      neutralized: boolean
    }
  | { type: 'Capacity'; resource: string; amount: bigint; block: number; blockHash: Hash }
  | { type: 'Tick'; now: number }
  | { type: 'Stop' }
  | { type: 'Halt'; reason: string }

/** `advanced` and `stalled` answer an `Advance`: a stalled plan stays parked. */
export type Notice =
  | 'admitted'
  | 'refused'
  | 'advanced'
  | 'stalled'
  | 'abandoned'
  | 'settled'
  | 'compensating'
  | 'compensated'
  | 'failed'
  | 'known'

/** Why a `Submit` was refused, for a caller to act on; the refusal's `reason` says it in words. */
export type RefusalCode =
  | 'malformed'
  | 'duplicate'
  | 'lifecycle'
  | 'unauthorized'
  | 'supersession'
  | 'conflict'
  | 'capacity'
  | 'evidence_expired'
  | 'evidence_too_old'
  | 'evidence_invalid'
  | 'evidence_predates_own_effect'
  | 'decision_predates_own_effect'

export type Refusal = { code: RefusalCode; reason: string }

export type NoticeBody = {
  intentId: Id
  reason?: string
  /** On a plan's last notice: every step it mined, reverted or not, in step order. */
  included?: readonly Inclusion[]
} & (({ notice: 'refused' } & Refusal) | { notice: Exclude<Notice, 'refused'> })

/**
 * What one kernel transition did, in order, its own neutralizers included; `dropped` is an entry
 * removed before it was ever exposed. History, not state: no event retracts an inclusion a reorg
 * undoes, so current inclusion and exposure are read from {@link KernelState}.
 */
export type KernelActivity =
  | {
      type: 'sent'
      intentId: Id
      step: number
      kind: CandidateKind
      nonce: number
      hash: Hash
      status: Exclude<SendStatus, 'unsent'>
    }
  | { type: 'released'; intentId: Id; step: number; outcome: 'ok' | 'unknown' }
  | ({ type: 'included'; intentId: Id } & Inclusion)
  | { type: 'entry'; id: Id; intentId: Id; from?: EntryState; to: EntryState | 'dropped' }
  | ({ type: 'notice' } & NoticeBody)
  | { type: 'alarm'; reason: string }

export type Command =
  | {
      type: 'materialize'
      request: number
      intentId: Id
      step: number
      signatures: readonly string[]
      /** The witness its step was submitted with, which a materializer builds the step from. */
      witness?: unknown
    }
  | { type: 'simulate'; request: number; intentId: Id; payload: TxPayload }
  | { type: 'sign'; request: number; intentId: Id; payload: TypedPayload }
  | ({ type: 'sign'; request: number; intentId: Id; payload: TxPayload } & SignTerms)
  | { type: 'flush'; seq: number; ledger: DurableLedger }
  | { type: 'broadcast'; request: number; hash: Hash; raw: string }
  | { type: 'release'; request: number; payload: ReleasePayload }
  | { type: 'findNonceTx'; nonce: number }
  | ({ type: 'notify' } & NoticeBody)
  | {
      type: 'report'
      outcome: 'clean' | 'unsafe' | 'refused'
      reason: string
      open: { entries: Id[]; nonces: number[] }
    }

export type DurableEntry = Pick<
  Entry,
  | 'spec'
  | 'intentId'
  | 'validator'
  | 'creators'
  | 'deadCreators'
  | 'consumedFinal'
  | 'prior'
  | 'neutralizing'
  | 'compensate'
> & {
  state: HeldState
  origin: Origin
  /** Last affirmation, rounded down to a quarter of `revokeAfterStaleMs` so it rarely forces a write. */
  affirmedBy: number
}

export type DurableLedger = {
  header: { format: typeof LEDGER_FORMAT; chainId: number; account: string; seq: number }
  nextNonce: number | null
  entries: Record<Id, DurableEntry>
  nonces: Record<
    number,
    { nonce: number; candidates: Candidate[]; unknownSince?: number; foreign?: true }
  >
  submissions: Record<Id, Submission>
  watermarks: Record<string, number>
  /** Pairs, so no conflict id can collide with a codec tag. */
  conflictMarks: [Id, number][]
  evidenceFloor: number
  releases: Record<Id, Release>
}
