import type { Address, Hex } from 'viem'

import { encodeErrorResult, ExecutionRevertedError } from 'viem'
import { describe, expect, it } from 'vitest'

import type { Logger, LogLevel } from '../../src/logger'
import type {
  GetBaseFee,
  GetConsumedNonce,
  GetReceipt,
  PendingQueue,
  SendTx,
  SyncNonce,
  TxRequest
} from '../../src/queue/pending-queue'

import { createPendingQueue } from '../../src/queue/pending-queue'
import { TxSendError } from '../../src/tx-send.error'

// Gas the signer reports back for a stub send; the spend ceiling is priced against it.
const STUB_GAS = 1_000_000n

// The cooldown the opted-in cases run with (mirrors midnight's SETTLED_COOLDOWN_BLOCKS tuning).
const SETTLED_COOLDOWN_BLOCKS = 20n

const REQUEST: TxRequest = {
  to: '0x0000000000000000000000000000000000000001' as Address,
  data: '0x' as Hex
}

function hashOf(n: number): Hex {
  return `0x${n.toString(16).padStart(64, '0')}`
}

type SendArg = TxRequest & { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; nonce?: number }

/** A logger that records every call so tests can assert on emitted events and their fields. */
function captureLogger() {
  const events: { level: LogLevel; event: string; fields?: Record<string, unknown> }[] = []
  const make = (level: LogLevel) => (event: string, fields?: Record<string, unknown>) => {
    events.push({ level, event, fields })
  }
  const logger: Logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error')
  }
  return { logger, events }
}

function setup(
  opts: {
    getReceipt?: GetReceipt
    baseFee?: bigint
    maxFeeWei?: bigint
    maxSpendWei?: bigint
    send?: SendTx
    /** `null` builds the queue WITHOUT a syncNonce hook (both bots wire one; kept for coverage). */
    syncNonce?: SyncNonce | null
    /** `0n` (or passing nothing via `withCooldown: false`) disables the cooldown. */
    withCooldown?: boolean
    getConsumedNonce?: GetConsumedNonce
    reconcileEveryBlocks?: number
    logger?: Logger
  } = {}
) {
  const sends: SendArg[] = []
  let counter = 0
  const defaultSend: SendTx = async request => {
    sends.push(request)
    counter += 1
    return { nonce: request.nonce ?? 7, txHash: hashOf(counter), gas: STUB_GAS }
  }
  let syncNonceCalls = 0
  const defaultSyncNonce: SyncNonce = async () => {
    syncNonceCalls += 1
  }
  const getBaseFee: GetBaseFee = async () => opts.baseFee ?? 100n
  const capture = captureLogger()
  const queue = createPendingQueue({
    send: opts.send ?? defaultSend,
    getReceipt: opts.getReceipt ?? (async () => null),
    getBaseFee,
    ...(opts.syncNonce === null ? {} : { syncNonce: opts.syncNonce ?? defaultSyncNonce }),
    ...(opts.withCooldown === false ? {} : { settledCooldownBlocks: SETTLED_COOLDOWN_BLOCKS }),
    ...(opts.getConsumedNonce ? { getConsumedNonce: opts.getConsumedNonce } : {}),
    ...(opts.reconcileEveryBlocks ? { reconcileEveryBlocks: opts.reconcileEveryBlocks } : {}),
    maxFeeWei: opts.maxFeeWei ?? 10_000_000_000_000n,
    ...(opts.maxSpendWei === undefined ? {} : { maxSpendWei: opts.maxSpendWei }),
    logger: opts.logger ?? capture.logger
  })
  return {
    queue,
    sends,
    events: capture.events,
    get syncNonceCalls() {
      return syncNonceCalls
    }
  }
}

function submitOne(queue: PendingQueue) {
  return queue.submit({
    request: REQUEST,
    label: 'market:borrower',
    maxFeePerGas: 1000n,
    maxPriorityFeePerGas: 1000n
  })
}

/**
 * Submits, then lets one `onBlock` sight the entry so its stuck-age baseline is stamped at `at`.
 * The queue no longer takes a caller block, so a test that wants an entry aged from a known height
 * has to give it that sighting pass first.
 */
async function submitSighted(queue: PendingQueue, at = 0n) {
  const outcome = await submitOne(queue)
  await queue.onBlock(at)
  return outcome
}

