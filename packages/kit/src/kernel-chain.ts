import type { Block, KernelChain, Log } from '@repo/kernel'
import type { Address, BlockTag, Client, Hex } from 'viem'

import { hexToBigInt, isAddressEqual, numberToHex, TransactionReceiptNotFoundError } from 'viem'
import { getBlock, getBlockNumber, getCode, getTransactionReceipt } from 'viem/actions'

/**
 * Which block the kernel treats as final: a finality tag the chain serves, or a fixed depth below
 * the head for a chain without one.
 */
export type Finality = 'safe' | 'finalized' | { depth: number }

/** Reads a {@link Finality} from its config spelling: `safe`, `finalized`, or a positive depth. */
export const parseFinality = (value: string): Finality | undefined => {
  if (value === 'safe' || value === 'finalized') return value
  if (/^[1-9]\d{0,5}$/.test(value)) return { depth: Number(value) }
  return undefined
}

const toBlock = (block: {
  number: bigint | null
  hash: Hex | null
  parentHash: Hex
  timestamp: bigint
}): Block => {
  if (block.number === null || block.hash === null)
    throw new Error('chain returned a pending block')
  return {
    number: Number(block.number),
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: block.timestamp
  }
}

const toLogs = (logs: readonly { address: Hex; topics: readonly Hex[]; data: Hex }[]): Log[] =>
  logs.map(({ address, topics, data }) => ({ address, topics: [...topics], data }))

const pinnedTo = (hash: Hex) => ({ blockHash: hash, requireCanonical: true })

/**
 * The block parameter of a viem call pinned to one block by hash (EIP-1898): viem types `blockTag`
 * as a tag but sends it as given. https://eips.ethereum.org/EIPS/eip-1898
 */
export const blockTagAt = (hash: Hex) => pinnedTo(hash) as unknown as BlockTag

/** An `eth_call` pinned to one block by hash (EIP-1898), so a numeric tag can never pick another fork. */
export const callAt = (
  client: Client,
  at: Pick<Block, 'hash'>,
  call: { from?: Address; to: Address; data: Hex; value?: bigint }
): Promise<Hex> =>
  client.request({
    method: 'eth_call',
    params: [
      { from: call.from, to: call.to, data: call.data, value: numberToHex(call.value ?? 0n) },
      pinnedTo(at.hash as Hex)
    ]
  })

/**
 * The kernel's own chain reads over viem. Every read at a block is pinned by its hash; the
 * protocol's commitment and capacity reads are the bot's, built with {@link callAt}.
 */
export const createKernelChain = (options: {
  client: Client
  account: Address
  finality: Finality
  commitment: KernelChain['commitment']
  capacity?: KernelChain['capacity']
}): KernelChain => {
  const { client, account, finality } = options
  const validFinality =
    finality === 'safe' ||
    finality === 'finalized' ||
    (typeof finality === 'object' &&
      finality !== null &&
      Number.isSafeInteger(finality.depth) &&
      finality.depth >= 0)
  if (!validFinality)
    throw new TypeError('finality must be safe, finalized, or a non-negative integer depth')

  const countAt = async (blockNumber: bigint) =>
    Number(
      hexToBigInt(
        await client.request({
          method: 'eth_getTransactionCount',
          params: [account, numberToHex(blockNumber)]
        })
      )
    )

  const finalizedOf = async (head: Block) => {
    if (typeof finality === 'string') {
      const block = toBlock(await getBlock(client, { blockTag: finality }))
      return { number: block.number, timestamp: block.timestamp }
    }
    const number = Math.max(0, head.number - finality.depth)
    const block = toBlock(await getBlock(client, { blockNumber: BigInt(number) }))
    return { number, timestamp: block.timestamp }
  }

  return {
    latest: async () => {
      const head = toBlock(await getBlock(client, { blockTag: 'latest' }))
      return { head, finalized: await finalizedOf(head) }
    },
    block: async number => toBlock(await getBlock(client, { blockNumber: BigInt(number) })),
    nonceAt: async at => {
      const [latest, pending] = await Promise.all([
        client.request({
          method: 'eth_getTransactionCount',
          params: [account, { blockHash: at.hash as Hex, requireCanonical: true }]
        }),
        client.request({ method: 'eth_getTransactionCount', params: [account, 'pending'] })
      ])
      return { latest: Number(hexToBigInt(latest)), pending: Number(hexToBigInt(pending)) }
    },
    accountCode: async () => (await getCode(client, { address: account })) ?? '0x',
    receipt: async hash => {
      try {
        const receipt = await getTransactionReceipt(client, { hash: hash as Hex })
        return {
          block: Number(receipt.blockNumber),
          blockHash: receipt.blockHash,
          status: receipt.status,
          logs: toLogs(receipt.logs)
        }
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null
        throw error
      }
    },
    nonceTx: async nonce => {
      let high = await getBlockNumber(client, { cacheTime: 0 })
      if ((await countAt(high)) <= nonce) return null
      let low = 0n
      while (low < high) {
        const middle = (low + high) / 2n
        if ((await countAt(middle)) > nonce) high = middle
        else low = middle + 1n
      }
      const block = await getBlock(client, { blockNumber: high, includeTransactions: true })
      const transaction = block.transactions.find(
        t => isAddressEqual(t.from, account) && t.nonce === nonce
      )
      if (!transaction || block.hash === null) throw new Error('nonce lookup found no transaction')
      const receipt = await getTransactionReceipt(client, { hash: transaction.hash })
      if (receipt.blockHash !== block.hash) throw new Error('nonce lookup crossed a reorg')
      return {
        hash: transaction.hash,
        block: Number(high),
        blockHash: block.hash,
        status: receipt.status,
        logs: toLogs(receipt.logs)
      }
    },
    commitment: options.commitment,
    capacity: options.capacity ?? (() => Promise.reject(new Error('no observed resources')))
  }
}
