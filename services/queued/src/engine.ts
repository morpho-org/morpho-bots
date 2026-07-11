import type { Backoff, Logger, OutcomeRecord, PendingQueue } from '@repo/bot-kit'
import type { BotName, QueueState } from '@repo/home'
import type { Address, Hex, LocalAccount, PublicClient } from 'viem'

import {
  createBackoff,
  createDeploylessClient,
  createPendingQueue,
  createSigner,
  initialFees,
  QUEUE_BACKOFF_STATUSES,
  simulateLiquidationExec,
  splitIdPrefix,
  TxSendError,
  WIRE_VERSION
} from '@repo/bot-kit'
import { loadState, outcomesFile, QUEUE_STATE_VERSION, queueStateFile, saveState } from '@repo/home'
import { AgentPolicyError, AgentResponseError } from '@repo/signer'
import { ensureError, tryCatch } from '@repo/utils'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  createPublicClient,
  fallback,
  http,
  isAddress,
  isAddressEqual,
  isHex,
  zeroAddress
} from 'viem'
import { getBlock, getTransactionCount } from 'viem/actions'

import type { QueuedConfig } from './config'
import type { QueuePolicy } from './domains'

import { DOMAIN_NAMES, loadPolicies } from './domains'

// Sweep cadence: fast while any tx (or settled-cooldown label) is live so settlement + RBF land within
// seconds; slow when idle. Reconcile cadence: nonce drift is slow, so a coarse sweep suffices.
const ACTIVE_SWEEP_MS = 2_000
const IDLE_SWEEP_MS = 15_000
const RECONCILE_MS = 45_000
// Head/baseFee cache TTL — one fetch feeds a whole wave of per-record ingests without N round-trips.
const CACHE_TTL_MS = 2_000

/** The daemon's error taxonomy, carried to the server which maps it onto a {@link QueuedResponse}. */
export class EngineError extends Error {
  readonly code: 'bad_request' | 'unsupported_version' | 'chain_mismatch' | 'retry' | 'internal'

  constructor(code: EngineError['code'], message: string) {
    super(message)
    this.name = 'EngineError'
    this.code = code
  }
}

/** One domain's live state: its pending-tx queue, its failure backoff, its policy, and its state file. */
type DomainRuntime = {
  domain: BotName
  queue: PendingQueue
  backoff: Backoff
  policy: QueuePolicy
  statePath: string
}

/** The status snapshot the `status` handshake returns. `address` is null when disarmed. */
export type EngineStatus = {
  chainId: number
  address: Address | null
  armed: boolean
  pending: number
  wireVersion: number
}

export type Engine = {
  /** Restore per-domain runtimes, run one startup reconcile (armed), and start the sweep/reconcile timers. */
  start(): Promise<void>
  /** Handle one ingest: `outcome` → backoff bookkeeping (`{}`), `tx` → dedupe→re-sim→fee→submit (`{outcome}`). */
  ingest(record: unknown): Promise<{ outcome?: OutcomeRecord }>
  /**
   * Run one settlement/RBF sweep immediately against a FRESH head — the same work the internal timer
   * self-schedules. Exposed so a supervisor (or a test) can drive settlement deterministically instead
   * of waiting on the timer. No-op in dry-run (nothing to settle).
   */
  tick(): Promise<void>
  /** The `status` handshake payload (read-only; no mutex). */
  status(): EngineStatus
  /** Stop timers, drain the mutex, and persist every runtime (idempotent). */
  shutdown(): Promise<void>
}