describe('createPendingQueue', () => {
  it('records a submitted tx with the signer-assigned nonce', async () => {
    const { queue, sends } = setup()
    await submitOne(queue)
    expect(queue.size).toBe(1)
    expect(sends[0]?.nonce).toBeUndefined() // first send leaves nonce assignment to the signer
    expect(queue.snapshot()[0]).toEqual({ nonce: 7, txHash: hashOf(1), attempt: 0 })
  })

  it('removes a tx once its receipt confirms', async () => {
    const { queue } = setup({ getReceipt: async () => ({ status: 'success', blockNumber: 10n }) })
    await submitOne(queue)
    await queue.onBlock(1n)
    expect(queue.size).toBe(0)
  })

  it('leaves a tx pending until it is stuck past stuckBlocks', async () => {
    const { queue, sends } = setup()
    await submitSighted(queue, 0n)
    await queue.onBlock(4n) // age 4, not yet > 4
    expect(queue.size).toBe(1)
    expect(sends).toHaveLength(1) // no replacement
  })

  it('bumps and replaces a stuck tx at the same nonce', async () => {
    const { queue, sends } = setup({ baseFee: 100n })
    await submitSighted(queue, 0n)
    await queue.onBlock(5n) // age 5 > 4 → bump
    expect(sends).toHaveLength(2)
    expect(sends[1]?.nonce).toBe(7) // replacement pins the original nonce
    expect(sends[1]?.maxPriorityFeePerGas).toBe(1125n) // +12.5%
    expect(sends[1]?.maxFeePerGas).toBe(1325n) // max(1125, 2*100 + 1125)
    expect(queue.snapshot()[0]).toEqual({ nonce: 7, txHash: hashOf(2), attempt: 1 })
  })

  // The spend budget is what a tx may cost, so it has to be divided by that tx's own gas before it
  // can be compared against a per-gas fee. Applying it here rather than at the signer is what makes
  // an unaffordable bump a clean one-shot `fee_ceiling` drop.
  it('stops the bump ladder at the spend budget, not just the fee ceiling', async () => {
    // A budget of 1400 wei/gas x STUB_GAS sits far under the 1e9 fee ceiling, so the budget is what
    // binds. From 1000/1000 at a basefee of 100 the ladder reaches 1325 (affordable), then 1490.
    const { queue, events, sends } = setup({
      baseFee: 100n,
      maxFeeWei: 1_000_000_000n,
      maxSpendWei: 1_400n * STUB_GAS
    })
    await submitSighted(queue, 0n)

    await queue.onBlock(5n)
    expect(sends).toHaveLength(2) // 1325 wei/gas x 1e6 gas = 1.325e9 <= budget
    expect(sends[1]?.maxFeePerGas).toBe(1325n)

    // A replacement is re-sighted like a first send, so each further ladder step needs its own
    // sighting block before the block that finds it stuck.
    await queue.onBlock(10n) // sights the replacement
    await queue.onBlock(15n)
    expect(sends).toHaveLength(2) // 1490 breaches the budget, so nothing is broadcast
    expect(queue.size).toBe(0)
    expect(events.some(e => e.event === 'tx.dropped' && e.fields?.reason === 'fee_ceiling')).toBe(
      true
    )
  })

  // Guards the pairing the queue and the signing policy must agree on: with a budget at or above the
  // product of the two ceilings, the ladder is governed by `maxFeeWei` exactly as before.
  it('leaves the ladder to the fee ceiling when the budget cannot bind', async () => {
    const { queue, sends } = setup({
      baseFee: 100n,
      maxFeeWei: 1_000_000_000n,
      maxSpendWei: 1_000_000_000n * STUB_GAS
    })
    await submitSighted(queue, 0n)
    await queue.onBlock(5n)

    expect(sends).toHaveLength(2)
    expect(sends[1]?.maxFeePerGas).toBe(1325n) // identical to the plain bump case
  })

  it('drops a tx after maxBumpAttempts bumps', async () => {
    const { queue } = setup()
    await submitSighted(queue, 0n)
    await queue.onBlock(5n) // attempt 1
    await queue.onBlock(10n) // sights the replacement
    await queue.onBlock(15n) // attempt 2
    await queue.onBlock(20n) // sights the replacement
    await queue.onBlock(25n) // attempt 3
    expect(queue.size).toBe(1)
    await queue.onBlock(30n) // sights the replacement
    await queue.onBlock(35n) // attempt already 3 → drop
    expect(queue.size).toBe(0)
  })

  it('drops a stuck tx when the bump would breach the fee ceiling', async () => {
    const { queue } = setup({ maxFeeWei: 1000n })
    await submitSighted(queue, 0n)
    await queue.onBlock(5n)
    expect(queue.size).toBe(0)
  })

  it('does not track a tx whose first send fails, and logs tx.submit_failed', async () => {
    const { logger, events } = captureLogger()
    const send: SendTx = async () => {
      throw new Error('rpc down')
    }
    const { queue } = setup({ send, logger })
    await submitOne(queue) // must not throw
    expect(queue.size).toBe(0)
    expect(events.find(e => e.event === 'tx.submit_failed')?.level).toBe('warn')
  })

  it('spreads the caller correlation onto tx.submit_failed, beside the shared id', async () => {
    // A liquidator can submit several alternatives of ONE position under one label, so the label
    // alone cannot tell their failures apart in a structured query.
    const { logger, events } = captureLogger()
    const send: SendTx = async () => {
      throw new Error('rpc down')
    }
    const { queue } = setup({ send, logger })
    await queue.submit({
      request: REQUEST,
      label: 'market:borrower',
      correlation: { collateralIndex: 2, postMaturityMode: true },
      maxFeePerGas: 1000n,
      maxPriorityFeePerGas: 1000n
    })
    expect(events.find(e => e.event === 'tx.submit_failed')?.fields).toMatchObject({
      id: 'market:borrower',
      collateralIndex: 2,
      postMaturityMode: true
    })
  })

  it('rethrows a first-send failure after a nonce was claimed but no hash was returned', async () => {
    const { logger, events } = captureLogger()
    const send: SendTx = async () => {
      throw new TxSendError(new Error('rpc timeout after broadcast'), 7)
    }
    const { queue } = setup({ send, logger })
    await expect(submitOne(queue)).rejects.toThrow(/rpc timeout after broadcast/)
    expect(queue.size).toBe(0)
    expect(events.find(e => e.event === 'tx.submit_failed')?.fields?.nonce).toBe(7)
  })

  it('drops a stuck tx when its replacement reverts on-chain (no longer liquidatable)', async () => {
    const { logger, events } = captureLogger()
    let calls = 0
    const send: SendTx = async request => {
      calls += 1
      if (calls === 1) return { nonce: request.nonce ?? 7, txHash: hashOf(1), gas: STUB_GAS }
      throw new ExecutionRevertedError({}) // the re-broadcast reverts
    }
    const { queue } = setup({ send, logger })
    await submitSighted(queue, 0n)
    await queue.onBlock(5n) // stuck → replace → reverts → drop
    expect(queue.size).toBe(0)
    expect(events.find(e => e.event === 'tx.dropped')?.fields?.reason).toBe('reverts_on_replace')
  })

  it('retries a stuck tx on transient send failures, then drops it at maxBumpAttempts', async () => {
    const { logger, events } = captureLogger()
    let calls = 0
    const send: SendTx = async request => {
      calls += 1
      if (calls === 1) return { nonce: request.nonce ?? 7, txHash: hashOf(1), gas: STUB_GAS }
      throw new Error('connection reset') // every replacement is a transient failure
    }
    const { queue } = setup({ send, logger })
    await submitSighted(queue, 0n)
    await queue.onBlock(5n) // attempt 1
    await queue.onBlock(6n) // attempt 2
    await queue.onBlock(7n) // attempt 3
    expect(queue.size).toBe(1)
    await queue.onBlock(8n) // attempt already 3 → drop
    expect(queue.size).toBe(0)
    expect(events.filter(e => e.event === 'tx.replace_failed')).toHaveLength(3)
    expect(events.find(e => e.event === 'tx.dropped')?.fields?.reason).toBe('max_bump_attempts')
  })

  it('isolates a per-entry getReceipt failure so the rest of the queue still sweeps', async () => {
    const { logger, events } = captureLogger()
    let n = 0
    const send: SendTx = async request => {
      n += 1
      return { nonce: request.nonce ?? n, txHash: hashOf(n), gas: STUB_GAS }
    }
    const getReceipt: GetReceipt = async txHash => {
      if (txHash === hashOf(1)) throw new Error('rpc hiccup')
      return { status: 'success', blockNumber: 9n }
    }
    const { queue } = setup({ send, getReceipt, logger })
    await queue.submit({
      request: REQUEST,
      label: 'a',
      maxFeePerGas: 1000n,
      maxPriorityFeePerGas: 1000n
    })
    await queue.submit({
      request: REQUEST,
      label: 'b',
      maxFeePerGas: 1000n,
      maxPriorityFeePerGas: 1000n
    })
    expect(queue.size).toBe(2)
    await queue.onBlock(1n) // entry #1 getReceipt throws (caught), entry #2 confirms → evicted
    expect(queue.size).toBe(1) // the throwing entry survives; the other was still swept
    expect(events.some(e => e.event === 'tx.onblock_error')).toBe(true)
  })

  it('re-syncs the nonce before a first send when the queue is empty', async () => {
    const ctx = setup()
    await submitOne(ctx.queue)
    expect(ctx.syncNonceCalls).toBe(1) // empty queue → reconcile cursor with chain first
  })

  it('does not re-sync the nonce while a tx is already in flight', async () => {
    let n = 6
    const send: SendTx = async request => {
      n += 1
      return { nonce: request.nonce ?? n, txHash: hashOf(n), gas: STUB_GAS } // distinct nonces → both tracked
    }
    const ctx = setup({ send })
    await ctx.queue.submit({
      request: REQUEST,
      label: 'a',
      maxFeePerGas: 1000n,
      maxPriorityFeePerGas: 1000n
    })
    await ctx.queue.submit({
      request: REQUEST,
      label: 'b',
      maxFeePerGas: 1000n,
      maxPriorityFeePerGas: 1000n
    })
    // First submit synced (queue was empty); the second must NOT — the cursor is legitimately ahead
    // by the in-flight tx, and re-reading chain would hand out a colliding nonce.
    expect(ctx.syncNonceCalls).toBe(1)
    expect(ctx.queue.size).toBe(2)
  })

  it('re-syncs again once the queue has drained', async () => {
    const ctx = setup({ getReceipt: async () => ({ status: 'success', blockNumber: 1n }) })
    await submitOne(ctx.queue) // sync #1
    await ctx.queue.onBlock(1n) // tx confirms → queue empties
    expect(ctx.queue.size).toBe(0)
    await submitOne(ctx.queue) // empty again → sync #2
    expect(ctx.syncNonceCalls).toBe(2)
  })

  it('skips the send and logs nonce.sync_failed when the nonce re-sync throws', async () => {
    const { logger, events } = captureLogger()
    const ctx = setup({
      syncNonce: async () => {
        throw new Error('rpc down')
      },
      logger
    })
    await submitOne(ctx.queue) // must not throw
    expect(ctx.queue.size).toBe(0) // nothing broadcast on a stale cursor
    expect(ctx.sends).toHaveLength(0)
    expect(events.find(e => e.event === 'nonce.sync_failed')?.level).toBe('warn')
  })

  it('never syncs (and still submits) when no syncNonce hook is provided', async () => {
    const ctx = setup({ syncNonce: null })
    await submitOne(ctx.queue)
    expect(ctx.queue.size).toBe(1)
    expect(ctx.syncNonceCalls).toBe(0) // the hook was omitted, so the sync block is skipped entirely
  })

  it('exposes the labels of currently-pending txs via inflightLabels', async () => {
    const { queue } = setup()
    expect(queue.inflightLabels().size).toBe(0)
    await submitOne(queue)
    expect([...queue.inflightLabels()]).toEqual(['market:borrower'])
    await queue.onBlock(1n) // no receipt → still pending
    expect(queue.inflightLabels().has('market:borrower')).toBe(true)
  })

  it('emits the tracking key as `id` on the send and on the settlement', async () => {
    // The field name is the schema every dashboard joins on, and this package owns it. The behavioral
    // key keeps the name `label` on the way IN — see SubmitArgs.label.
    const { logger, events } = captureLogger()
    const { queue } = setup({
      logger,
      getReceipt: async () => ({ status: 'success', blockNumber: 10n })
    })
    await submitSighted(queue, 0n)
    await queue.onBlock(1n)
    expect(events.find(e => e.event === 'tx.sent')?.fields?.id).toBe('market:borrower')
    expect(events.find(e => e.event === 'tx.confirmed')?.fields?.id).toBe('market:borrower')
  })

  it('keeps a confirmed label in the backpressure set for the cooldown, then releases it', async () => {
    const { queue } = setup({ getReceipt: async () => ({ status: 'success', blockNumber: 10n }) })
    await submitOne(queue)
    await queue.onBlock(1n) // confirms → leaves `pending`, enters cooldown
    expect(queue.size).toBe(0)
    // Still suppressed: the read RPC may not yet reflect the cleared position, so re-submitting now
    // would land a doomed not-a-borrower revert.
    expect(queue.inflightLabels().has('market:borrower')).toBe(true)
    await queue.onBlock(1n + SETTLED_COOLDOWN_BLOCKS) // not yet expired (delta == cooldown)
    expect(queue.inflightLabels().has('market:borrower')).toBe(true)
    await queue.onBlock(2n + SETTLED_COOLDOWN_BLOCKS) // delta > cooldown → released
    expect(queue.inflightLabels().has('market:borrower')).toBe(false)
  })

  it('also cools down a reverted label', async () => {
    const { queue } = setup({ getReceipt: async () => ({ status: 'reverted', blockNumber: 10n }) })
    await submitOne(queue)
    await queue.onBlock(1n)
    expect(queue.size).toBe(0)
    expect(queue.inflightLabels().has('market:borrower')).toBe(true)
  })

  it('also cools down a dropped (max-bump) label', async () => {
    const { queue } = setup()
    await submitSighted(queue, 0n)
    await queue.onBlock(5n) // attempt 1
    await queue.onBlock(10n)
    await queue.onBlock(15n) // attempt 2
    await queue.onBlock(20n)
    await queue.onBlock(25n) // attempt 3
    await queue.onBlock(30n)
    await queue.onBlock(35n) // attempt already 3 → drop → cooldown
    expect(queue.size).toBe(0)
    expect(queue.inflightLabels().has('market:borrower')).toBe(true)
  })

  it('releases a settled label immediately when the cooldown is disabled', async () => {
    const { queue } = setup({
      getReceipt: async () => ({ status: 'success', blockNumber: 10n }),
      withCooldown: false
    })
    await submitOne(queue)
    await queue.onBlock(1n) // confirms → with no cooldown the label leaves the set right away
    expect(queue.size).toBe(0)
    expect(queue.inflightLabels().size).toBe(0)
  })
})

