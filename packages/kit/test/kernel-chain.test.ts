import type { Hex } from 'viem'

import { createPublicClient, custom, numberToHex } from 'viem'
import { describe, expect, it } from 'vitest'

import { createKernelChain, parseFinality } from '../src/kernel-chain'

const ACCOUNT = '0x00000000000000000000000000000000000000aa'
const TX_HASH: Hex = `0x${'77'.repeat(32)}`
const hashOf = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`
const HEAD = 10
const MINED_IN = 5

type Chain = {
  /** The transactions each block reports holding. */
  blockTransactions?: (n: number) => { hash: Hex; from: string; nonce: Hex }[]
  receiptBlockHash?: Hex
  pendingHead?: boolean
}

const chainOf = (fake: Chain = {}) => {
  const transactions =
    fake.blockTransactions ??
    ((n: number) => (n === MINED_IN ? [{ hash: TX_HASH, from: ACCOUNT, nonce: '0x0' as Hex }] : []))
  const block = (n: number, full: boolean) => ({
    number: fake.pendingHead && n === HEAD ? null : numberToHex(n),
    hash: fake.pendingHead && n === HEAD ? null : hashOf(n),
    parentHash: hashOf(n - 1),
    timestamp: numberToHex(1_000 + n),
    transactions: full ? transactions(n) : []
  })
  const request = async ({ method, params }: { method: string; params?: unknown[] }) => {
    switch (method) {
      case 'eth_blockNumber':
        return numberToHex(HEAD)
      case 'eth_getTransactionCount':
        return numberToHex(Number(BigInt(params?.[1] as Hex)) >= MINED_IN ? 1 : 0)
      case 'eth_getBlockByNumber': {
        const tag = params?.[0] as string
        return block(
          tag === 'latest' ? HEAD : tag === 'safe' ? HEAD - 2 : Number(BigInt(tag)),
          Boolean(params?.[1])
        )
      }
      case 'eth_getTransactionReceipt':
        return {
          transactionHash: TX_HASH,
          blockHash: fake.receiptBlockHash ?? hashOf(MINED_IN),
          blockNumber: numberToHex(MINED_IN),
          status: '0x1',
          logs: []
        }
      default:
        throw new Error(`unexpected ${method}`)
    }
  }
  return createKernelChain({
    client: createPublicClient({ transport: custom({ request }, { retryCount: 0 }) }),
    account: ACCOUNT,
    finality: 'safe',
    commitment: () => Promise.reject(new Error('none'))
  })
}

describe('createKernelChain', () => {
  it('reads the head and the block the finality tag names', async () => {
    expect(await chainOf().latest()).toStrictEqual({
      head: { number: HEAD, hash: hashOf(HEAD), parentHash: hashOf(HEAD - 1), timestamp: 1_010n },
      finalized: { number: HEAD - 2, timestamp: 1_008n }
    })
  })

  it('refuses a pending block rather than reading it as the head', async () => {
    await expect(chainOf({ pendingHead: true }).latest()).rejects.toThrow(
      'chain returned a pending block'
    )
  })

  it('refuses a finality rule other than safe, finalized, or a non-negative integer depth', () => {
    for (const finality of ['latest', undefined, null, { depth: -1 }, { depth: 1.5 }])
      expect(() =>
        createKernelChain({
          client: createPublicClient({ transport: custom({ request: async () => null }) }),
          account: ACCOUNT,
          finality: finality as never,
          commitment: () => Promise.reject(new Error('none'))
        })
      ).toThrow('finality must be safe, finalized, or a non-negative integer depth')
  })

  it('finds the transaction that consumed a nonce, in the block that first counts it', async () => {
    expect(await chainOf().nonceTx(0)).toStrictEqual({
      hash: TX_HASH,
      block: MINED_IN,
      blockHash: hashOf(MINED_IN),
      status: 'success',
      logs: []
    })
    expect(await chainOf().nonceTx(1)).toBeNull()
  })

  it('throws when the receipt names another block than the one searched', async () => {
    await expect(chainOf({ receiptBlockHash: hashOf(99) }).nonceTx(0)).rejects.toThrow(
      'nonce lookup crossed a reorg'
    )
  })

  it('throws when the block that consumed the nonce holds no transaction from the account', async () => {
    const stranger = { hash: TX_HASH, from: `0x${'bb'.repeat(20)}`, nonce: '0x0' as Hex }
    await expect(
      chainOf({ blockTransactions: n => (n === MINED_IN ? [stranger] : []) }).nonceTx(0)
    ).rejects.toThrow('nonce lookup found no transaction')
  })
})

describe('parseFinality', () => {
  it('reads a tag or a positive depth and refuses anything else', () => {
    expect(parseFinality('safe')).toBe('safe')
    expect(parseFinality('finalized')).toBe('finalized')
    expect(parseFinality('12')).toStrictEqual({ depth: 12 })
    for (const bad of ['', 'latest', '0', '-1', '1.5', 'Safe', '1234567']) {
      expect(parseFinality(bad)).toBeUndefined()
    }
  })
})
