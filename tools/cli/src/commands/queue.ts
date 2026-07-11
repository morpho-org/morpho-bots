import type { Logger, OutcomeRecord, TxRecord } from '@repo/bot-kit'
import type { Hex, LocalAccount } from 'viem'

import {
  createBackoff,
  createDeploylessClient,
  createLogger,
  createPendingQueue,
  createSigner,
  initialFees,
  simulateLiquidationExec,
  TxSendError,
  WIRE_VERSION
} from '@repo/bot-kit'
import { createAgentAccount } from '@repo/signer'
import { ensureError } from '@repo/utils'
import { isAddressEqual } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { getBlockNumber } from 'viem/actions'

import type { QueueAdapter } from '../domains'
import type { BotName } from '../home'
import type { QueueState } from '../queue-state'

import { ConfigError, mergedEnv, warnOnLooseSecrets } from '../config'
import { DOMAINS } from '../domains'
import { botsHome, lockFile, queueStateFile } from '../home'
import { acquireLock, releaseLock } from '../lock'
import { QUEUE_STATE_VERSION } from '../queue-state'
import { loadState, saveState } from '../state'
import { collectQueueRecords, QUEUE_BACKOFF_STATUSES, splitIdPrefix } from '../wire-input'
import { drainStdin, emitLine, fail } from './shared'

type Env = Record<string, string | undefined>