describe('drop', () => {
  it('settles the tracked nonce as dropped and logs tx.dropped with the reason', async () => {
    const { logger, events } = captureLogger()
    const { queue } = setup({ logger })
    await submitSighted(queue, 0n)
    expect(queue.drop(7, 'nonce_consumed')).toBe(true)
    expect(queue.size).toBe(0)
    const dropped = events.find(e => e.event === 'tx.dropped')
    expect(dropped?.level).toBe('warn')
    expect(dropped?.fields).toMatchObject({
      id: 'market:borrower',
      nonce: 7,
      txHash: hashOf(1),
      reason: 'nonce_consumed'
    })
  })

  it('releases the label from the inflight set', async () => {
    const { queue } = setup()
    await submitSighted(queue, 0n)
    queue.drop(7, 'nonce_consumed')
    expect(queue.inflightLabels().has('market:borrower')).toBe(false)
  })

  it('returns false for a nonce that is not tracked (nothing to reconcile)', async () => {
    const { logger, events } = captureLogger()
    const { queue } = setup({ logger })
    await submitSighted(queue, 0n)
    expect(queue.drop(999, 'nonce_consumed')).toBe(false)
    expect(queue.size).toBe(1) // the real entry is untouched
    expect(events.some(e => e.event === 'tx.dropped')).toBe(false) // nothing dropped for a phantom nonce
  })
})

