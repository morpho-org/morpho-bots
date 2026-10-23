import type {
  Command,
  KernelActivity,
  KernelConfig,
  KernelEvent,
  KernelState,
  Log,
  Refusal,
  TxPayload
} from '../src'
import type { ModelTree } from './validators'

import { available, createKernel, decodeLedger } from '../src'
import { encodeLedger } from '../src/testing'
import { decodeCall } from './codec'
import { ecrecoverPlan, makeConfig, publish, signatureOf, T, txHash } from './fixtures'
import { modelLog } from './validators'

type Answerable = Extract<Command, { request: number }>

/**
 * Drives the reference reducer the way a runtime would: every command is recorded, answered only
 * when a trace says so, and a crash throws away everything except the last completed flush.
 */
export class Harness {
  readonly config: KernelConfig
  private kernel: ReturnType<typeof createKernel>
  state: KernelState
  disk: string | null = null
  log: Command[] = []
  activity: KernelActivity[] = []
  private answered = new Set<number>()
  private flushedSeq = 0
  block = 0
  now = 0
  private fork = ''
  finalizedLag = 2

  constructor(config: KernelConfig = makeConfig()) {
    this.config = config
    this.kernel = createKernel(config)
    this.state = this.kernel.initialState()
  }

  send(event: KernelEvent): Command[] {
    const { state, commands, activity } = this.kernel.reduce(this.state, event)
    this.activity.push(...activity)
    this.state = state
    this.log.push(...commands)
    return commands
  }

  alarms() {
    return this.activity.flatMap(a => (a.type === 'alarm' ? [a.reason] : []))
  }

  /** Swap in a new config, as a redeploy would, keeping only what is on disk. */
  redeploy(config: KernelConfig) {
    ;(this as { config: KernelConfig }).config = config
    this.kernel = createKernel(config)
    this.crash()
  }

  crash() {
    this.state = this.kernel.initialState()
    this.log = []
    this.answered.clear()
  }

  boot(
    enrollment: 'enrolled' | 'enrolling' = this.disk ? 'enrolled' : 'enrolling',
    ledger: unknown = this.ledger()
  ) {
    return this.send({
      type: 'Start',
      ledger,
      enrollment,
      now: this.now,
      accountCode: '0x'
    })
  }

  ledger() {
    return this.disk ? decodeLedger(this.disk) : null
  }

  /** Enrolls, reaches `running`, and makes the empty ledger durable. */
  start(nonce = 0) {
    this.boot('enrolling', null)
    this.head(1)
    this.send({ type: 'NonceAt', block: 1, blockHash: this.hash(1), latest: nonce, pending: nonce })
    this.flush()
    return this
  }

  private chain = new Map<number, string>()

  hash(n: number) {
    return this.chain.get(n) ?? `b${n}${this.fork}`
  }

  head(n = this.block + 1, finalized = n - this.finalizedLag) {
    this.block = n
    this.chain.set(n, `b${n}${this.fork}`)
    return this.send({
      type: 'Head',
      number: n,
      hash: this.hash(n),
      timestamp: BigInt(n * 2),
      finalized,
      finalizedTimestamp: BigInt(Math.max(finalized, 0) * 2)
    })
  }

  /** Advances the head until `block` is final. */
  finalize(block: number) {
    while (this.state.finalized.number < block) this.head()
  }

  reorg(fork: number) {
    this.fork += "'"
    for (const n of this.chain.keys()) if (n > fork) this.chain.delete(n)
    this.block = fork
    return this.send({ type: 'Reorg', fork })
  }

  tick(ms: number) {
    this.now += ms
    return this.send({ type: 'Tick', now: this.now })
  }

  pending<T extends Answerable['type']>(type: T): Extract<Answerable, { type: T }>[] {
    return this.log.filter(
      (c): c is Extract<Answerable, { type: T }> =>
        c.type === type && 'request' in c && !this.answered.has(c.request)
    )
  }

  private answer(command: Answerable) {
    this.answered.add(command.request)
  }

  simulate(ok = true) {
    for (const command of this.pending('simulate')) {
      this.answer(command)
      this.send({
        type: 'Simulated',
        request: command.request,
        ok,
        block: this.block,
        blockHash: this.hash(this.block)
      })
    }
  }

  sign() {
    for (const command of this.pending('sign')) {
      this.answer(command)
      if ('nonce' in command) {
        const hash = txHash(command.payload, command.nonce, command.feeLevel)
        this.send({ type: 'Signed', request: command.request, hash, raw: `raw(${hash})` })
      } else {
        this.send({
          type: 'Signed',
          request: command.request,
          signature: signatureOf(command.payload)
        })
      }
    }
  }

  /** Completes the newest flush: tmp → fsync → rename → fsync dir, then acknowledges it. */
  flush({ write = true, ack = true } = {}) {
    const flushes = this.log.filter(
      (c): c is Extract<Command, { type: 'flush' }> => c.type === 'flush'
    )
    const latest = flushes.at(-1)
    if (!latest || latest.seq <= this.flushedSeq) return
    if (write) {
      this.disk = encodeLedger(latest.ledger)
      this.flushedSeq = latest.seq
    }
    if (ack) this.send({ type: 'Flushed', seq: latest.seq })
  }

