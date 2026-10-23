import type { BotLogger, LogLevel } from '@repo/kit'
import type { Address, Hex } from 'viem'

import { metaMorphoAbi } from '@morpho-org/blue-sdk-viem'
import {
  DEFAULT_MAX_DATA_BYTES,
  DEFAULT_MAX_GAS_LIMIT,
  NoCommitmentsError,
  NONCE_FILL_MAX_GAS,
  PolicyViolationError
} from '@repo/kit'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFunctionData, MethodNotFoundRpcError, parseGwei, parseTransaction } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadConfig } from '../src/config'
import { reallocatorKernel } from '../src/kernel'

const VAULT: Address = '0x1111111111111111111111111111111111111111'
const STRANGER: Address = '0x2222222222222222222222222222222222222222'
// Throwaway well-known test key (anvil account #0) — never used to hold funds.
const PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const account = privateKeyToAccount(PRIVATE_KEY)
const MAX_FEE_PER_GAS_WEI = parseGwei('250')
const MAX_SPEND_WEI = MAX_FEE_PER_GAS_WEI * DEFAULT_MAX_GAS_LIMIT
const REALLOCATE = encodeFunctionData({
  abi: metaMorphoAbi,
  functionName: 'reallocate',
  args: [[]]
})
const MULTICALL = encodeFunctionData({ abi: metaMorphoAbi, functionName: 'multicall', args: [[]] })
const BLOCK = {
  number: '0x10',
  hash: `0x${'ab'.repeat(32)}`,
  parentHash: `0x${'cd'.repeat(32)}`,
  timestamp: '0x5',
  baseFeePerGas: '0x7',
  transactions: []
}
const guard = { signal: new AbortController().signal, mayAct: () => true }

/** A node answering only what signing and head reads need, with `gas` as its estimate. */
const mockRpc = (gas = 100_000n) => {
  const blockTags: unknown[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (_url, init) => {
    const body = JSON.parse(init?.body as string) as {
      id: number
      method: string
      params: unknown[]
    }
    if (body.method === 'eth_getBlockByNumber') blockTags.push(body.params[0])
    const results: Record<string, unknown> = {
      eth_chainId: `0x${base.id.toString(16)}`,
      eth_estimateGas: `0x${gas.toString(16)}`,
      eth_getBlockByNumber: BLOCK
    }
    return body.method in results
      ? Response.json({ jsonrpc: '2.0', id: body.id, result: results[body.method] })
      : Response.json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: MethodNotFoundRpcError.code, message: `unmocked ${body.method}` }
        })
  }) as typeof fetch)
  return blockTags
}

let stateDirectory: string
beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'vault-v1-kernel-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(stateDirectory, { recursive: true, force: true })
})

const kernel = () => {
  const warnings: { event: string; fields: unknown }[] = []
  const log = (level: LogLevel) => (event: string, fields?: unknown) => {
    if (level === 'warn') warnings.push({ event, fields })
  }
  const logger = {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error')
  } as unknown as BotLogger
  const config = loadConfig({
    CHAIN_ID: String(base.id),
    FINALITY_8453: 'safe',
    RPC_URL: 'http://localhost:8545',
    REALLOCATOR_PRIVATE_KEY: PRIVATE_KEY,
    VAULT_WHITELIST: VAULT,
    KERNEL_STATE_DIR: stateDirectory,
    KERNEL_ENROLLMENT: 'enrolling',
    MAX_FEE_GWEI: '250'
  })
  return { ...reallocatorKernel({ config, account, logger }), warnings }
}

const sign = (to: Address, data: Hex, fee = MAX_SPEND_WEI) =>
  kernel().live.effects.signTx(
    { kind: 'tx', to, data, value: 0n },
    { nonce: 0, fee, level: 1 },
    guard
  )

