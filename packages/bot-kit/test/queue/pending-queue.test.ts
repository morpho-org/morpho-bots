import type { Address, Hex } from 'viem'

import { ExecutionRevertedError } from 'viem'
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
import { TxSendError } from '../../src/tx-error'

// The cooldown the opted-in cases run with (mirrors midnight's SETTLED_COOLDOWN_BLOCKS tuning).
const SETTLED_COOLDOWN_BLOCKS = 20n

const REQUEST: TxRequest = {
  to: '0x0000000000000000000000000000000000000001' as Address,
  data: '0x' as Hex
}
const NOOP_LOGGER: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
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
    return { nonce: request.nonce ?? 7, txHash: hashOf(counter) }
  }
  let syncNonceCalls = 0
  const defaultSyncNonce: SyncNonce = async () => {
    syncNonceCalls += 1
  }
  const getBaseFee: GetBaseFee = async () => opts.baseFee ?? 100n
  const queue = createPendingQueue({
    send: opts.send ?? defaultSend,
    getReceipt: opts.getReceipt ?? (async () => null),
    getBaseFee,
    ...(opts.syncNonce === null ? {} : { syncNonce: opts.syncNonce ?? defaultSyncNonce }),
    ...(opts.withCooldown === false ? {} : { settledCooldownBlocks: SETTLED_COOLDOWN_BLOCKS }),
    ...(opts.getConsumedNonce ? { getConsumedNonce: opts.getConsumedNonce } : {}),
    ...(opts.reconcileEveryBlocks ? { reconcileEveryBlocks: opts.reconcileEveryBlocks } : {}),
    maxFeeWei: opts.maxFeeWei ?? 10_000_000_000_000n,
    logger: opts.logger ?? NOOP_LOGGER
  })
  return {
    queue,
    sends,
    get syncNonceCalls() {
      return syncNonceCalls
    }
  }
}

function submitOne(queue: PendingQueue, blockNumber = 0n) {
  return queue.submit({
    request: REQUEST,
    label: 'market:borrower',
    maxFeePerGas: 1000n,
    maxPriorityFeePerGas: 1000n,
    blockNumber
  })
}

