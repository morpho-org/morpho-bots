import type {
  Block,
  Hash,
  KernelChain,
  KernelEffects,
  LedgerStore,
  Log,
  TxPayload
} from '@repo/kernel'

import { DryRunError } from '../../errors'

const SECONDS_PER_BLOCK = 2n

/**
 * What a dry run signs typed data with: a well-formed signature (`r = s = 1`, `v = 27`) that no key
 * made, so a payload can carry it without anyone having signed.
 */
export const DRY_SIGNATURE = `0x${'00'.repeat(31)}01${'00'.repeat(31)}011b`

const blockAt = (number: number): Block => ({
  number,
  hash: `dry-block-${number}`,
  parentHash: `dry-block-${number - 1}`,
  timestamp: BigInt(number) * SECONDS_PER_BLOCK
})

/**
 * A chain, effects and ledger that sign and send nothing, for the real reducer to run against: a
 * broadcast is mined in the next block and final at once, and a write is kept only in memory. Typed
 * data is signed with {@link DRY_SIGNATURE}. Capacity is never observed, so a kernel that needs it
 * refuses.
 * @param parameters - `ledger`: what an earlier run's ledger holds, so a dry run starts from what is
 * live; `logs`: the receipt logs a mined payload emits, as its validator confirms them, none if
 * absent; an optional `materialize`; and `follow`, the real chain whose heads, blocks and finality
 * the dry chain reports, so world reads pin to real blocks and a dry transaction is included in the
 * next real block. Without it every block is fabricated.
 * @returns The dry chain, effects and ledger store.
 */
export const createDryWorld = (
  parameters: {
    materialize?: KernelEffects['materialize']
    ledger?: unknown
    logs?: (payload: TxPayload) => readonly Log[]
    follow?: Pick<KernelChain, 'latest' | 'block' | 'safe'>
  } = {}
) => {
  const { follow } = parameters
  let height = 0
  const signed = new Map<string, { hash: Hash; nonce: number; payload: TxPayload }>()
  const mined = new Map<Hash, { block: number; nonce: number; payload: TxPayload }>()
  const atNonce = new Map<number, Hash>()

  const included = async (hash: Hash) => {
    const found = mined.get(hash)
    if (!found || found.block > height) return undefined
    return {
      block: found.block,
      blockHash: follow ? (await follow.block(found.block)).hash : blockAt(found.block).hash,
      status: 'success' as const,
      logs: parameters.logs?.(found.payload) ?? []
    }
  }

  const fabricated = {
    latest: () =>
      Promise.resolve({
        head: blockAt(height),
        finalized: { number: height, timestamp: blockAt(height).timestamp }
      }),
    block: (number: number) =>
      number <= height
        ? Promise.resolve(blockAt(number))
        : Promise.reject(new DryRunError(`no dry block ${number}`)),
    safe: () => Promise.resolve(blockAt(height))
  }
  const chain: KernelChain = {
    latest: follow
      ? async () => {
          const latest = await follow.latest()
          height = Math.max(height, latest.head.number)
          return latest
        }
      : fabricated.latest,
    block: follow ? number => follow.block(number) : fabricated.block,
    safe: follow ? () => follow.safe() : fabricated.safe,
    nonceAt: () => Promise.resolve({ latest: atNonce.size, pending: atNonce.size }),
    accountCode: () => Promise.resolve('0x'),
    receipt: async hash => (await included(hash)) ?? null,
    nonceTx: async nonce => {
      const hash = atNonce.get(nonce)
      const found = hash === undefined ? undefined : await included(hash)
      return hash === undefined || !found ? null : { hash, ...found }
    },
    commitment: () => Promise.resolve({ consumed: 0n, neutralized: false }),
    capacity: resource => Promise.reject(new DryRunError(`a dry run observes no ${resource}`))
  }

  const effects: KernelEffects = {
    materialize: (command, signal) =>
      parameters.materialize?.(command, signal) ??
      Promise.reject(new DryRunError('this dry run materializes nothing')),
    simulate: () => Promise.resolve(true),
    signTx: (payload, { nonce, level, fee }, guard) => {
      if (!guard.mayAct()) return Promise.reject(new DryRunError('withdrawn before signing'))
      const hash = `dry-tx-${nonce}-${level}`
      signed.set(hash, { hash, nonce, payload })
      return Promise.resolve({
        hash,
        raw: hash,
        bid: { maxFeePerGas: fee, maxPriorityFeePerGas: fee, gas: 1n }
      })
    },
    signTyped: (_payload, guard) =>
      guard.mayAct()
        ? Promise.resolve(DRY_SIGNATURE)
        : Promise.reject(new DryRunError('withdrawn before signing')),
    broadcast: (raw, guard) => {
      const tx = signed.get(raw)
      if (!tx || !guard.mayAct()) return Promise.reject(new DryRunError('withdrawn before sending'))
      if (!follow) height++
      mined.set(tx.hash, {
        block: follow ? height + 1 : height,
        nonce: tx.nonce,
        payload: tx.payload
      })
      atNonce.set(tx.nonce, tx.hash)
      return Promise.resolve('accepted')
    },
    release: (_payload, guard) =>
      guard.mayAct()
        ? Promise.resolve('ok')
        : Promise.reject(new DryRunError('withdrawn before releasing'))
  }

  const store: LedgerStore = {
    read: () => Promise.resolve(parameters.ledger ?? null),
    write: () => Promise.resolve()
  }

  return { chain, effects, store }
}