  broadcast(outcome: 'accepted' | 'rejected' | 'unknown' | 'timeout' = 'accepted') {
    for (const command of this.pending('broadcast')) {
      this.answer(command)
      if (outcome === 'timeout') this.send({ type: 'TimedOut', request: command.request })
      else this.send({ type: 'Broadcasted', request: command.request, hash: command.hash, outcome })
    }
  }

  release(outcome: 'ok' | 'unknown' = 'ok') {
    for (const command of this.pending('release')) {
      this.answer(command)
      this.send({ type: 'Released', request: command.request, outcome })
    }
  }

  materialize(build: (signatures: readonly string[]) => TxPayload, witness?: unknown) {
    for (const command of this.pending('materialize')) {
      this.answer(command)
      this.send({
        type: 'Materialized',
        request: command.request,
        payload: build(command.signatures),
        witness
      })
    }
  }

  /** Moves a plan parked at a stage boundary onto its next stage, read at the current head. */
  advance(intentId: string, extra: Partial<Extract<KernelEvent, { type: 'Advance' }>> = {}) {
    return this.send({
      type: 'Advance',
      intentId,
      stage: this.state.plans[intentId]?.cursor ?? -1,
      basisBlock: this.block,
      notAfter: 1_000_000,
      ...extra
    })
  }

  /** Answers simulate, sign, flush, and broadcast until the kernel asks for nothing more. */
  drive(outcome: 'accepted' | 'rejected' | 'unknown' | 'timeout' = 'accepted') {
    for (let i = 0; i < 20; i++) {
      const before = this.log.length
      this.simulate()
      this.sign()
      this.flush()
      this.broadcast(outcome)
      if (this.log.length === before) return
    }
  }

  mine(
    hash: string,
    {
      block = this.block,
      status = 'success',
      logs
    }: { block?: number; status?: 'success' | 'reverted'; logs?: Log[] } = {}
  ) {
    return this.send({
      type: 'Receipt',
      hash,
      block,
      blockHash: this.hash(block),
      status,
      logs: logs ?? this.logsFor(hash)
    })
  }

  private logsFor(hash: string) {
    const candidate = Object.values(this.state.nonces)
      .flatMap(r => r.candidates)
      .find(c => c.hash === hash)
    if (!candidate) return []
    const { fn, args } = decodeCall(candidate.payload) ?? { fn: '', args: {} }
    const { to } = candidate.payload
    if (fn === 'setIsRootRatified') return [modelLog(to, 'SetIsRootRatified', String(args.root))]
    if (fn === 'setConsumed') return [modelLog(to, 'SetConsumed', String(args.group))]
    return []
  }

  observe(id: string, consumed = 0n, neutralized = false, block = this.block) {
    return this.send({
      type: 'CommitmentObserved',
      id,
      block,
      blockHash: this.hash(block),
      consumed,
      neutralized
    })
  }

  capacity(resource: string, amount: bigint, block = this.block) {
    return this.send({ type: 'Capacity', resource, amount, block, blockHash: this.hash(block) })
  }

  reports() {
    return this.commands('report')
  }

  nonceAt(latest: number, pending = latest) {
    return this.send({
      type: 'NonceAt',
      block: this.block,
      blockHash: this.hash(this.block),
      latest,
      pending
    })
  }

  candidates() {
    return Object.values(this.state.nonces).flatMap(r =>
      r.candidates.map(c => ({ nonce: r.nonce, ...c }))
    )
  }

  candidate(prefix: string) {
    const found = this.candidates().filter(c => c.hash.startsWith(prefix))
    if (found.length !== 1)
      throw new Error(`expected one candidate ${prefix}, found ${found.length}`)
    return found[0]!
  }

  entry(id: string) {
    return this.state.entries[id]
  }

  available(resource: string) {
    return available(this.config, this.state, resource)
  }

  commands<T extends Command['type']>(type: T): Extract<Command, { type: T }>[] {
    return this.log.filter((c): c is Extract<Command, { type: T }> => c.type === type)
  }

  notices(intentId: string) {
    return this.commands('notify')
      .filter(c => c.intentId === intentId)
      .map(c => c.notice)
  }

  lastReason(intentId: string) {
    return this.commands('notify')
      .filter(c => c.intentId === intentId)
      .at(-1)?.reason
  }

  /** The last notice for `intentId` as a {@link Refusal}, if it was a refusal. */
  refusal(intentId: string): Refusal | undefined {
    const last = this.commands('notify')
      .filter(c => c.intentId === intentId)
      .at(-1)
    return last?.notice === 'refused' ? { code: last.code, reason: last.reason } : undefined
  }

  broadcastsTo(fn: string) {
    return this.commands('broadcast').filter(c => c.hash.startsWith(`0x${fn}:`))
  }

  /** Publishes `t` through the ecrecover ratifier and mines it, so its offers are live. */
  liveOffer(t: ModelTree = T, intentId = 'q:M1') {
    this.send({ type: 'Submit', plan: ecrecoverPlan(intentId, t) })
    this.sign()
    this.materialize(signatures => publish(t, signatures[0]), t)
    this.drive()
    this.head()
    this.mine(this.candidate('0xpublish').hash)
    return this
  }
}
