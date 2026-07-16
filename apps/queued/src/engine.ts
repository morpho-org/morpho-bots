import type { Logger } from '@repo/evm-kit'
import type { RemoteSigner } from '@repo/signer-client'
import type { Address, Hex, PublicClient } from 'viem'

import { createDeploylessClient, TxSendError } from '@repo/evm-kit'
import { loadState, saveState } from '@repo/home'
import { ensureError, tryCatch } from '@repo/utils'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { BaseError, createPublicClient, formatEther, http } from 'viem'
import { call, getBalance, getBlock, getTransactionCount } from 'viem/actions'

import type { QueuedConfig } from './config'
import type { PendingQueue } from './pending-queue'
import type { QueueAck, QueuedTransaction } from './protocol'
import type { QueueState } from './state'

import { initialFees } from './fee-policy'
import { createPendingQueue } from './pending-queue'
import { createSender } from './sender'
import { isSignerError } from './signer-error'
import { QUEUE_STATE_VERSION } from './state'

const ACTIVE_SWEEP_MS = 2_000
const IDLE_SWEEP_MS = 15_000
const CACHE_TTL_MS = 2_000
const RECONCILE_EVERY_SWEEPS = 3
// Minimum spacing between signer gas-balance reads. Independent of sweep cadence (which chases
// inflight work) so the balance metric ships at a steady rate whether the queue is busy or idle.
const BALANCE_CHECK_MS = 60_000

export class EngineError extends Error {
  constructor(
    readonly code: 'retry' | 'fatal' | 'internal',
    message: string
  ) {
    super(message)
    this.name = 'EngineError'
  }
}

export type Engine = {
  start(): Promise<void>
  ingest(transaction: QueuedTransaction): Promise<QueueAck>
  tick(): Promise<void>
  shutdown(): Promise<void>
}

type EngineDeps = {
  config: QueuedConfig
  remoteSigner: RemoteSigner | null
  logger: Logger
  home: string
  onFatal?: ((code: number) => void) | undefined
}

type JournalEvent = {
  kind: 'queue'
  chainId: number
  id: string
  status: string
  at: string
  block?: number
  txHash?: Hex
  nonce?: number
  reason?: string
}