// Builds one full queue `outcome` envelope for stdout. `op` is the source op the record belongs to —
// the submit path takes it from the incoming `tx.op` envelope, the onSettled path derives it from the
// persisted label's `<domain>:<op>:` prefix (the only survivor there). block/txHash/nonce/reason ride
// only when present.
function queueOutcome(args: {
  id: string
  domain: BotName
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
 * The locked queue pass. Reads tx/outcome records from stdin (TTY → maintenance-only), applies
 * outcome-driven backoff, then for each tx: dedupes against live inflight labels, RE-SIMULATES the
 * exact bytes it will sign, and submits — emitting `deduped_inflight`/`sim_reverted`/`submitted`
 * outcomes. Runs `onBlock` (emitting terminal `confirmed`/`reverted`/`dropped` outcomes via
 * `onSettled`), then persists. Returns 2 on wire-version skew; otherwise 0 (per-tx failures are
 * records/logs, never exit codes). A `TxSendError` mid-batch skips remaining submits but still runs
 * onBlock + persist.
 */
async function runQueuePass(
  domain: BotName,
  chainId: string,
  config: Awaited<ReturnType<QueueAdapter['loadConfig']>>,
  policy: QueueAdapter['policy'],
  home: string,
  logger: Logger
): Promise<number> {
  const queuePath = queueStateFile(home, domain, chainId)
  const { state, reset } = loadState<QueueState>(queuePath, QUEUE_STATE_VERSION)
  if (reset && reset !== 'missing')
    logger.warn('state.reset', { bot: domain, chainId, reason: reset })

  // Read stdin to EOF. A TTY (no upstream pipe) → maintenance-only pass (the queue is the heartbeat).
  let txs: TxRecord[] = []
  let outcomes: OutcomeRecord[] = []
  if (!process.stdin.isTTY) {
    const collected = collectQueueRecords(await Bun.stdin.text(), logger)
    if (collected.versionSkew) {
      fail('wire.version_skew', new Error('input record has a newer wire version than this build'))
      return 2
    }
    txs = collected.txs
    outcomes = collected.outcomes
  }

  // Resolve the signing account BEFORE the zero-work fast path so a broken agent surfaces every
  // pass. Agent mode: the handshake fetches the agent's address — a dead/missing socket throws a
  // plain error (transient → exit 1, the loop retries), while an address that disagrees with
  // LIQUIDATOR_ADDRESS is operator misconfig → ConfigError (exit 2). Local mode: build the account
  // from the in-process key. Either way the queue never holds the key beyond `privateKeyToAccount`.
  let account: LocalAccount
  if (config.signer.kind === 'agent') {
    account = await createAgentAccount({ socketPath: config.signer.socketPath })
    const expected = config.signer.expectedAddress
    if (expected && !isAddressEqual(account.address, expected)) {
      throw new ConfigError(
        `signing agent address (${account.address}) does not match LIQUIDATOR_ADDRESS (${expected}) — act and queue would target different wallets`
      )
    }
  } else {
    account = privateKeyToAccount(config.signer.privateKey)
  }
  const signer = createSigner({
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    rpcUrlFallback: config.rpcUrlFallback,
    ...(config.sendRpcUrl ? { sendRpcUrl: config.sendRpcUrl } : {}),
    account
  })
  const eoa = signer.account.address
  // Read client for the re-sim `eth_call` and the head fetch (reads go to `rpcUrl`, not sendRpcUrl).
  const client = createDeploylessClient({
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    rpcUrlFallback: config.rpcUrlFallback
  })
  const backoff = createBackoff({
    baseBlocks: config.backoffBaseBlocks,
    maxBlocks: config.backoffMaxBlocks,
    ...(state ? { initialState: state.backoff } : {})
  })

  const queue = createPendingQueue({
    send: signer.send,
    getReceipt: signer.getReceipt,
    getBaseFee: signer.getBaseFee,
    syncNonce: signer.syncNonce,
    maxFeeWei: config.maxFeeWei,
    logger,
    settledCooldownBlocks: policy.settledCooldownBlocks,
    ...(policy.revertReason ? { revertReason: policy.revertReason } : {}),
    ...(state ? { initialState: state.queue } : {}),
    // Terminal fates during onBlock become first-class outcome lines on stdout.
    onSettled: info =>
      emitLine(
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

  // Zero-work fast path: with nothing on stdin and an empty pending set, there is nothing to
  // reconcile — skip the head fetch (and thus every RPC call) and just persist the (empty) state.
  const hasWork = txs.length > 0 || outcomes.length > 0 || queue.size > 0
  const head = hasWork ? await getBlockNumber(client) : null

  if (head !== null) {
    // Outcome-driven backoff: the queue is the single writer (act only filters against a read copy).
    for (const record of outcomes) {
      if (QUEUE_BACKOFF_STATUSES.has(record.status)) backoff.record(record.id, head)
    }

    // One cached base fee for the whole batch (fetched only when there is something to submit).
    let baseFee: bigint | null = txs.length > 0 ? await signer.getBaseFee() : null

    for (const tx of txs) {
      // Dedupe against the LIVE inflight set (recomputed so txs submitted earlier this batch count).
      if (queue.inflightLabels().has(tx.id)) {
        emitLine(
          queueOutcome({
            id: tx.id,
            domain,
            op: tx.op,
            chainId: config.chainId,
            status: 'deduped_inflight',
            block: Number(head)
          })
        )
        continue
      }

      // Structurally sign-what-you-simulate: re-simulate the exact bytes before broadcasting.
      const sim = await simulateLiquidationExec(client, {
        executooor: tx.to,
        eoa,
        data: tx.data
      })
      if (sim.status !== 'ok') {
        backoff.record(tx.id, head)
        emitLine(
          queueOutcome({
            id: tx.id,
            domain,
            op: tx.op,
            chainId: config.chainId,
            status: 'sim_reverted',
            block: Number(head),
            reason: sim.reason
          })
        )
        continue
      }

      baseFee ??= await signer.getBaseFee()
      const fees = initialFees(baseFee, config.maxFeeWei)
      let submitted: Awaited<ReturnType<typeof queue.submit>>
      try {
        submitted = await queue.submit({
          request: { to: tx.to, data: tx.data },
          label: tx.id,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          blockNumber: head
        })
      } catch (error) {
        // A claimed-nonce-but-hashless send: the signer rolled its cursor back. Skip the remaining
        // submits but still run onBlock + persist so pending reconciliation and state survive.
        if (error instanceof TxSendError) {
          logger.error('queue.tx_send_error', { label: tx.id, detail: ensureError(error).message })
          break
        }
        throw error
      }
      if (submitted.submitted) {
        backoff.clear(tx.id)
        emitLine(
          queueOutcome({
            id: tx.id,
            domain,
            op: tx.op,
            chainId: config.chainId,
            status: 'submitted',
            block: Number(head),
            txHash: submitted.txHash,
            nonce: submitted.nonce
          })
        )
      }
      // A hashless {submitted:false} is a transient failure the queue already logged; per the wire
      // contract that is a log, not an outcome, and backoff is left as-is (not cleared).
    }

    // Confirmations / stuck-detection / fee-bumps for the whole pending set (incl. prior ticks).
    await queue.onBlock(head)
  }

  saveState(queuePath, {
    version: QUEUE_STATE_VERSION,
    queue: queue.dump(),
    backoff: backoff.dump()
  } satisfies QueueState)
  return 0
}

/**
 * `<domain> queue`: the stateful sink and single-writer heartbeat. Acquires the per-(bot,chain) lock
 * (held → drain stdin, exit 0; a dead pid is stolen), then runs one maintenance pass under the lock.
 * Key custody splits on the signer backend: in local mode (no `SIGNER_SOCKET`) the private key lives
 * only here; in agent mode the `morpho-bots signer` daemon is the sole key holder and this process
 * stays keyless. Exit codes: 0 when the maintenance pass ran (even if some submits failed
 * transiently), 2 on config/usage, wire-version skew, or an agent whose address disagrees with
 * LIQUIDATOR_ADDRESS, 1 only when the pass itself could not run (e.g. the head fetch failed, or the
 * signer socket is dead — transient, the loop retries).
 */
export async function runQueueCommand(
  domain: BotName,
  opts: { chain?: string | undefined }
): Promise<number> {
  const home = botsHome()
  const adapter = await DOMAINS[domain].queue()

  let env: Env
  let chainId: string
  let config: Awaited<ReturnType<QueueAdapter['loadConfig']>>
  try {
    warnOnLooseSecrets(home)
    ;({ env, chainId } = mergedEnv({ home, bot: domain, chain: opts.chain }))
    config = adapter.loadConfig(env)
  } catch (error) {
    fail('startup.error', error)
    return 2
  }

  const logger = createLogger(config.logLevel)
  // In agent mode a still-set LIQUIDATOR_PRIVATE_KEY is dead weight riding this process's env —
  // exactly what the operator opted out of by setting SIGNER_SOCKET. Warn, don't fail: the value is
  // ignored either way.
  if (config.signer.kind === 'agent' && env.LIQUIDATOR_PRIVATE_KEY) {
    logger.warn('queue.key_ignored', {
      bot: domain,
      chainId,
      detail:
        'SIGNER_SOCKET is set, so LIQUIDATOR_PRIVATE_KEY is ignored — remove it from the queue env'
    })
  }
  const lockPath = lockFile(home, domain, chainId)
  const lock = acquireLock(lockPath)
  if (!lock.acquired) {
    logger.info('queue.skipped', {
      bot: domain,
      chainId,
      reason: 'lock_held',
      holderPid: lock.holderPid
    })
    // Another queue holds the lock; drain our stdin so upstream `act` finishes cleanly, then skip.
    await drainStdin()
    return 0
  }
  if (lock.stolen) logger.warn('lock.stolen', { bot: domain, chainId, lockPath })

  try {
    return await runQueuePass(domain, chainId, config, adapter.policy, home, logger)
  } catch (error) {
    // A ConfigError is operator misconfig the loop can't retry past (an agent whose address
    // disagrees with LIQUIDATOR_ADDRESS) → exit 2, same contract as a bad startup config. Every
    // other throw (e.g. a transient RPC failure fetching the head, or a dead signer socket) → retry
    // next interval. Per-tx failures never reach here; they are outcome records / logs.
    if (error instanceof ConfigError) {
      fail('startup.error', error)
      return 2
    }
    logger.error('queue.error', { bot: domain, chainId, detail: ensureError(error).message })
    return 1
  } finally {
    releaseLock(lockPath)
  }
}