describe('nonce-consumed reconciliation', () => {
  it('drops a tracked tx whose nonce is consumed on-chain with no receipt for us', async () => {
    const { logger, events } = captureLogger()
    // getConsumedNonce reports 8 (> our nonce 7) while getReceipt never returns one: an external
    // send / competing signer took the nonce, so our tx can never mine → drop as nonce_consumed.
    const { queue } = setup({
      getConsumedNonce: async () => 8,
      reconcileEveryBlocks: 1,
      logger
    })
    await submitSighted(queue, 0n)
    await queue.onBlock(1n)
    expect(queue.size).toBe(0)
    expect(events.find(e => e.event === 'tx.dropped')?.fields).toMatchObject({
      id: 'market:borrower',
      nonce: 7,
      txHash: hashOf(1),
      reason: 'nonce_consumed'
    })
  })

  it('keeps a tracked tx whose nonce is not yet consumed', async () => {
    const { queue } = setup({ getConsumedNonce: async () => 7, reconcileEveryBlocks: 1 })
    await submitSighted(queue, 0n) // nonce 7; consumed count 7 means nonce 7 is not yet mined
    await queue.onBlock(1n)
    expect(queue.size).toBe(1)
  })

  it('only reconciles on the configured block cadence', async () => {
    let calls = 0
    const { queue } = setup({
      getConsumedNonce: async () => {
        calls += 1
        return 0 // 0 < nonce 7, so reconcile never drops — we only count invocations
      },
      reconcileEveryBlocks: 3
    })
    await submitOne(queue)
    await queue.onBlock(1n) // block 1 — no reconcile
    await queue.onBlock(2n) // block 2 — no reconcile
    expect(calls).toBe(0)
    await queue.onBlock(3n) // block 3 — reconcile fires
    expect(calls).toBe(1)
  })

  it('does not reconcile when no getConsumedNonce hook is provided', async () => {
    const { queue } = setup({ reconcileEveryBlocks: 1 })
    await submitSighted(queue, 0n)
    await queue.onBlock(1n) // no hook → nothing to reconcile, tx stays
    expect(queue.size).toBe(1)
  })
})

