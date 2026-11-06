import type { Hex } from 'viem'

import { createLogger, PolicyViolationError } from '@repo/kit'
import { encodeFunctionData, erc20Abi, MethodNotFoundRpcError } from 'viem'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WriteConfig } from '../src/config'

import { loadConfig } from '../src/config'
import { resolverAccount, resolverKernel } from '../src/kernel'
import { crossedBook, marketAt, resolutionOf } from './scenario/bot'

/** A node answering only what signing reads, estimating `gas` for every transaction. */
const mockRpc = (gas: bigint) =>
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
    const body = JSON.parse(init?.body as string) as { id: number; method: string }
    const results: Record<string, unknown> = {
      eth_chainId: '0x2105',
      eth_estimateGas: `0x${gas.toString(16)}`,
      eth_getBlockByNumber: { baseFeePerGas: '0x7' }
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

const kernel = () => {
  const config = loadConfig({
    CHAIN_ID: '8453',
    FINALITY_8453: 'safe',
    RPC_URL: 'http://localhost:8545',
    RESOLVER_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
    KERNEL_STATE_DIR: '/nonexistent',
    KERNEL_ENROLLMENT: 'enrolled',
    MAX_FEE_GWEI: '0.5',
    MAX_SPEND_ETH: '0.0075',
    MAX_GAS_LIMIT: '15000000'
  })
  const mode = config.mode as WriteConfig
  const account = resolverAccount(mode)
  return { config, account, ...resolverKernel({ config, mode, account, logger }) }
}

describe('resolverKernel', () => {
  afterEach(() => vi.restoreAllMocks())

  const sign = (to: string, data: Hex) => {
    const { live } = kernel()
    return live.effects.signTx(
      { kind: 'tx', to, data, value: 0n },
      {
        nonce: 0,
        level: 1,
        kind: 'step',
        fee: live.config.feeReserve,
        recoveryFee: live.config.feeReserve
      },
      guard
    )
  }

  it('signs a resolution to the resolver', async () => {
    const { config } = kernel()
    mockRpc(500_000n)
    await expect(
      sign(config.resolver, resolutionOf(crossedBook(marketAt(1))))
    ).resolves.toMatchObject({ hash: expect.stringMatching(/^0x/) })
  })

  it('signs the kernel nonce fill', async () => {
    const { account } = kernel()
    mockRpc(21_000n)
    await expect(sign(account.address, '0x')).resolves.toMatchObject({
      hash: expect.stringMatching(/^0x/)
    })
  })

  it.each([
    ['another function on the resolver', 'resolver', 'selector'],
    ['a resolution to another target', 'elsewhere', 'target']
  ] as const)('refuses to sign %s at the signer', async (_, target, check) => {
    const { config } = kernel()
    mockRpc(500_000n)
    const approve = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [config.midnight, 1n]
    })
    const [to, data] =
      target === 'resolver'
        ? [config.resolver, approve]
        : [config.midnight, resolutionOf(crossedBook(marketAt(1)))]
    await expect(sign(to, data)).rejects.toThrow(
      expect.objectContaining({ constructor: PolicyViolationError, check })
    )
  })

  it("claims the resolver's transactions with the crossed-books validator", () => {
    const { config, live } = kernel()
    const [validator] = live.config.validators

    expect(validator?.id).toBe('crossed-books')
    expect(validator?.claims({ kind: 'tx', to: config.resolver, data: '0x', value: 0n })).toBe(true)
    expect(live.config.policy.targets).toStrictEqual([config.resolver])
  })

  it('converts each block window from a time in Base blocks', () => {
    const { config, reorgDepth } = kernel().live
    expect({
      maxEvidenceAgeBlocks: config.maxEvidenceAgeBlocks,
      maxSimLagBlocks: config.maxSimLagBlocks,
      stuckBlocks: config.stuckBlocks,
      reorgDepth
    }).toEqual({
      maxEvidenceAgeBlocks: 310,
      maxSimLagBlocks: 30,
      stuckBlocks: 40,
      reorgDepth: 3_000
    })
  })
})
