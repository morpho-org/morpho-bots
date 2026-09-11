import type { Hex, LocalAccount } from 'viem'

import { getChainAddress } from '@morpho-org/morpho-ts'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { ConfigService } from '../../../src/config/config.service'
import { createQuoterTransactionExecutor } from '../../../src/infrastructure/transaction/quoter-transaction-executor'

const privateKey: Hex = `0x${'11'.repeat(32)}`
const baseAccount = privateKeyToAccount(privateKey)
const midnight = '0x2222222222222222222222222222222222222222'

const environment = {
  CHAIN_ID: '8453',
  RPC_URL: 'https://rpc.example',
  MAKER_PRIVATE_KEY: privateKey,
  MAKER_ADDRESS: baseAccount.address,
  MIDNIGHT_ADDRESS: midnight,
  LOAN_ASSET_ADDRESS: '0x3333333333333333333333333333333333333333',
  RATIFIER_ADDRESS: getChainAddress(8453, 'ecrecoverRatifier'),
  MARKET_IDS: `0x${'55'.repeat(32)}`,
  NATIVE_RESERVE_WEI: '1',
  MAX_FEE_GWEI: '100',
  PRIORITY_FEE_GWEI: '1',
  MAX_TRANSACTION_SPEND_WEI: '100000000000000000',
  MAX_PUBLICATION_GAS: '5000000',
  MAX_PUBLICATION_DATA_BYTES: '65536',
  MAX_CANCELLATION_GAS: '100000',
  MAX_BATCH_CANCELLATION_GAS: '1000000',
  MAX_BATCH_CANCELLATION_DATA_BYTES: '65536',
  MORPHO_API_BASE_URL: 'https://api.example'
}
const config = ConfigService.from(environment)

type RpcBody = { id: number; method: string; params?: unknown[] }

const rpcBody = (body: BodyInit | null | undefined): RpcBody => {
  if (typeof body !== 'string') throw new Error('expected string RPC body')
  return JSON.parse(body) as RpcBody
}

const accountWithSigningProbe = () => {
  const signTransaction = vi.fn(baseAccount.signTransaction)
  return {
    account: { ...baseAccount, signTransaction } as LocalAccount,
    signTransaction
  }
}

describe('createQuoterTransactionExecutor', () => {
  afterEach(() => vi.restoreAllMocks())

  test('does not sign or broadcast when exact simulation fails', async () => {
    const { account, signTransaction } = accountWithSigningProbe()
    let broadcasts = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = rpcBody(init?.body)
      if (body.method === 'eth_call') {
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: 3, message: 'execution reverted' }
        })
      }
      if (body.method === 'eth_sendRawTransaction') broadcasts += 1
      throw new Error(`unexpected RPC method ${body.method}`)
    })

    await expect(
      createQuoterTransactionExecutor(config, account).execute({
        transaction: {
          to: getChainAddress(8453, 'midnightMempool'),
          data: '0xdeadbeef',
          value: 0n
        },
        operation: 'publish',
        label: 'test:simulation'
      })
    ).rejects.toMatchObject({ operation: 'simulation-reverted' })
    expect(signTransaction).not.toHaveBeenCalled()
    expect(broadcasts).toBe(0)
  })

  test('refuses startup when the signer has an unknown pending nonce', async () => {
    const { account, signTransaction } = accountWithSigningProbe()
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = rpcBody(init?.body)
      if (body.method !== 'eth_getTransactionCount') {
        throw new Error(`unexpected RPC method ${body.method}`)
      }
      const result = body.params?.[1] === 'pending' ? '0x1' : '0x0'
      return Response.json({ jsonrpc: '2.0', id: body.id, result })
    })

    await expect(
      createQuoterTransactionExecutor(config, account).assertNoPendingNonce()
    ).rejects.toMatchObject({ operation: 'unknown-pending-nonce' })
    expect(signTransaction).not.toHaveBeenCalled()
  })

  test('does not sign or broadcast a prepared transaction outside the data policy', async () => {
    const { account, signTransaction } = accountWithSigningProbe()
    let broadcasts = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = rpcBody(init?.body)
      const result =
        body.method === 'eth_call'
          ? '0x'
          : body.method === 'eth_getBlockByNumber'
            ? { baseFeePerGas: '0x1', number: '0x1' }
            : body.method === 'eth_getTransactionCount'
              ? '0x0'
              : body.method === 'eth_estimateGas'
                ? '0x5208'
                : body.method === 'eth_chainId'
                  ? '0x2105'
                  : undefined
      if (body.method === 'eth_sendRawTransaction') broadcasts += 1
      if (result === undefined) throw new Error(`unexpected RPC method ${body.method}`)
      return Response.json({ jsonrpc: '2.0', id: body.id, result })
    })

    await expect(
      createQuoterTransactionExecutor(config, account).execute({
        transaction: {
          to: getChainAddress(8453, 'midnightMempool'),
          data: `0x${'ff'.repeat(65_537)}`,
          value: 0n
        },
        operation: 'publish',
        label: 'test:policy'
      })
    ).rejects.toMatchObject({ operation: 'submission-refused' })
    expect(signTransaction).not.toHaveBeenCalled()
    expect(broadcasts).toBe(0)
  })

  test('retains a timed-out transaction and refuses later writes', async () => {
    const { account, signTransaction } = accountWithSigningProbe()
    let broadcasts = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = rpcBody(init?.body)
      const result =
        body.method === 'eth_call'
          ? '0x'
          : body.method === 'eth_getBlockByNumber'
            ? { baseFeePerGas: '0x1', number: '0x1' }
            : body.method === 'eth_getTransactionCount'
              ? '0x0'
              : body.method === 'eth_estimateGas'
                ? '0x5208'
                : body.method === 'eth_chainId'
                  ? '0x2105'
                  : body.method === 'eth_sendRawTransaction'
                    ? `0x${'ab'.repeat(32)}`
                    : body.method === 'eth_blockNumber'
                      ? '0x1'
                      : body.method === 'eth_getTransactionReceipt'
                        ? null
                        : undefined
      if (body.method === 'eth_sendRawTransaction') broadcasts += 1
      if (result === undefined) throw new Error(`unexpected RPC method ${body.method}`)
      return Response.json({ jsonrpc: '2.0', id: body.id, result })
    })
    const executor = createQuoterTransactionExecutor(
      ConfigService.from({ ...environment, TRANSACTION_RECEIPT_TIMEOUT_MS: '1' }),
      account
    )
    const request = {
      transaction: {
        to: getChainAddress(8453, 'midnightMempool'),
        data: '0xdeadbeef' as Hex,
        value: 0n
      },
      operation: 'publish' as const,
      label: 'test:timeout'
    }

    await expect(executor.execute(request)).rejects.toMatchObject({
      operation: 'transaction-pending'
    })
    await expect(executor.execute(request)).rejects.toMatchObject({
      operation: 'reconciliation-required'
    })
    expect(signTransaction).toHaveBeenCalledTimes(1)
    expect(broadcasts).toBe(1)
  })
})