describe('stuck-age baseline', () => {
  it('does not bump on the pass that first sights a broadcast, however stale the head', async () => {
    const { queue, sends } = setup()
    await submitOne(queue)
    // A caller's block used to set this baseline, so a tick that spent blocks quoting made a fresh
    // broadcast look stuck and bumped it 300ms after it was sent.
    await queue.onBlock(1_000n)
    expect(sends).toHaveLength(1)
    expect(queue.snapshot()[0]?.attempt).toBe(0)
  })

  it('bumps only once stuckBlocks pass beyond the sighting', async () => {
    const { queue, sends } = setup()
    await submitOne(queue)
    await queue.onBlock(1_000n) // sighting stamps the baseline here
    await queue.onBlock(1_004n) // age 4 — not yet past stuckBlocks
    expect(sends).toHaveLength(1)
    await queue.onBlock(1_005n) // age 5
    expect(sends).toHaveLength(2)
  })

  it('re-sights a replacement rather than ageing it from the block that bumped it', async () => {
    const { queue, sends } = setup()
    await submitSighted(queue, 0n)
    await queue.onBlock(5n)
    expect(sends).toHaveLength(2)
    await queue.onBlock(100n) // sights the replacement; a stale maintenance block must not re-bump
    expect(sends).toHaveLength(2)
    await queue.onBlock(105n)
    expect(sends).toHaveLength(3)
  })
})

describe('multi-hash settlement', () => {
  // The stub signer hands out hashOf(1) for the first send and hashOf(2) for its replacement.
  const ORIGINAL = hashOf(1)
  const REPLACEMENT = hashOf(2)

  /**
   * A queue whose receipt source and consumed-nonce cursor can both be moved mid-test, so a receipt
   * can land AFTER a bump has already replaced the hash that carries it.
   */
  function setupSwappable(opts: { withReconciler?: boolean } = {}) {
    let receipt: GetReceipt = async () => null
    const consumedRef = { value: 7 } // 7 == our nonce, i.e. not yet consumed
    const ctx = setup({
      getReceipt: async txHash => receipt(txHash),
      ...(opts.withReconciler ? { getConsumedNonce: async () => consumedRef.value } : {}),
      reconcileEveryBlocks: 1
    })
    return {
      ...ctx,
      consumedRef,
      setReceipt(next: GetReceipt) {
        receipt = next
      }
    }
  }

  const minedAt =
    (hash: Hex, status: 'success' | 'reverted'): GetReceipt =>
    async txHash =>
      txHash === hash ? { status, blockNumber: 42n } : null

  it('confirms on the original hash when the bump that replaced it never landed', async () => {
    const ctx = setupSwappable()
    await submitSighted(ctx.queue, 0n)
    await ctx.queue.onBlock(5n) // bump: REPLACEMENT is now latest, ORIGINAL still broadcast
    ctx.setReceipt(minedAt(ORIGINAL, 'success'))
    await ctx.queue.onBlock(6n)

    expect(ctx.queue.size).toBe(0)
    const confirmed = ctx.events.find(e => e.event === 'tx.confirmed')
    expect(confirmed?.fields?.txHash).toBe(ORIGINAL)
    expect(confirmed?.fields?.blockNumber).toBe(42n)
    expect(ctx.events.some(e => e.event === 'tx.dropped')).toBe(false)
  })

  it('reverts on the original hash with that hash, not the replacement', async () => {
    const ctx = setupSwappable()
    await submitSighted(ctx.queue, 0n)
    await ctx.queue.onBlock(5n)
    ctx.setReceipt(minedAt(ORIGINAL, 'reverted'))
    await ctx.queue.onBlock(6n)

    expect(ctx.events.find(e => e.event === 'tx.reverted')?.fields?.txHash).toBe(ORIGINAL)
  })

  it('still settles on the replacement when that is what mined', async () => {
    const ctx = setupSwappable()
    await submitSighted(ctx.queue, 0n)
    await ctx.queue.onBlock(5n)
    ctx.setReceipt(minedAt(REPLACEMENT, 'success'))
    await ctx.queue.onBlock(6n)

    expect(ctx.events.find(e => e.event === 'tx.confirmed')?.fields?.txHash).toBe(REPLACEMENT)
  })

  it('reads past a failure on the newest hash to find a mined original', async () => {
    const ctx = setupSwappable()
    await submitSighted(ctx.queue, 0n)
    await ctx.queue.onBlock(5n)
    ctx.setReceipt(async txHash => {
      if (txHash === REPLACEMENT) throw new Error('rpc down')
      return { status: 'success', blockNumber: 42n }
    })
    await ctx.queue.onBlock(6n)

    expect(ctx.events.find(e => e.event === 'tx.confirmed')?.fields?.txHash).toBe(ORIGINAL)
  })

  it('settles a consumed nonce whose earlier hash mined instead of dropping it', async () => {
    // The reconciler used to look only at the latest hash, so a mined original read as an external
    // send taking our nonce — the misreport this whole record exists to prevent.
    const ctx = setupSwappable({ withReconciler: true })
    await submitSighted(ctx.queue, 0n)
    await ctx.queue.onBlock(5n) // bump; nonce not yet consumed, so nothing is retired
    ctx.setReceipt(minedAt(ORIGINAL, 'success'))
    ctx.consumedRef.value = 8 // the chain moved past our nonce — because OUR original mined
    await ctx.queue.onBlock(6n)

    expect(ctx.queue.size).toBe(0)
    expect(ctx.events.find(e => e.event === 'tx.confirmed')?.fields?.txHash).toBe(ORIGINAL)
    expect(
      ctx.events.some(e => e.event === 'tx.dropped' && e.fields?.reason === 'nonce_consumed')
    ).toBe(false)
  })

  it('still reports nonce_consumed when no tracked hash has a receipt', async () => {
    const ctx = setupSwappable({ withReconciler: true })
    await submitSighted(ctx.queue, 0n)
    await ctx.queue.onBlock(5n)
    ctx.consumedRef.value = 8 // consumed by someone else: no hash of ours ever gets a receipt
    await ctx.queue.onBlock(6n)

    expect(ctx.queue.size).toBe(0)
    expect(
      ctx.events.some(e => e.event === 'tx.dropped' && e.fields?.reason === 'nonce_consumed')
    ).toBe(true)
  })

  it('keeps an entry whose every hash failed to read, and never bumps or drops it', async () => {
    const ctx = setupSwappable({ withReconciler: true })
    await submitSighted(ctx.queue, 0n)
    await ctx.queue.onBlock(5n)
    const sendsAfterBump = ctx.sends.length
    ctx.setReceipt(async () => {
      throw new Error('rpc down')
    })
    ctx.consumedRef.value = 8 // even with the nonce consumed, an unreadable receipt proves nothing
    await ctx.queue.onBlock(20n)

    expect(ctx.queue.size).toBe(1) // an unreadable receipt is not proof the tx is gone
    expect(ctx.sends.length).toBe(sendsAfterBump) // nor grounds to replace it
    expect(ctx.events.some(e => e.event === 'tx.onblock_error')).toBe(true)
    expect(ctx.events.some(e => e.event === 'tx.dropped')).toBe(false)
  })
})