describe('createPendingQueue', () => {
  it('records a submitted tx with the signer-assigned nonce', async () => {
    const { queue, sends } = setup()
    const outcome = await submitOne(queue)
    expect(queue.size).toBe(1)
    expect(sends[0]?.nonce).toBeUndefined() // first send leaves nonce assignment to the signer
    expect(queue.snapshot()[0]).toEqual({ nonce: 7, txHash: hashOf(1), attempt: 0 })
    // The caller's broadcast signal — only this outcome may clear a per-position backoff.
    expect(outcome).toEqual({ kind: 'sent' })
  })

  it('removes a tx once its receipt confirms', async () => {
    const { queue } = setup({ getReceipt: async () => ({ status: 'success', blockNumber: 10n }) })
    await submitOne(queue)
    await queue.onBlock(1n)
    expect(queue.size).toBe(0)
  })

  it('leaves a tx pending until it is stuck past stuckBlocks', async () => {
    const { queue, sends } = setup()
    await submitOne(queue, 0n)
    await queue.onBlock(4n) // age 4, not yet > 4
    expect(queue.size).toBe(1)
    expect(sends).toHaveLength(1) // no replacement
  })

  it('bumps and replaces a stuck tx at the same nonce', async () => {
    const { queue, sends } = setup({ baseFee: 100n })
    await submitOne(queue, 0n)
    await queue.onBlock(5n) // age 5 > 4 → bump
    expect(sends).toHaveLength(2)
    expect(sends[1]?.nonce).toBe(7) // replacement pins the original nonce
    expect(sends[1]?.maxPriorityFeePerGas).toBe(1125n) // +12.5%
    expect(sends[1]?.maxFeePerGas).toBe(1325n) // max(1125, 2*100 + 1125)
    expect(queue.snapshot()[0]).toEqual({ nonce: 7, txHash: hashOf(2), attempt: 1 })
  })

  it('drops a tx after maxBumpAttempts bumps', async () => {
    const { queue } = setup()
    await submitOne(queue, 0n)
    await queue.onBlock(5n) // attempt 1
    await queue.onBlock(10n) // attempt 2
    await queue.onBlock(15n) // attempt 3
    expect(queue.size).toBe(1)
    await queue.onBlock(20n) // attempt already 3 → drop
    expect(queue.size).toBe(0)
  })

  it('drops a stuck tx when the bump would breach the fee ceiling', async () => {
    const { queue } = setup({ maxFeeWei: 1000n })
    await submitOne(queue, 0n)
    await queue.onBlock(5n)
    expect(queue.size).toBe(0)
  })

  it('does not track a tx whose first send fails, and logs tx.submit_failed', async () => {
    const { logger, events } = captureLogger()
    const send: SendTx = async () => {
      throw new Error('rpc down')
    }
    const { queue } = setup({ send, logger })
    const outcome = await submitOne(queue) // must not throw
    expect(queue.size).toBe(0)
    expect(events.find(e => e.event === 'tx.submit_failed')?.level).toBe('warn')
    // Per-position: this is the one reason a caller may attribute to the position it was holding.
    expect(outcome).toEqual({ kind: 'failed', scope: 'position', reason: 'submit_failed' })
  })

  it('rethrows a first-send failure after a nonce was claimed but no hash was returned', async () => {
    const { logger, events } = captureLogger()
    const send: SendTx = async () => {
      throw new TxSendError(new Error('rpc timeout after broadcast'), 7)
    }
    const { queue } = setup({ send, logger })
    // Still a THROW, deliberately not a `failed` outcome: the caller must abort the tick rather than
    // race the signer's cursor rollback.
    await expect(submitOne(queue)).rejects.toThrow(/rpc timeout after broadcast/)
    expect(queue.size).toBe(0)
    expect(events.find(e => e.event === 'tx.submit_failed')?.fields?.nonce).toBe(7)
  })

  it('drops a stuck tx when its replacement reverts on-chain (no longer liquidatable)', async () => {
    const { logger, events } = captureLogger()
    let calls = 0
    const send: SendTx = async request => {
      calls += 1
      if (calls === 1) return { nonce: request.nonce ?? 7, txHash: hashOf(1) }
      throw new ExecutionRevertedError({}) // the re-broadcast reverts
    }
    const { queue } = setup({ send, logger })
    await submitOne(queue, 0n)
    await queue.onBlock(5n) // stuck → replace → reverts → drop
    expect(queue.size).toBe(0)
    expect(events.find(e => e.event === 'tx.dropped')?.fields?.reason).toBe('reverts_on_replace')
  })

  it('retries a stuck tx on transient send failures, then drops it at maxBumpAttempts', async () => {
    const { logger, events } = captureLogger()
    let calls = 0
    const send: SendTx = async request => {
      calls += 1
      if (calls === 1) return { nonce: request.nonce ?? 7, txHash: hashOf(1) }
      throw new Error('connection reset') // every replacement is a transient failure
    }
    const { queue } = setup({ send, logger })
    await submitOne(queue, 0n)
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
      return { nonce: request.nonce ?? n, txHash: hashOf(n) }
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
      maxPriorityFeePerGas: 1000n,
      blockNumber: 0n
    })
    await queue.submit({
      request: REQUEST,
      label: 'b',
      maxFeePerGas: 1000n,
      maxPriorityFeePerGas: 1000n,
      blockNumber: 0n
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
      return { nonce: request.nonce ?? n, txHash: hashOf(n) } // distinct nonces → both tracked
    }
    const ctx = setup({ send })
    await ctx.queue.submit({
      request: REQUEST,
      label: 'a',
      maxFeePerGas: 1000n,
      maxPriorityFeePerGas: 1000n,
      blockNumber: 0n
    })
    await ctx.queue.submit({
      request: REQUEST,
      label: 'b',
      maxFeePerGas: 1000n,
      maxPriorityFeePerGas: 1000n,
      blockNumber: 0n
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
    const outcome = await submitOne(ctx.queue) // must not throw
    expect(ctx.queue.size).toBe(0) // nothing broadcast on a stale cursor
    expect(outcome).toEqual({ kind: 'failed', scope: 'queue', reason: 'nonce_sync_failed' })
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

  it('keeps a confirmed label in the backpressure set for the cooldown, then releases it', async () => {
    const { queue } = setup({ getReceipt: async () => ({ status: 'success', blockNumber: 10n }) })
    await submitOne(queue, 0n)
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
    await submitOne(queue, 0n)
    await queue.onBlock(1n)
    expect(queue.size).toBe(0)
    expect(queue.inflightLabels().has('market:borrower')).toBe(true)
  })

  it('also cools down a dropped (max-bump) label', async () => {
    const { queue } = setup()
    await submitOne(queue, 0n)
    await queue.onBlock(5n) // attempt 1
    await queue.onBlock(10n) // attempt 2
    await queue.onBlock(15n) // attempt 3
    await queue.onBlock(20n) // attempt already 3 → drop → cooldown
    expect(queue.size).toBe(0)
    expect(queue.inflightLabels().has('market:borrower')).toBe(true)
  })

  it('releases a settled label immediately when the cooldown is disabled', async () => {
    const { queue } = setup({
      getReceipt: async () => ({ status: 'success', blockNumber: 10n }),
      withCooldown: false
    })
    await submitOne(queue, 0n)
    await queue.onBlock(1n) // confirms → with no cooldown the label leaves the set right away
    expect(queue.size).toBe(0)
    expect(queue.inflightLabels().size).toBe(0)
  })
})

describe('drop', () => {
  it('settles the tracked nonce as dropped and logs tx.dropped with the reason', async () => {
    const { logger, events } = captureLogger()
    const { queue } = setup({ logger })
    await submitOne(queue, 0n)
    expect(queue.drop(7, 'nonce_consumed')).toBe(true)
    expect(queue.size).toBe(0)
    const dropped = events.find(e => e.event === 'tx.dropped')
    expect(dropped?.level).toBe('warn')
    expect(dropped?.fields).toMatchObject({
      label: 'market:borrower',
      nonce: 7,
      txHash: hashOf(1),
      reason: 'nonce_consumed'
    })
  })

  it('releases the label from the inflight set', async () => {
    const { queue } = setup()
    await submitOne(queue, 0n)
    queue.drop(7, 'nonce_consumed')
    expect(queue.inflightLabels().has('market:borrower')).toBe(false)
  })

  it('returns false for a nonce that is not tracked (nothing to reconcile)', async () => {
    const { logger, events } = captureLogger()
    const { queue } = setup({ logger })
    await submitOne(queue, 0n)
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
    await submitOne(queue, 0n)
    await queue.onBlock(1n)
    expect(queue.size).toBe(0)
    expect(events.find(e => e.event === 'tx.dropped')?.fields).toMatchObject({
      label: 'market:borrower',
      nonce: 7,
      txHash: hashOf(1),
      reason: 'nonce_consumed'
    })
  })

  it('keeps a tracked tx whose nonce is not yet consumed', async () => {
    const { queue } = setup({ getConsumedNonce: async () => 7, reconcileEveryBlocks: 1 })
    await submitOne(queue, 0n) // nonce 7; consumed count 7 means nonce 7 is not yet mined
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
    await submitOne(queue, 0n)
    await queue.onBlock(1n) // block 1 — no reconcile
    await queue.onBlock(2n) // block 2 — no reconcile
    expect(calls).toBe(0)
    await queue.onBlock(3n) // block 3 — reconcile fires
    expect(calls).toBe(1)
  })

  it('does not reconcile when no getConsumedNonce hook is provided', async () => {
    const { queue } = setup({ reconcileEveryBlocks: 1 })
    await submitOne(queue, 0n)
    await queue.onBlock(1n) // no hook → nothing to reconcile, tx stays
    expect(queue.size).toBe(1)
  })
})

describe('send-aborted latch', () => {
  it('latches sends after a hashless TxSendError until the next onBlock clears it', async () => {
    let calls = 0
    const send: SendTx = async request => {
      calls += 1
      if (calls === 1) throw new TxSendError(new Error('rpc timeout after broadcast'), 7)
      return { nonce: request.nonce ?? 7, txHash: hashOf(calls) }
    }
    const { queue } = setup({ send })
    // First submit claims a nonce but fails hashless → rethrows and latches.
    await expect(submitOne(queue, 0n)).rejects.toThrow(/rpc timeout after broadcast/)
    expect(calls).toBe(1)
    // While latched, further submits are skipped (no new send attempts).
    await submitOne(queue, 0n)
    expect(calls).toBe(1)
    expect(queue.size).toBe(0)
    // The settlement pass clears the latch.
    await queue.onBlock(1n)
    await submitOne(queue, 0n)
    expect(calls).toBe(2)
    expect(queue.size).toBe(1)
  })

  it('logs tx.send_aborted while latched', async () => {
    const { logger, events } = captureLogger()
    const send: SendTx = async () => {
      throw new TxSendError(new Error('broadcast lost'), 7)
    }
    const { queue } = setup({ send, logger })
    await expect(submitOne(queue, 0n)).rejects.toThrow()
    const outcome = await submitOne(queue, 0n) // latched → skipped
    expect(events.find(e => e.event === 'tx.send_aborted')?.level).toBe('warn')
    // Queue-WIDE: refuses every send this tick, so a caller must not back the position off for it.
    expect(outcome).toEqual({ kind: 'failed', scope: 'queue', reason: 'send_aborted' })
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
      return { nonce: request.nonce ?? nextNonce++, txHash: hashOf(h) }
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
    const submit = (label: string, blockNumber: bigint) =>
      queue.submit({
        request: REQUEST,
        label,
        maxFeePerGas: 1000n,
        maxPriorityFeePerGas: 1000n,
        blockNumber
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
    await ctx.submit('a', 0n) // nonce 7 at block 0
    await ctx.submit('b', 3n) // nonce 8 at block 3 (queue not empty → no extra sync)
    expect(ctx.queue.size).toBe(2)
    // Block 5: nonce 7 (age 5 > 4) is stuck; its bump breaches the ceiling → dropped fee_ceiling and
    // its (still-unconsumed) nonce is latched as a hole. nonce 8 (age 2) is not stuck → stays.
    await ctx.queue.onBlock(5n)
    expect(ctx.queue.size).toBe(1)
    expect(
      ctx.events.some(e => e.event === 'tx.dropped' && e.fields?.reason === 'fee_ceiling')
    ).toBe(true)
    const sendsAfterDrop = ctx.sends.length
    // A NEW first-send is refused while the hole is latched (nonce 8 still pending → queue not empty,
    // so the empty-queue sync can't clear it).
    const refused = await ctx.submit('c', 6n)
    expect(ctx.sends.length).toBe(sendsAfterDrop) // no new broadcast
    expect(refused).toEqual({ kind: 'failed', scope: 'queue', reason: 'nonce_hole' })
    expect(ctx.queue.size).toBe(1)
    expect(ctx.events.some(e => e.event === 'queue.nonce_hole' && e.fields?.label === 'c')).toBe(
      true
    )
    // The chain now consumes past the dropped nonce (7 mined → count 8 > hole high 7): latch clears.
    ctx.consumedRef.value = 8
    await ctx.queue.onBlock(7n)
    expect(ctx.events.some(e => e.event === 'queue.nonce_hole_cleared')).toBe(true)
    // Sends flow again.
    await ctx.submit('d', 8n)
    expect(ctx.sends.length).toBe(sendsAfterDrop + 1)
  })

  it('clears the latch when the queue empties and syncNonce re-derives the cursor', async () => {
    const ctx = setupSeq({ maxFeeWei: 1000n })
    await ctx.submit('a', 0n) // nonce 7, sole entry (sync #1 on the empty queue)
    await ctx.queue.onBlock(5n) // stuck → fee_ceiling drop → latched; queue now empty
    expect(ctx.queue.size).toBe(0)
    const syncsBefore = ctx.syncNonceCalls
    // Queue empty → the next first-send syncs the cursor from chain and clears the hole in one step.
    await ctx.submit('b', 6n)
    expect(ctx.syncNonceCalls).toBe(syncsBefore + 1)
    expect(
      ctx.events.some(e => e.event === 'queue.nonce_hole_cleared' && e.fields?.via === 'sync')
    ).toBe(true)
    expect(ctx.queue.size).toBe(1) // send went through
  })

  it('does not latch a hole when the reconciler drops a consumed nonce', async () => {
    const ctx = setupSeq()
    await ctx.submit('a', 0n) // nonce 7
    await ctx.submit('b', 0n) // nonce 8 (queue not empty → no extra sync)
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
    await ctx.submit('c', 2n)
    expect(ctx.sends.length).toBe(sendsBefore + 1)
    expect(ctx.events.some(e => e.event === 'queue.nonce_hole')).toBe(false)
  })

  it('widens the hole span across multiple drops and clears only past the highest', async () => {
    const ctx = setupSeq({ maxFeeWei: 1000n })
    await ctx.submit('a', 0n) // nonce 7 at block 0
    await ctx.submit('b', 2n) // nonce 8 at block 2
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