/** Injected dependencies — kept explicit so the engine is constructible in-process for tests. */
type EngineDeps = {
  config: QueuedConfig
  /** The signing account (armed) or `null` (dry-run). main.ts owns building/handshaking it. */
  account: LocalAccount | null
  logger: Logger
  home: string
  /**
   * Re-fetches the agent's address for the reconcile drift check (armed agent mode only). A mismatch
   * means the agent restarted under a different key — fatal misconfig. Omitted in local/dry-run.
   */
  reverifyAddress?: (() => Promise<Address>) | undefined
  /** Called on a fatal drift (agent-address mismatch) so main.ts can persist, shut down, and exit 2. */
  onFatal?: ((code: number) => void) | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const REGISTERED: ReadonlySet<string> = new Set(DOMAIN_NAMES)

// Builds one full queue `outcome` envelope. Mirrors the CLI one-shot's `queueOutcome` exactly (same
// fields/vocabulary) so ack and terminal records are indistinguishable from the pre-daemon wire.
function queueOutcome(args: {
  id: string
  domain: string
  op: string
  chainId: number
  status: string
  block?: number | undefined
  txHash?: Hex | undefined
  nonce?: number | undefined
  reason?: string | undefined
}): OutcomeRecord {
  return {
    v: WIRE_VERSION,
    kind: 'outcome',
    id: args.id,
    domain: args.domain,
    op: args.op,
    chainId: args.chainId,
    at: new Date().toISOString(),
    summary: `${args.domain} queue ${args.status}${args.reason ? `: ${args.reason}` : ''}`,
    status: args.status,
    ...(args.block !== undefined ? { block: args.block } : {}),
    ...(args.txHash ? { txHash: args.txHash } : {}),
    ...(args.nonce !== undefined ? { nonce: args.nonce } : {}),
    ...(args.reason ? { reason: args.reason } : {})
  }
}

/**
 * Wraps an agent-backed account so a single `signTransaction` retries ONCE on a connect-class
 * failure — a plain `Error` from a dead or absent signer socket (the agent restarted mid-life; the
 * client opens one connection per request, so the next attempt reconnects). Typed protocol errors
 * ({@link AgentPolicyError}, {@link AgentResponseError}) are deterministic verdicts — a retry would
 * only replay the same rejection — so they propagate on the first throw. Local-key accounts never
 * hit the socket and are wrapped nowhere.
 */
export function withSignRetry(account: LocalAccount): LocalAccount {
  const sign = account.signTransaction.bind(account)
  return {
    ...account,
    signTransaction: async (...args: Parameters<typeof sign>) => {
      try {
        return await sign(...args)
      } catch (error) {
        if (error instanceof AgentPolicyError || error instanceof AgentResponseError) throw error
        return sign(...args)
      }
    }
  }
}

/**
 * The per-chain, domain-agnostic transaction manager. Owns dedupe, backoff, re-sim, fee policy,
 * nonce, submit, and continuous settlement/RBF for every domain's txs against ONE EOA and ONE nonce
 * cursor. Constructible in-process (no `process.exit`, no signal handling — main.ts owns exit codes):
 * `createEngine(deps)` takes a resolved config, an injected account (or `null` for dry-run), and a
 * logger; `start()` restores state and arms the timers; `ingest()` is the socket work; `shutdown()`
 * drains and persists.
 */
export function createEngine(deps: EngineDeps): Engine {
  const { config, account, logger, home, reverifyAddress, onFatal } = deps
  const armed = account !== null
  const outcomesPath = outcomesFile(home, String(config.chainId))

  // Sends + the signer's own reads run against the broadcast endpoint; head/baseFee for sweeps come
  // from the SAME endpoint so stuck-detection sees what receipts see (a deviation from the one-shot's
  // read-client head — see the TIB). The read client (rpcUrl) serves the re-sim `eth_call` only.
  const sendUrl = config.sendRpcUrl ?? config.rpcUrl
  const sendTransport = config.rpcUrlFallback
    ? fallback([http(sendUrl), http(config.rpcUrlFallback)])
    : http(sendUrl)
  const sendClient: PublicClient = createPublicClient({
    chain: config.chain,
    transport: sendTransport
  })
  const readClient = createDeploylessClient({
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    rpcUrlFallback: config.rpcUrlFallback
  })

  const signer = armed
    ? createSigner({
        chain: config.chain,
        rpcUrl: config.rpcUrl,
        rpcUrlFallback: config.rpcUrlFallback,
        ...(config.sendRpcUrl ? { sendRpcUrl: config.sendRpcUrl } : {}),
        account
      })
    : null
  // The `from` for the re-sim `eth_call`: the signing EOA when armed, else `LIQUIDATOR_ADDRESS` (or a
  // zero placeholder) — the sim is advisory when disarmed, so the exact `from` is not load-bearing.
  const eoa: Address = signer?.account.address ?? config.liquidatorAddress ?? zeroAddress

  const runtimes = new Map<BotName, DomainRuntime>()
  const dirty = new Set<DomainRuntime>()
  // After a `TxSendError` the signer rolled its cursor back; NACK further submits until the next sweep
  // clears the flag (mirrors the one-shot's break-the-batch).
  let sendAborted = false

  // ---- head/baseFee cache -------------------------------------------------
  // The cache exists so a per-wave BURST of ingests shares one head/baseFee fetch; sweeps and reconcile
  // pass `force` because they want current chain truth (a stale head can't detect a freshly-stuck tx).
  let cache: { head: bigint; baseFee: bigint; at: number } | null = null
  async function chainState(force = false): Promise<{ head: bigint; baseFee: bigint }> {
    const now = Date.now()
    if (!force && cache && now - cache.at < CACHE_TTL_MS) return cache
    const block = await getBlock(sendClient, { blockTag: 'latest' }).catch((error: unknown) => {
      throw new EngineError('retry', `base_fee_unavailable: ${ensureError(error).message}`)
    })
    if (block.baseFeePerGas === null) {
      throw new EngineError('retry', 'base_fee_unavailable: chain returned no baseFeePerGas')
    }
    cache = { head: block.number, baseFee: block.baseFeePerGas, at: now }
    return cache
  }

  // ---- mutex --------------------------------------------------------------
  // One promise-chain mutex over {ingest, sweep, reconcile, shutdown} — prevents double-`replaceStuck`
  // and makes sharing the single signer/nonce cursor safe.
  let mutex: Promise<unknown> = Promise.resolve()
  function locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = mutex.then(fn, fn)
    mutex = run.catch(() => undefined)
    return run
  }

  // Every outcome — sync ack AND terminal — flows through this one chokepoint (single writer, O_APPEND).
  function appendOutcome(outcome: OutcomeRecord): void {
    appendFileSync(outcomesPath, `${JSON.stringify(outcome)}\n`)
  }

  function totalPending(): number {
    let n = 0
    for (const rt of runtimes.values()) n += rt.queue.size
    return n
  }

  function anyInflight(): boolean {
    for (const rt of runtimes.values()) if (rt.queue.inflightLabels().size > 0) return true
    return false
  }

  // Sync the nonce cursor ONLY when TOTAL pending across every domain is 0 (not just the calling
  // queue's) — the multi-domain fix for the pending-queue's sync-on-my-empty seam.
  const guardedSyncNonce = async (): Promise<void> => {
    if (signer && totalPending() === 0) await signer.syncNonce()
  }

  const notArmed = (): Promise<never> =>
    Promise.reject(new Error('queued: a disarmed daemon never submits'))

  function makeRuntime(
    domain: BotName,
    policy: QueuePolicy,
    state: QueueState | null
  ): DomainRuntime {
    const backoff = createBackoff({
      baseBlocks: config.backoffBaseBlocks,
      maxBlocks: config.backoffMaxBlocks,
      ...(state ? { initialState: state.backoff } : {})
    })
    const queue = createPendingQueue({
      // Armed: the shared signer. Disarmed: stubs that never fire (no submit, no onBlock in dry-run).
      send: signer ? signer.send : notArmed,
      getReceipt: signer ? signer.getReceipt : notArmed,
      getBaseFee: signer ? signer.getBaseFee : notArmed,
      syncNonce: guardedSyncNonce,
      maxFeeWei: config.maxFeeWei,
      stuckBlocks: config.stuckBlocks,
      logger,
      settledCooldownBlocks: policy.settledCooldownBlocks,
      ...(policy.revertReason ? { revertReason: policy.revertReason } : {}),
      ...(state ? { initialState: state.queue } : {}),
      // Terminal fates (confirm/revert/drop) become jsonl-only outcomes — the pipe that submitted has
      // long exited, so there is no ack to return; the journal is the monitoring plane.
      onSettled: info =>
        appendOutcome(
          queueOutcome({
            id: info.label,
            domain,
            op: splitIdPrefix(info.label).op,
            chainId: config.chainId,
            status: info.status,
            txHash: info.txHash,
            nonce: info.nonce,
            reason: info.reason
          })
        )
    })
    return {
      domain,
      queue,
      backoff,
      policy,
      statePath: queueStateFile(home, domain, String(config.chainId))
    }
  }

  function persist(rt: DomainRuntime): void {
    if (config.dryRun) return // dry-run reads state as a seed but NEVER writes it.
    saveState(rt.statePath, {
      version: QUEUE_STATE_VERSION,
      queue: rt.queue.dump(),
      backoff: rt.backoff.dump()
    } satisfies QueueState)
  }

  function flushDirty(): void {
    for (const rt of dirty) persist(rt)
    dirty.clear()
  }

  // ---- ingest -------------------------------------------------------------
  // Narrows the untrusted record envelope, enforcing the three per-record guards (chain, version,
  // domain). Throws EngineError — the connection survives; the client warns+skips.
  function envelope(record: unknown): { domain: BotName; id: string; op: string; kind: string } {
    if (!isRecord(record)) throw new EngineError('bad_request', 'record must be an object')
    if (typeof record.v !== 'number') {
      throw new EngineError('bad_request', "record 'v' must be a number")
    }
    if (record.v > WIRE_VERSION) {
      throw new EngineError(
        'unsupported_version',
        `record wire version ${record.v} is newer than ${WIRE_VERSION}`
      )
    }
    if (record.chainId !== config.chainId) {
      throw new EngineError(
        'chain_mismatch',
        `record chain ${String(record.chainId)} != daemon chain ${config.chainId}`
      )
    }
    const domain = record.domain
    if (typeof domain !== 'string' || !REGISTERED.has(domain)) {
      throw new EngineError('bad_request', `unknown domain '${String(domain)}'`)
    }
    if (typeof record.id !== 'string' || record.id === '') {
      throw new EngineError('bad_request', "record 'id' must be a non-empty string")
    }
    const op = typeof record.op === 'string' ? record.op : splitIdPrefix(record.id).op
    return { domain: domain as BotName, id: record.id, op, kind: String(record.kind) }
  }

  async function ingestOutcome(
    record: Record<string, unknown>,
    env: ReturnType<typeof envelope>
  ): Promise<void> {
    const status = record.status
    if (typeof status !== 'string' || !QUEUE_BACKOFF_STATUSES.has(status)) return
    const rt = runtimes.get(env.domain)
    if (!rt) return
    const { head } = await chainState()
    rt.backoff.record(env.id, head)
    dirty.add(rt)
  }

  async function ingestTx(
    record: Record<string, unknown>,
    env: ReturnType<typeof envelope>
  ): Promise<{ outcome?: OutcomeRecord }> {
    const to = record.to
    const data = record.data
    // Untrusted socket input: narrow to a real address / hex blob before it reaches the signer.
    if (typeof to !== 'string' || !isAddress(to) || !isHex(data)) {
      throw new EngineError('bad_request', 'tx record has invalid or missing to/data')
    }
    const rt = runtimes.get(env.domain)
    if (!rt) throw new EngineError('bad_request', `no runtime for domain '${env.domain}'`)

    // Dedupe against the LIVE inflight set (includes settled-cooldown labels).
    if (rt.queue.inflightLabels().has(env.id)) {
      const { head } = await chainState()
      const outcome = queueOutcome({
        id: env.id,
        domain: env.domain,
        op: env.op,
        chainId: config.chainId,
        status: 'deduped_inflight',
        block: Number(head)
      })
      appendOutcome(outcome)
      return { outcome }
    }

    // Structurally sign-what-you-simulate: re-simulate the exact bytes before broadcasting.
    const sim = await simulateLiquidationExec(readClient, {
      executooor: to,
      eoa,
      data
    })
    const { head, baseFee } = await chainState()
    if (sim.status !== 'ok') {
      rt.backoff.record(env.id, head)
      dirty.add(rt)
      const outcome = queueOutcome({
        id: env.id,
        domain: env.domain,
        op: env.op,
        chainId: config.chainId,
        status: 'sim_reverted',
        block: Number(head),
        reason: sim.reason
      })
      appendOutcome(outcome)
      return { outcome }
    }

    const fees = initialFees(baseFee, config.maxFeeWei)

    // Dry-run: full pipeline, then emit `would_submit` — never touch the signer, never persist.
    if (config.dryRun) {
      const outcome = queueOutcome({
        id: env.id,
        domain: env.domain,
        op: env.op,
        chainId: config.chainId,
        status: 'would_submit',
        block: Number(head)
      })
      appendOutcome(outcome)
      return { outcome }
    }

    // Armed. A prior TxSendError this wave rolled the cursor back — refuse until the next sweep clears it.
    if (sendAborted)
      throw new EngineError(
        'retry',
        'send_aborted: a prior submit failed; retry after the next sweep'
      )

    let submitted: Awaited<ReturnType<PendingQueue['submit']>>
    try {
      submitted = await rt.queue.submit({
        request: { to, data },
        label: env.id,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        blockNumber: head
      })
    } catch (error) {
      if (error instanceof TxSendError) {
        sendAborted = true
        logger.error('queued.tx_send_error', { label: env.id, detail: ensureError(error).message })
        throw new EngineError('retry', `submit_failed: ${ensureError(error).message}`)
      }
      throw error
    }
    if (!submitted.submitted) {
      // A hashless transient (nonce-sync failure or a non-TxSendError send throw) the queue already
      // logged. Not an outcome per the wire contract — surface it as a retry so the client re-derives.
      throw new EngineError('retry', 'submit_failed: transient send failure')
    }
    rt.backoff.clear(env.id)
    persist(rt) // persist immediately after a successful submit (a claimed nonce must survive a crash).
    dirty.delete(rt)
    poke()
    const outcome = queueOutcome({
      id: env.id,
      domain: env.domain,
      op: env.op,
      chainId: config.chainId,
      status: 'submitted',
      block: Number(head),
      txHash: submitted.txHash,
      nonce: submitted.nonce
    })
    appendOutcome(outcome)
    return { outcome }
  }

  async function ingest(record: unknown): Promise<{ outcome?: OutcomeRecord }> {
    const env = envelope(record)
    return locked(async () => {
      try {
        if (env.kind === 'outcome') {
          await ingestOutcome(record as Record<string, unknown>, env)
          return {}
        }
        if (env.kind === 'tx') {
          return await ingestTx(record as Record<string, unknown>, env)
        }
        throw new EngineError('bad_request', `unsupported record kind '${env.kind}'`)
      } finally {
        flushDirty()
      }
    })
  }

  // ---- sweeper ------------------------------------------------------------
  let sweepTimer: ReturnType<typeof setTimeout> | null = null
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  function scheduleSweep(ms: number): void {
    if (stopped || config.dryRun) return
    if (sweepTimer) clearTimeout(sweepTimer)
    sweepTimer = setTimeout(() => void runSweep(), ms)
  }
  function scheduleNextSweep(): void {
    scheduleSweep(anyInflight() ? ACTIVE_SWEEP_MS : IDLE_SWEEP_MS)
  }
  // Run the next sweep as soon as the mutex frees — used after an ingest that actually submitted.
  function poke(): void {
    scheduleSweep(0)
  }

  async function runSweep(): Promise<void> {
    // Also short-circuits `tick()` in dry-run (nothing to settle — matches the doc comment).
    if (stopped || config.dryRun) return
    try {
      await locked(async () => {
        let head: bigint
        try {
          ;({ head } = await chainState(true))
        } catch (error) {
          // Head-fetch failure: warn, skip this sweep — never crash the daemon.
          logger.warn('sweep.head_failed', { detail: ensureError(error).message })
          return
        }
        for (const rt of runtimes.values()) {
          await rt.queue.onBlock(head)
          dirty.add(rt)
        }
        sendAborted = false // the wave cleared; submits may resume.
        flushDirty()
      })
    } catch (error) {
      // A persist/onBlock throw must not break the timer chain — log and keep sweeping.
      logger.warn('sweep.failed', { detail: ensureError(error).message })
    } finally {
      scheduleNextSweep()
    }
  }

  // ---- reconciler ---------------------------------------------------------
  function scheduleReconcile(): void {
    if (stopped || config.dryRun) return
    if (reconcileTimer) clearTimeout(reconcileTimer)
    reconcileTimer = setTimeout(() => void runReconcile(), RECONCILE_MS)
  }

  async function runReconcile(): Promise<void> {
    if (stopped) return
    try {
      await locked(async () => {
        if (!signer || totalPending() === 0) return
        // Armed agent mode: re-verify the agent still signs for our EOA. A mismatch means the agent
        // restarted under a different key — fatal misconfig, not a transient.
        if (reverifyAddress) {
          const seen = await tryCatch(reverifyAddress())
          if (!seen.error && !isAddressEqual(seen.data, eoa)) {
            logger.error('reconcile.agent_mismatch', { expected: eoa, seen: seen.data })
            for (const rt of runtimes.values()) persist(rt)
            onFatal?.(2)
            return
          }
        }
        const fetched = await tryCatch(
          Promise.all([
            chainState(true),
            getTransactionCount(sendClient, { address: eoa, blockTag: 'latest' })
          ])
        )
        if (fetched.error) {
          logger.warn('reconcile.head_failed', { detail: ensureError(fetched.error).message })
          return
        }
        const head = fetched.data[0].head
        const onchainNonce = fetched.data[1]
        // A tracked nonce already below the chain's `latest` count is consumed. If our tx for it has
        // no receipt, something else consumed the nonce — evict it so stuck-detection isn't wedged.
        for (const rt of runtimes.values()) {
          for (const { nonce, txHash } of rt.queue.snapshot()) {
            if (nonce >= onchainNonce) continue
            const receipt = await tryCatch(signer.getReceipt(txHash))
            if (receipt.error || receipt.data) continue // still visible (or read failed) → leave it.
            if (rt.queue.drop(nonce, head, 'nonce_consumed')) dirty.add(rt)
          }
        }
        flushDirty()
      })
    } catch (error) {
      // A persist/drop throw must not break the reconcile timer chain — log and keep reconciling.
      logger.warn('reconcile.failed', { detail: ensureError(error).message })
    } finally {
      scheduleReconcile()
    }
  }

  // ---- lifecycle ----------------------------------------------------------
  async function start(): Promise<void> {
    mkdirSync(dirname(outcomesPath), { recursive: true })
    const policies = await loadPolicies()
    for (const domain of DOMAIN_NAMES) {
      const { state, reset } = loadState<QueueState>(
        queueStateFile(home, domain, String(config.chainId)),
        QUEUE_STATE_VERSION
      )
      if (reset && reset !== 'missing')
        logger.warn('state.reset', { domain, chainId: config.chainId, reason: reset })
      runtimes.set(domain, makeRuntime(domain, policies[domain], state))
    }
    // Startup: one reconcile sweep before we accept connections (armed only), so a restart heals a
    // consumed-nonce zombie from the prior process before the first ingest claims a nonce. That call
    // ends by scheduling the next reconcile, so we don't re-arm it here (double-schedule). Disarmed
    // never reconciles (scheduleReconcile early-returns on dryRun).
    if (armed) await runReconcile()
    scheduleNextSweep()
  }

  async function shutdown(): Promise<void> {
    stopped = true
    if (sweepTimer) clearTimeout(sweepTimer)
    if (reconcileTimer) clearTimeout(reconcileTimer)
    // Drain any in-flight mutex section, then persist every runtime one last time.
    await locked(async () => {
      for (const rt of runtimes.values()) persist(rt)
      dirty.clear()
    })
  }

  function status(): EngineStatus {
    return {
      chainId: config.chainId,
      address: armed ? eoa : null,
      armed,
      pending: totalPending(),
      wireVersion: WIRE_VERSION
    }
  }

  return { start, ingest, status, shutdown, tick: runSweep }
}