describe('send-aborted latch', () => {
  it('latches sends after a hashless TxSendError until the next onBlock clears it', async () => {
    let calls = 0
    const send: SendTx = async request => {
      calls += 1
      if (calls === 1) throw new TxSendError(new Error('rpc timeout after broadcast'), 7)
      return { nonce: request.nonce ?? 7, txHash: hashOf(calls), gas: STUB_GAS }
    }
    const { queue } = setup({ send })
    // First submit claims a nonce but fails hashless → rethrows and latches.
    await expect(submitSighted(queue, 0n)).rejects.toThrow(/rpc timeout after broadcast/)
    expect(calls).toBe(1)
    // While latched, further submits are skipped (no new send attempts).
    await submitSighted(queue, 0n)
    expect(calls).toBe(1)
    expect(queue.size).toBe(0)
    // The settlement pass clears the latch.
    await queue.onBlock(1n)
    await submitSighted(queue, 0n)
    expect(calls).toBe(2)
    expect(queue.size).toBe(1)
  })

  it('logs tx.send_aborted while latched', async () => {
    const { logger, events } = captureLogger()
    const send: SendTx = async () => {
      throw new TxSendError(new Error('broadcast lost'), 7)
    }
    const { queue } = setup({ send, logger })
    await expect(submitSighted(queue, 0n)).rejects.toThrow()
    await submitSighted(queue, 0n) // latched → skipped
    expect(events.find(e => e.event === 'tx.send_aborted')?.level).toBe('warn')
  })
})