describe('reallocatorKernel', () => {
  it('builds the kernel config for the whitelisted vaults from the loaded config', () => {
    const { feePolicy, validators, ...config } = kernel().live.config
    expect(config).toStrictEqual({
      chainId: base.id,
      account: account.address,
      policy: { targets: [VAULT], recoveryTargets: [] },
      caps: { native: 4n * MAX_SPEND_WEI },
      observedResources: [],
      feeReserve: MAX_SPEND_WEI,
      maxSimLagBlocks: 3,
      stuckBlocks: 4,
      maxEvidenceAgeBlocks: 1200,
      latchBoundBlocks: 100,
      recoveryBoundMs: 15 * 60_000,
      revokeAfterStaleMs: 60 * 60_000,
      maxRecoveryAttempts: 3,
      maxDispatchLagMs: 10_000
    })
    expect(feePolicy({} as Parameters<typeof feePolicy>[0])).toBe(MAX_SPEND_WEI)
    expect(validators.map(validator => validator.id)).toStrictEqual(['vault-v1-reallocation'])
    const claims = (to: Address) => validators[0]?.claims({ kind: 'tx', to, data: '0x', value: 0n })
    expect([claims(VAULT), claims(STRANGER)]).toStrictEqual([true, false])
  })

  it('hosts the kernel with the configured enrollment and fixed host bounds', () => {
    const { live } = kernel()
    expect({
      enrollment: live.enrollment,
      pollMs: live.pollMs,
      effectTimeoutMs: live.effectTimeoutMs,
      reorgDepth: live.reorgDepth
    }).toStrictEqual({
      enrollment: 'enrolling',
      pollMs: 1_000,
      effectTimeoutMs: 10_000,
      reorgDepth: 64
    })
  })

  it('keeps its ledger per chain and account under the state directory', async () => {
    const ledger = join(stateDirectory, `kernel-${base.id}-${account.address.toLowerCase()}.json`)
    await writeFile(ledger, '{"pinned":true}')
    await expect(kernel().live.store.read()).resolves.toStrictEqual({ pinned: true })
  })

  it('reads finality at the safe tag and refuses every commitment', async () => {
    const blockTags = mockRpc()
    const { chain, effects } = kernel().live
    await chain.latest()
    expect(blockTags).toStrictEqual(['latest', 'safe'])
    await expect(chain.commitment({} as never, {} as never)).rejects.toBeInstanceOf(
      NoCommitmentsError
    )
    await expect(effects.materialize({} as never, {} as never)).rejects.toBeInstanceOf(
      NoCommitmentsError
    )
  })

  it('logs a kernel error by source and error name only', () => {
    const { live, warnings } = kernel()
    live.onError('chain', new TypeError('https://secret.example/key'))
    live.onError('effect', 'opaque')
    expect(warnings).toStrictEqual([
      {
        event: 'kernel.error',
        fields: { source: 'chain', errorName: 'TypeError', reason: 'TypeError' }
      },
      {
        event: 'kernel.error',
        fields: { source: 'effect', errorName: 'UnknownError', reason: 'UnknownError' }
      }
    ])
  })

  it('signs a reallocate to a whitelisted vault, tipping 1 gwei first and bidding at most the fee ceiling', async () => {
    mockRpc()
    const { live, feesOf } = kernel()
    const signAt = (nonce: number, level: number) =>
      live.effects.signTx(
        { kind: 'tx', to: VAULT, data: REALLOCATE, value: 0n },
        { nonce, fee: MAX_SPEND_WEI, level },
        guard
      )
    const first = await signAt(0, 1)
    expect(parseTransaction(first.raw as Hex).to).toBe(VAULT)
    expect(feesOf(first.hash)?.priorityFeePerGasWei).toBe(parseGwei('1'))
    const unpricedReplacement = await signAt(1, 2)
    expect(feesOf(unpricedReplacement.hash)).toStrictEqual({
      maxFeePerGasWei: MAX_FEE_PER_GAS_WEI,
      priorityFeePerGasWei: MAX_FEE_PER_GAS_WEI
    })
  })

  it.each([
    ['a vault off the whitelist', STRANGER, REALLOCATE, 100_000n, 'target'],
    ['a multicall on the vault', VAULT, MULTICALL, 100_000n, 'selector'],
    ['gas above the ceiling', VAULT, REALLOCATE, DEFAULT_MAX_GAS_LIMIT + 1n, 'gas'],
    [
      'calldata above the size ceiling',
      VAULT,
      `${REALLOCATE}${'00'.repeat(DEFAULT_MAX_DATA_BYTES)}` as Hex,
      100_000n,
      'maxDataBytes'
    ]
  ])('refuses to sign %s', async (_, to, data, gas, check) => {
    mockRpc(gas)
    await expect(sign(to, data)).rejects.toMatchObject({
      constructor: PolicyViolationError,
      check
    })
  })

  it('signs the kernel nonce fill, and refuses one above its gas bound', async () => {
    mockRpc(21_000n)
    await expect(sign(account.address, '0x')).resolves.toMatchObject({
      hash: expect.stringMatching(/^0x/)
    })
    vi.restoreAllMocks()
    mockRpc(NONCE_FILL_MAX_GAS + 1n)
    await expect(sign(account.address, '0x')).rejects.toMatchObject({
      constructor: PolicyViolationError,
      check: 'gas'
    })
  })
})
