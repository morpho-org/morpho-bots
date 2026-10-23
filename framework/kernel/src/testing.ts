import type { Block, KernelChain } from './chain-adapter'
import type { KernelEffects } from './executor'
import type { LedgerStore } from './store'
import type { DurableLedger, TxPayload } from './types'

import { decodeLedger, encodeLedger } from './durable'

export { asStored, encodeLedger } from './durable'
export { startKernel } from './start-kernel'

const gate = () => {
  let open = () => {}
  const opened = new Promise<void>(resolve => {
    open = resolve
  })
  return { opened, open }
}

/**
 * A chain that mines broadcast transactions in nonce order into its next block, and finalizes
 * `finalityLag` blocks behind its head. A mined transaction's status is what `onMined` says, so a
 * scenario can clear the position it liquidated or revert a liquidation whose route is squeezed.
 * Test-only, as `@repo/kernel/testing`: nothing under a bot's `src/` imports it.
 */
export class FakeChain implements KernelChain {
  height = 1
  finalityLag = 1
  /** Each block's mined transactions and their status. */
  readonly included = new Map<number, { hash: string; status: 'success' | 'reverted' }[]>()
  onMined?: (payload: TxPayload, block: number) => 'success' | 'reverted'
  /** While set, `latest` waits on it: the chain stalls. */
  stall?: Promise<void>
  /** While set, signing waits on it, after the kernel asked for the signature. */
  signing?: ReturnType<typeof gate>
  signed: string[] = []
  private mempool = new Map<number, { hash: string; payload: TxPayload }>()
  private mined = new Map<string, { block: number; status: 'success' | 'reverted' }>()
  private byNonce = new Map<number, string>()
  private nonce = 0
  private bytes = new Map<string, { payload: TxPayload; nonce: number }>()

  blockAt = (number: number): Block => ({
    number,
    hash: `0x${number.toString(16)}`,
    parentHash: `0x${(number - 1).toString(16)}`,
    timestamp: BigInt(number * 2)
  })

  /** Mines the next block; an empty one leaves every pending transaction pending. */
  mine(include = true) {
    this.height += 1
    const block: { hash: string; status: 'success' | 'reverted' }[] = []
    this.included.set(this.height, block)
    if (!include) return
    for (let tx = this.mempool.get(this.nonce); tx; tx = this.mempool.get(this.nonce)) {
      this.mempool.delete(this.nonce)
      const status = this.onMined?.(tx.payload, this.height) ?? 'success'
      this.mined.set(tx.hash, { block: this.height, status })
      this.byNonce.set(this.nonce, tx.hash)
      this.nonce += 1
      block.push({ hash: tx.hash, status })
    }
  }

  holdSigning() {
    this.signing = gate()
    return this.signing
  }

  latest = async () => {
    await this.stall
    return {
      head: this.blockAt(this.height),
      finalized: {
        number: this.height - this.finalityLag,
        timestamp: BigInt((this.height - this.finalityLag) * 2)
      }
    }
  }
  block = async (number: number) => this.blockAt(number)
  nonceAt = async () => ({ latest: this.nonce, pending: this.nonce + this.mempool.size })
  accountCode = async () => '0x'
  private evidence = (hash: string) => {
    const found = this.mined.get(hash)
    return found
      ? {
          block: found.block,
          blockHash: this.blockAt(found.block).hash,
          status: found.status,
          logs: []
        }
      : null
  }
  receipt = async (hash: string) => this.evidence(hash)
  nonceTx = async (nonce: number) => {
    const hash = this.byNonce.get(nonce)
    const found = hash === undefined ? null : this.evidence(hash)
    return hash && found ? { hash, ...found } : null
  }
  commitment = () => Promise.reject(new Error('no commitments on this chain'))
  capacity = async () => 0n

  effects: KernelEffects = {
    materialize: () => Promise.reject(new Error('nothing to materialize')),
    simulate: async () => true,
    signTx: async (payload, candidate, guard) => {
      await this.signing?.opened
      if (!guard.mayAct()) throw new Error('withdrawn before signing')
      const hash = `0x${candidate.nonce.toString(16).padStart(4, '0')}${candidate.level}`
      this.bytes.set(hash, { payload, nonce: candidate.nonce })
      this.signed.push(hash)
      return { hash, raw: hash }
    },
    signTyped: () => Promise.reject(new Error('no typed data here')),
    broadcast: async (raw, guard) => {
      const signed = this.bytes.get(raw)
      if (!signed) return 'rejected'
      if (!guard.mayAct()) throw new Error('withdrawn before sending')
      if (!this.byNonce.has(signed.nonce))
        this.mempool.set(signed.nonce, { hash: raw, payload: signed.payload })
      return 'accepted'
    },
    release: () => Promise.reject(new Error('no releases here'))
  }
}

/** A ledger in memory; `hold` keeps every later write waiting until it is released. */
export class MemoryStore implements LedgerStore {
  text: string | null = null
  writes = 0
  private held?: ReturnType<typeof gate>
  hold() {
    this.held = gate()
    return this.held
  }
  read = () => Promise.resolve(this.text === null ? null : (decodeLedger(this.text) as unknown))
  write = async (ledger: DurableLedger) => {
    await this.held?.opened
    this.text = encodeLedger(ledger)
    this.writes += 1
  }
}