describe('nonce-hole latch', () => {
  // Sequential-nonce send so multiple first-sends get DISTINCT nonces (the shared `setup` default
  // pins nonce 7, which would collide two entries in the nonce-keyed pending map). `consumedRef` lets
  // a test advance the chain's consumed-nonce count between `onBlock` passes; it starts at 0 so the
  // reconciler drops nothing until a test opts in.
  function setupSeq(opts: { maxFeeWei?: bigint } = {}) {
    const sends: SendArg[] = []
    const consumedRef = { value: 0 }
    let nextNonce = 7
    let h = 0
    const send: SendTx = async request => {
      sends.push(request)
      h += 1
      return { nonce: request.nonce ?? nextNonce++, txHash: hashOf(h), gas: STUB_GAS }
    }
    let syncNonceCalls = 0
    const { logger, events } = captureLogger()
    const queue = createPendingQueue({
      send,
      getReceipt: async () => null,
      getBaseFee: async () => 100n,
      syncNonce: async () => {
        syncNonceCalls += 1
      },
      getConsumedNonce: async () => consumedRef.value,
      reconcileEveryBlocks: 1,
      maxFeeWei: opts.maxFeeWei ?? 10_000_000_000_000n,
      logger
    })
    const submit = (label: string) =>
      queue.submit({
        request: REQUEST,
        label,
        maxFeePerGas: 1000n,
        maxPriorityFeePerGas: 1000n
      })
    return {
      queue,
      sends,
      submit,
      events,
      consumedRef,
      get syncNonceCalls() {
        return syncNonceCalls
      }
    }
  }

  it('refuses new first-sends after dropping an unconsumed nonce, then resumes once the chain consumes past it', async () => {
    const ctx = setupSeq({ maxFeeWei: 1000n }) // low ceiling so a bump breaches → fee_ceiling drop
    await ctx.submit('a') // nonce 7
    await ctx.queue.onBlock(0n) // sights nonce 7 at block 0
    await ctx.submit('b') // nonce 8 (queue not empty → no extra sync)
    expect(ctx.queue.size).toBe(2)
    // Block 5: nonce 7 (age 5 > 4) is stuck; its bump breaches the ceiling → dropped fee_ceiling and
    // its (still-unconsumed) nonce is latched as a hole. nonce 8 is only sighted here → stays.
    await ctx.queue.onBlock(5n)
    expect(ctx.queue.size).toBe(1)
    expect(
      ctx.events.some(e => e.event === 'tx.dropped' && e.fields?.reason === 'fee_ceiling')
    ).toBe(true)
    const sendsAfterDrop = ctx.sends.length
    // A NEW first-send is refused while the hole is latched (nonce 8 still pending → queue not empty,
    // so the empty-queue sync can't clear it).
    // Queue-wide, not this label's fault: `refused` is what tells a caller not to back the position off.
    expect(await ctx.submit('c')).toEqual({ sent: false, reason: 'refused' })
    expect(ctx.sends.length).toBe(sendsAfterDrop) // no new broadcast
    expect(ctx.queue.size).toBe(1)
    expect(ctx.events.some(e => e.event === 'queue.nonce_hole' && e.fields?.id === 'c')).toBe(true)
    // The chain now consumes past the dropped nonce (7 mined → count 8 > hole high 7): latch clears.
    ctx.consumedRef.value = 8
    await ctx.queue.onBlock(7n)
    expect(ctx.events.some(e => e.event === 'queue.nonce_hole_cleared')).toBe(true)
    // Sends flow again.
    await ctx.submit('d')
    expect(ctx.sends.length).toBe(sendsAfterDrop + 1)
  })

  it('clears the latch when the queue empties and syncNonce re-derives the cursor', async () => {
    const ctx = setupSeq({ maxFeeWei: 1000n })
    await ctx.submit('a') // nonce 7, sole entry (sync #1 on the empty queue)
    await ctx.queue.onBlock(0n) // sights it at block 0
    await ctx.queue.onBlock(5n) // stuck → fee_ceiling drop → latched; queue now empty
    expect(ctx.queue.size).toBe(0)
    const syncsBefore = ctx.syncNonceCalls
    // Queue empty → the next first-send syncs the cursor from chain and clears the hole in one step.
    await ctx.submit('b')
    expect(ctx.syncNonceCalls).toBe(syncsBefore + 1)
    expect(
      ctx.events.some(e => e.event === 'queue.nonce_hole_cleared' && e.fields?.via === 'sync')
    ).toBe(true)
    expect(ctx.queue.size).toBe(1) // send went through
  })

  it('does not latch a hole when the reconciler drops a consumed nonce', async () => {
    const ctx = setupSeq()
    await ctx.submit('a') // nonce 7
    await ctx.submit('b') // nonce 8 (queue not empty → no extra sync)
    expect(ctx.queue.size).toBe(2)
    // Chain shows nonce 7 consumed by an external send (count 8); the reconciler drops our tracked
    // nonce 7 as nonce_consumed — a BY-DEFINITION-consumed retirement that must NOT latch a hole.
    ctx.consumedRef.value = 8
    await ctx.queue.onBlock(1n)
    expect(ctx.queue.size).toBe(1) // nonce 7 dropped, nonce 8 stays
    expect(
      ctx.events.some(e => e.event === 'tx.dropped' && e.fields?.reason === 'nonce_consumed')
    ).toBe(true)
    const sendsBefore = ctx.sends.length
    // No hole latched → a new first-send proceeds (it would be refused had the reconciler latched).
    await ctx.submit('c')
    expect(ctx.sends.length).toBe(sendsBefore + 1)
    expect(ctx.events.some(e => e.event === 'queue.nonce_hole')).toBe(false)
  })

  it('widens the hole span across multiple drops and clears only past the highest', async () => {
    const ctx = setupSeq({ maxFeeWei: 1000n })
    await ctx.submit('a') // nonce 7
    await ctx.queue.onBlock(0n) // sights nonce 7 at block 0
    await ctx.submit('b') // nonce 8
    await ctx.queue.onBlock(2n) // sights nonce 8 at block 2
    await ctx.queue.onBlock(5n) // a (age 5) stuck → drop → hole {7}
    await ctx.queue.onBlock(7n) // b (age 5) stuck → drop → hole widens to {7, 8}
    expect(ctx.queue.size).toBe(0)
    // count 8 means nonce 7 mined but nonce 8 (the HIGHEST hole) not yet: the latch must persist.
    ctx.consumedRef.value = 8
    await ctx.queue.onBlock(8n)
    expect(ctx.events.some(e => e.event === 'queue.nonce_hole_cleared')).toBe(false)
    // count 9 clears past the highest dropped nonce → latch releases.
    ctx.consumedRef.value = 9
    await ctx.queue.onBlock(9n)
    expect(ctx.events.some(e => e.event === 'queue.nonce_hole_cleared')).toBe(true)
  })
})

// A tick counting "submitted" must count only real broadcasts; every silent refusal resolves false.
describe('submit outcome', () => {
  it('resolves sent when the send is accepted and tracked', async () => {
    const { queue } = setup()
    expect(await submitOne(queue)).toEqual({ sent: true })
    expect(queue.size).toBe(1)
  })

  it('reports send_failed when the first send fails without a nonce', async () => {
    const send: SendTx = async () => {
      throw new Error('rpc down')
    }
    const { queue } = setup({ send })
    // The node rejected THIS position's transaction — a fact about the position, so a caller must be
    // able to re-arm its backoff. Collapsing this with a queue refusal is what let a failing send
    // re-quote and re-send every block.
    expect(await submitOne(queue)).toEqual({
      sent: false,
      reason: 'send_failed',
      executionRevert: false
    })
  })

  it('reports executionRevert on a send the chain reverted, and logs its selector', async () => {
    const data = encodeErrorResult({
      abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string' }] }] as const,
      errorName: 'Error',
      args: ['return too low']
    })
    const send: SendTx = async () => {
      throw Object.assign(new ExecutionRevertedError({}), { data })
    }
    const { logger, events } = captureLogger()
    const { queue } = setup({ send, logger })
    // The selector rides the outcome, not just the log line: the caller watching consecutive declines
    // needs to know whether the chain keeps refusing for the same reason.
    expect(await submitOne(queue)).toEqual({
      sent: false,
      reason: 'send_failed',
      executionRevert: true,
      selector: data.slice(0, 10)
    })
    const failed = events.find(e => e.event === 'tx.submit_failed')
    expect(failed?.fields?.reason).toBe('return too low')
    expect(failed?.fields?.executionRevert).toBe(true)
    expect(failed?.fields?.selector).toBe(data.slice(0, 10))
  })

  it('omits the selector when a transport failure carries no revert payload', async () => {
    const send: SendTx = async () => {
      throw new Error('nonce too low')
    }
    const { logger, events } = captureLogger()
    const { queue } = setup({ send, logger })
    expect(await submitOne(queue)).toEqual({
      sent: false,
      reason: 'send_failed',
      executionRevert: false
    })
    const failed = events.find(e => e.event === 'tx.submit_failed')
    expect(failed?.fields?.executionRevert).toBe(false)
    expect(failed?.fields).not.toHaveProperty('selector')
  })

  it('reports refused when the empty-queue nonce re-sync throws', async () => {
    const { queue } = setup({
      syncNonce: async () => {
        throw new Error('rpc down')
      }
    })
    expect(await submitOne(queue)).toEqual({ sent: false, reason: 'refused' })
  })

  it('reports refused while the send-aborted latch is set', async () => {
    const send: SendTx = async () => {
      throw new TxSendError(new Error('broadcast lost'), 7)
    }
    const { queue } = setup({ send })
    await expect(submitOne(queue)).rejects.toThrow() // the latching send itself rethrows
    expect(await submitOne(queue)).toEqual({ sent: false, reason: 'refused' })
  })
})

