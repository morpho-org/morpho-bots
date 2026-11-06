import { createLogger } from '@repo/kit'
import {
  createPublicClient,
  http,
  MethodNotFoundRpcError,
  numberToHex,
  parseEther,
  parseGwei
} from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadConfig } from '../src/config'
import { liquidationFees, liquidatorAccount, liquidatorKernel } from '../src/kernel'

/** A node answering only what signing reads, estimating `gas` for every transaction. */
const mockRpc = (chainId: number, gas: bigint, l1Fee?: bigint, baseFee = 7n) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
    const body = JSON.parse(init?.body as string) as { id: number; method: string }
    const results: Record<string, unknown> = {
      eth_chainId: `0x${chainId.toString(16)}`,
      eth_estimateGas: `0x${gas.toString(16)}`,
      eth_getBlockByNumber: { baseFeePerGas: numberToHex(baseFee) },
      ...(l1Fee !== undefined && { eth_call: numberToHex(l1Fee, { size: 32 }) })
    }
    return body.method in results
      ? Response.json({ jsonrpc: '2.0', id: body.id, result: results[body.method] })
      : Response.json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: MethodNotFoundRpcError.code, message: `unmocked ${body.method}` }
        })
  }) as typeof fetch)

const guard = { signal: new AbortController().signal, mayAct: () => true }
const logger = createLogger('error', { env: {} })

const configOn = (chainId: number) =>
  loadConfig({
    CHAIN_ID: String(chainId),
    [`FINALITY_${chainId}`]: 'safe',
    RPC_URL: 'http://localhost:8545',
    LIQUIDATOR_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
    KERNEL_STATE_DIR: '/nonexistent',
    KERNEL_ENROLLMENT: 'enrolled',
    MAX_FEE_GWEI: '250',
    MAX_SPEND_ETH: '0.4',
    MAX_GAS_LIMIT: '12000000',
    ZEROX_API_KEY: 'zx-key',
    MORPHO_API_KEY: 'morpho-key'
  })

const kernelOn = (chainId: number) => {
  const config = configOn(chainId)
  const account = liquidatorAccount(config)
  return { account, ...liquidatorKernel({ config, account, logger }) }
}

describe('liquidatorKernel', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    { chainId: 8453, gas: 21_000n },
    { chainId: 1, gas: 21_000n }
  ])('signs the kernel nonce fill for chain id $chainId', async ({ chainId, gas }) => {
    const { account, live } = kernelOn(chainId)
    mockRpc(chainId, gas)
    await expect(
      live.effects.signTx(
        { kind: 'tx' as const, to: account.address, data: '0x' as const, value: 0n },
        {
          nonce: 0,
          level: 1,
          kind: 'fill',
          fee: live.config.feeReserve,
          recoveryFee: live.config.feeReserve
        },
        guard
      )
    ).resolves.toMatchObject({ hash: expect.stringMatching(/^0x/) })
  })

  it('converts each block window from a time, with floors that bind on mainnet', () => {
    const windows = (chainId: number) => {
      const { config, reorgDepth } = kernelOn(chainId).live
      return {
        maxEvidenceAgeBlocks: config.maxEvidenceAgeBlocks,
        stuckBlocks: config.stuckBlocks,
        reorgDepth
      }
    }
    expect(windows(8453)).toEqual({ maxEvidenceAgeBlocks: 500, stuckBlocks: 40, reorgDepth: 3_000 })
    expect(windows(1)).toEqual({ maxEvidenceAgeBlocks: 64, stuckBlocks: 1, reorgDepth: 128 })
  })
})

describe('liquidationFees', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    { chainId: 8453, l1Data: 5n },
    { chainId: 1, l1Data: 0n }
  ])(
    'prices the first bid the kernel signs, beside the L1 data fee only where one is charged: $chainId',
    async ({ chainId, l1Data }) => {
      const config = configOn(chainId)
      mockRpc(chainId, 100_000n, 5n)
      const client = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) })
      const fees = await liquidationFees(client, config, liquidatorAccount(config).address)('0x')
      expect(fees).toMatchObject({ l1Data, baseFee: 7n, gasLimit: 120_000n })
      expect(fees.firstBid(2_520_000n)).toStrictEqual({
        maxFeePerGas: 21n,
        maxPriorityFeePerGas: 7n,
        gas: 120_000n
      })
      expect(fees.firstBid(2_519_999n).gas).toBeLessThan(120_000n)
    }
  )

  const feesAt = async (gas: bigint, baseFee: bigint) => {
    const config = configOn(1)
    mockRpc(1, gas, undefined, baseFee)
    const client = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) })
    return liquidationFees(client, config, liquidatorAccount(config).address)('0x')
  }

  it('prices a first bid at the step cap, under a base fee between it and the policy cap', async () => {
    const fees = await feesAt(100_000n, parseGwei('230'))
    expect(fees.firstBid(parseEther('0.4')).maxFeePerGas).toBeLessThan(fees.baseFee)
  })

  it('funds a first bid with no more than MAX_SPEND_ETH, however large the profit', async () => {
    const fees = await feesAt(3_000_000n, parseGwei('100'))
    expect(fees.firstBid(parseEther('1')).gas).toBeLessThan(fees.gasLimit)
  })
})