export function createEngine({ config, remoteSigner, logger, home, onFatal }: EngineDeps): Engine {
  const armed = remoteSigner !== null
  const eoa: Address = remoteSigner?.address ?? config.liquidatorAddress
  const sendClient: PublicClient = createPublicClient({
    chain: config.chain,
    transport: http(config.rpcUrl)
  })
  const readClient = createDeploylessClient({
    chain: config.chain,
    rpcUrl: config.rpcUrl
  })
  const sender = remoteSigner
    ? createSender({
        chain: config.chain,
        rpcUrl: config.rpcUrl,
        signer: remoteSigner
      })
    : null
  const statePath = join(home, 'queued', `state-${config.chainId}.json`)
  const outcomesPath = join(home, 'queued', `outcomes-${config.chainId}.jsonl`)
  let queue!: PendingQueue
  let dirty = false
  let sendAborted = false
  let sweepCount = 0
  let lastBalanceCheckAt = 0
  let cache: { head: bigint; baseFee: bigint; at: number } | null = null
  let mutex: Promise<unknown> = Promise.resolve()
  let sweepTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  function locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = mutex.then(fn, fn)
    mutex = run.catch(() => undefined)
    return run
  }

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

  function journal(event: Omit<JournalEvent, 'kind' | 'chainId' | 'at'>): JournalEvent {
    const full = {
      kind: 'queue' as const,
      chainId: config.chainId,
      at: new Date().toISOString(),
      ...event
    }
    appendFileSync(outcomesPath, `${JSON.stringify(full)}\n`)
    return full
  }

  function ack(
    transaction: QueuedTransaction,
    status: Extract<QueueAck, { ok: true }>['status'],
    fields: { block?: number; txHash?: Hex; nonce?: number; reason?: string } = {}
  ): QueueAck {
    journal({ id: transaction.id, status, ...fields })
    return { ok: true, id: transaction.id, status, ...fields }
  }

  function persist(): void {
    if (config.dryRun) return
    saveState(statePath, {
      version: QUEUE_STATE_VERSION,
      queue: queue.dump()
    } satisfies QueueState)
  }

  function flushDirty(): void {
    if (dirty) persist()
    dirty = false
  }

  const unavailable = (): Promise<never> => Promise.reject(new Error('queue is disarmed'))
  const syncNonce = async (): Promise<void> => {
    if (sender && queue.size === 0) await sender.syncNonce()
  }

  function restore(state: QueueState | null): void {
    queue = createPendingQueue({
      send: sender?.send ?? unavailable,
      getReceipt: sender?.getReceipt ?? unavailable,
      getBaseFee: sender?.getBaseFee ?? unavailable,
      syncNonce,
      maxFeeWei: config.maxFeeWei,
      stuckBlocks: config.stuckBlocks,
      logger,
      ...(state ? { initialState: state.queue } : {}),
      onSettled: settlement =>
        journal({
          id: settlement.label,
          status: settlement.status,
          txHash: settlement.txHash,
          nonce: settlement.nonce,
          ...(settlement.reason ? { reason: settlement.reason } : {})
        })
    })
  }

  async function simulate(
    transaction: QueuedTransaction
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { error } = await tryCatch(
      call(readClient, {
        account: eoa,
        to: transaction.to,
        data: transaction.data,
        value: BigInt(transaction.value)
      })
    )
    if (!error) return { ok: true }
    return { ok: false, reason: error instanceof BaseError ? error.shortMessage : error.message }
  }

  async function ingestUnlocked(transaction: QueuedTransaction): Promise<QueueAck> {
    if (queue.inflightLabels().has(transaction.id)) {
      return ack(transaction, 'deduped', { block: Number((await chainState()).head) })
    }
    const current = await chainState()
    const simulation = await simulate(transaction)
    if (!simulation.ok) {
      return ack(transaction, 'sim_reverted', {
        block: Number(current.head),
        reason: simulation.reason
      })
    }
    if (config.dryRun) return ack(transaction, 'would_submit', { block: Number(current.head) })
    if (sendAborted) throw new EngineError('retry', 'send aborted until the next settlement sweep')
    const fees = initialFees(current.baseFee, config.maxFeeWei)
    let submitted: Awaited<ReturnType<PendingQueue['submit']>>
    try {
      submitted = await queue.submit({
        request: { to: transaction.to, data: transaction.data, value: BigInt(transaction.value) },
        label: transaction.id,
        ...fees,
        blockNumber: current.head
      })
    } catch (error) {
      if (isSignerError(error)) {
        throw new EngineError('fatal', `signer rejected transaction: ${ensureError(error).message}`)
      }
      if (error instanceof TxSendError) sendAborted = true
      throw new EngineError('retry', `submit_failed: ${ensureError(error).message}`)
    }
    if (!submitted.submitted)
      throw new EngineError('retry', 'submit_failed: transient send failure')
    persist()
    dirty = false
    scheduleSweep(0)
    return ack(transaction, 'submitted', {
      block: Number(current.head),
      txHash: submitted.txHash,
      nonce: submitted.nonce
    })
  }

  async function ingest(transaction: QueuedTransaction): Promise<QueueAck> {
    return locked(async () => {
      try {
        return await ingestUnlocked(transaction)
      } finally {
        flushDirty()
      }
    })
  }

  async function reconcile(): Promise<void> {
    if (!sender || queue.size === 0) return
    const count = await tryCatch(
      getTransactionCount(sendClient, { address: eoa, blockTag: 'latest' })
    )
    if (count.error) {
      logger.warn('reconcile.failed', { detail: ensureError(count.error).message })
      return
    }
    for (const { nonce, txHash } of queue.snapshot()) {
      if (nonce >= count.data) continue
      const receipt = await tryCatch(sender.getReceipt(txHash))
      if (!receipt.error && !receipt.data && queue.drop(nonce, 'nonce_consumed')) dirty = true
    }
  }

  // Reads the signer EOA's native balance and emits it as the `signer.balance` metric line.
  // `balanceEth` is a plain number (a queryable metric field); `balanceWei` is the lossless decimal
  // string. Thresholding/alerting is BetterStack's job, so this is always `info` — the daemon just
  // ships the value. A read failure logs `signer.balance_failed` and never disturbs settlement.
  async function checkBalance(now: number): Promise<void> {
    lastBalanceCheckAt = now
    const balance = await tryCatch(getBalance(sendClient, { address: eoa }))
    if (balance.error) {
      logger.warn('signer.balance_failed', {
        address: eoa,
        detail: ensureError(balance.error).message
      })
      return
    }
    logger.info('signer.balance', {
      address: eoa,
      balanceWei: balance.data,
      balanceEth: Number(formatEther(balance.data))
    })
  }

  // Gates checkBalance to once per BALANCE_CHECK_MS. Armed only — a dry-run daemon has no signer to
  // fund and never reaches the sweep loop. Swallows its own errors so it never breaks a sweep.
  async function maybeCheckBalance(): Promise<void> {
    if (!armed) return
    const now = Date.now()
    if (now - lastBalanceCheckAt < BALANCE_CHECK_MS) return
    await checkBalance(now)
  }

  function scheduleSweep(ms: number): void {
    if (stopped || config.dryRun) return
    if (sweepTimer) clearTimeout(sweepTimer)
    sweepTimer = setTimeout(() => void runSweep(), ms)
  }

  async function runSweep(): Promise<void> {
    if (stopped || config.dryRun) return
    try {
      await maybeCheckBalance()
      await locked(async () => {
        const state = await tryCatch(chainState(true))
        if (state.error) {
          logger.warn('sweep.head_failed', { detail: ensureError(state.error).message })
          return
        }
        await queue.onBlock(state.data.head)
        sweepCount += 1
        if (sweepCount % RECONCILE_EVERY_SWEEPS === 0) await reconcile()
        dirty = true
        sendAborted = false
        flushDirty()
      })
    } catch (error) {
      if (isSignerError(error)) {
        logger.error('sweep.signer_fatal', { detail: ensureError(error).message })
        onFatal?.(2)
        return
      }
      logger.warn('sweep.failed', { detail: ensureError(error).message })
    } finally {
      scheduleSweep(queue.inflightLabels().size > 0 ? ACTIVE_SWEEP_MS : IDLE_SWEEP_MS)
    }
  }

  async function start(): Promise<void> {
    mkdirSync(dirname(outcomesPath), { recursive: true })
    const { state, reset } = loadState<QueueState>(statePath, QUEUE_STATE_VERSION)
    if (reset && reset !== 'missing') logger.warn('state.reset', { reason: reset })
    restore(state)
    if (armed) await locked(async () => reconcile())
    await maybeCheckBalance()
    scheduleSweep(queue.inflightLabels().size > 0 ? ACTIVE_SWEEP_MS : IDLE_SWEEP_MS)
  }

  async function shutdown(): Promise<void> {
    stopped = true
    if (sweepTimer) clearTimeout(sweepTimer)
    await locked(async () => persist())
  }

  return { start, ingest, tick: runSweep, shutdown }
}