// The nonce-critical section is serialized: a pass that plans several vaults/positions submits them
// concurrently, and without the mutex the signer's `??=`-then-await cursor hands out one nonce twice.
describe('submit serialization', () => {
  /** A `send` whose completion each caller controls, so two submits provably overlap in time. */
  function gatedSend() {
    const release: (() => void)[] = []
    const entered: number[] = []
    let cursor = 100
    const send: SendTx = async request => {
      const index = entered.length
      entered.push(index)
      await new Promise<void>(resolve => release.push(resolve))
      const nonce = request.nonce ?? cursor++
      return { nonce, txHash: hashOf(nonce), gas: STUB_GAS }
    }
    return { send, release, entered }
  }

  it('serializes concurrent submits into strictly increasing nonces', async () => {
    const { send, release, entered } = gatedSend()
    const { queue } = setup({ send })

    const first = queue.submit({
      request: REQUEST,
      label: 'vault:a',
      maxFeePerGas: 1000n,
      maxPriorityFeePerGas: 1000n
    })
    const second = queue.submit({
      request: REQUEST,
      label: 'vault:b',
      maxFeePerGas: 1000n,
      maxPriorityFeePerGas: 1000n
    })

    // Only the leader may be inside `send`; the follower is still queued behind the lock. A macrotask
    // turn is long enough for both submits to reach `send` if they were allowed to run in parallel.
    await new Promise<void>(resolve => setTimeout(resolve, 5))
    expect(entered).toHaveLength(1)

    release.shift()?.()
    expect(await first).toEqual({ sent: true })
    release.shift()?.()
    expect(await second).toEqual({ sent: true })

    const nonces = queue.snapshot().map(entry => entry.nonce)
    expect(nonces).toEqual([100, 101])
    expect(queue.size).toBe(2)
  })

  it('never re-syncs the cursor past a concurrent in-flight send', async () => {
    const { send, release } = gatedSend()
    let syncing = 0
    let sawSyncDuringSend = false
    const { queue } = setup({
      send,
      // A deliberately slow sync: it must never observe a non-empty queue, because the empty-queue
      // test that gates it is inside the lock.
      syncNonce: async () => {
        syncing += 1
        if (queue.size > 0) sawSyncDuringSend = true
        await new Promise<void>(resolve => setTimeout(resolve, 5))
      }
    })

    const both = Promise.all([
      queue.submit({
        request: REQUEST,
        label: 'vault:a',
        maxFeePerGas: 1000n,
        maxPriorityFeePerGas: 1000n
      }),
      queue.submit({
        request: REQUEST,
        label: 'vault:b',
        maxFeePerGas: 1000n,
        maxPriorityFeePerGas: 1000n
      })
    ])

    // Drain the two gated sends as they arrive.
    const drain = setInterval(() => release.shift()?.(), 1)
    expect(await both).toEqual([{ sent: true }, { sent: true }])
    clearInterval(drain)

    // Exactly one sync ran (the first submit, on the empty queue); the second saw size 1 and skipped.
    expect(syncing).toBe(1)
    expect(sawSyncDuringSend).toBe(false)
    expect(queue.snapshot().map(entry => entry.nonce)).toEqual([100, 101])
  })

  it('propagates a locked-section throw to that caller only and releases the lock', async () => {
    let calls = 0
    const send: SendTx = async request => {
      calls += 1
      if (calls === 1) throw new TxSendError(new Error('broadcast lost'), 7)
      return { nonce: request.nonce ?? 8, txHash: hashOf(8), gas: STUB_GAS }
    }
    const { queue } = setup({ send })

    const first = queue.submit({
      request: REQUEST,
      label: 'vault:a',
      maxFeePerGas: 1000n,
      maxPriorityFeePerGas: 1000n
    })
    const second = queue.submit({
      request: REQUEST,
      label: 'vault:b',
      maxFeePerGas: 1000n,
      maxPriorityFeePerGas: 1000n
    })

    await expect(first).rejects.toBeInstanceOf(TxSendError)
    // The lock was released, so the follower ran — and hit the send-aborted latch the leader set,
    // which is the queue's own refusal, not a hang or a shared rejection.
    expect(await second).toEqual({ sent: false, reason: 'refused' })
    expect(queue.size).toBe(0)
  })
})
