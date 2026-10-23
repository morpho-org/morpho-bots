import type { TxPayload, Validator } from '@repo/kernel'
import type { Hex } from 'viem'

import {
  BaseError,
  createPublicClient,
  http,
  keccak256,
  MethodNotFoundRpcError,
  parseTransaction
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { base } from 'viem/chains'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BotLogger, LogLevel } from '../src/logger'
import type { TransactionKernelLimits } from '../src/transaction-kernel'

import { FeeLimitError, PolicyViolationError } from '../src/errors'
import { EXECUTOR_SELECTOR, NONCE_FILL_MAX_GAS } from '../src/policy'
import { transactionKernelConfig, transactionKernelSpec } from '../src/transaction-kernel'

// Throwaway well-known test key (anvil account #0) — never used to hold funds.
const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
)
const EXECUTOR = `0x${'11'.repeat(20)}` as const
const STRANGER = `0x${'22'.repeat(20)}` as const
const RPC_URL = 'http://localhost:8545'
const GAS = 21_000n

const LIMITS: TransactionKernelLimits = {
  chainId: base.id,
  targets: [EXECUTOR],
  selector: EXECUTOR_SELECTOR,
  maxFeePerGasWei: 100n,
  maxSpendWei: 50n * GAS,
  maxGasLimit: 1_000_000n,
  priorityFeePerGasWei: 1n,
  stuckBlocks: 5,
  maxEvidenceAgeBlocks: 64
}

const validator = { id: 'test-validator' } as unknown as Validator

function mockRpc(estimateGas: bigint = GAS) {
  const answers: Record<string, unknown> = {
    eth_chainId: `0x${base.id.toString(16)}`,
    eth_estimateGas: `0x${estimateGas.toString(16)}`,
    // A base fee high enough that a first bid is the whole per-gas ceiling.
    eth_getBlockByNumber: { baseFeePerGas: '0x3e8' }
  }
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (
    _url: unknown,
    init?: { body?: string }
  ) => {
    const body = JSON.parse(init?.body ?? '{}') as { id: number; method: string }
    return body.method in answers
      ? Response.json({ jsonrpc: '2.0', id: body.id, result: answers[body.method] })
      : Response.json({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: MethodNotFoundRpcError.code, message: `unmocked ${body.method}` }
        })
  }) as unknown as typeof fetch)
}

function captureLogger() {
  const events: { level: LogLevel; event: string; fields?: Record<string, unknown> }[] = []
  const make = (level: LogLevel) => (event: string, fields?: Record<string, unknown>) => {
    events.push({ level, event, fields })
  }
  const logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error')
  } as unknown as BotLogger
  return { logger, events }
}

const spec = (limits: TransactionKernelLimits = LIMITS) => {
  const { logger, events } = captureLogger()
  const kernel = transactionKernelSpec({
    limits,
    validator,
    account,
    chain: base,
    client: createPublicClient({ chain: base, transport: http(RPC_URL, { retryCount: 0 }) }),
    rpcUrl: RPC_URL,
    stateDirectory: '/nonexistent',
    enrollment: 'enrolled',
    effectTimeoutMs: 1_000,
    finality: 'safe',
    logger
  })
  return { ...kernel, events }
}

const guard = { signal: new AbortController().signal, mayAct: () => true }
const exec: Hex = `${EXECUTOR_SELECTOR}${'00'.repeat(64)}`

const signTx = (
  kernel: ReturnType<typeof spec>,
  payload: { to: string; data: string },
  fee = LIMITS.maxSpendWei
) =>
  kernel.live.effects.signTx(
    { kind: 'tx', ...payload, value: 0n },
    { nonce: 3, fee, level: 1 },
    guard
  )

describe('transactionKernelConfig', () => {
  it('authorizes only its targets and caps native exposure at four spend ceilings', () => {
    const config = transactionKernelConfig(LIMITS, account.address, validator)
    expect(config.chainId).toBe(base.id)
    expect(config.account).toBe(account.address)
    expect(config.validators).toStrictEqual([validator])
    expect(config.policy).toStrictEqual({ targets: [EXECUTOR], recoveryTargets: [] })
    expect(config.caps).toStrictEqual({ native: 4n * LIMITS.maxSpendWei })
    expect(config.feeReserve).toBe(LIMITS.maxSpendWei)
    expect(config.stuckBlocks).toBe(LIMITS.stuckBlocks)
  })
})

describe('transactionKernelSpec construction', () => {
  it('refuses an invalid required finality rule at construction', () => {
    const { logger } = captureLogger()
    expect(() =>
      transactionKernelSpec({
        limits: LIMITS,
        validator,
        account,
        chain: base,
        client: createPublicClient({ chain: base, transport: http(RPC_URL) }),
        rpcUrl: RPC_URL,
        stateDirectory: '/nonexistent',
        enrollment: 'enrolled',
        effectTimeoutMs: 1_000,
        finality: 'latest' as never,
        logger
      })
    ).toThrow('finality must be safe, finalized, or a non-negative integer depth')
  })

  it('logs a safe reason with a kernel error without renaming existing fields', () => {
    const kernel = spec()
    kernel.live.onError(
      'effect',
      new Error('request to https://user:secret@example.com/rpc failed')
    )
    expect(kernel.events).toStrictEqual([
      {
        level: 'warn',
        event: 'kernel.error',
        fields: { source: 'effect', errorName: 'Error', reason: 'Error' }
      }
    ])
    expect(JSON.stringify(kernel.events)).not.toContain('secret')
  })

  it("logs a fee refusal's own message, which names the limit to raise", () => {
    const kernel = spec()
    kernel.live.onError(
      'effect',
      new FeeLimitError('the fee ceiling cannot fund the estimated gas')
    )
    expect(kernel.events[0]).toMatchObject({
      fields: {
        errorName: 'FeeLimitError',
        reason: 'the fee ceiling cannot fund the estimated gas'
      }
    })
  })

  it('strips credentialed URLs from a viem error short message', () => {
    const kernel = spec()
    kernel.live.onError(
      'effect',
      new BaseError('request to https://user:secret@example.com/rpc?apiKey=token failed')
    )
    expect(kernel.events[0]).toMatchObject({
      fields: { reason: 'request to [redacted URL] failed' }
    })
    expect(JSON.stringify(kernel.events)).not.toMatch(/secret|apiKey|token|https:/)
  })
})

describe('transactionKernelSpec signer policy', () => {
  afterEach(() => vi.restoreAllMocks())

  it('signs an exec_606BaXt call to the Executor within its ceilings, and remembers its fees', async () => {
    mockRpc()
    const kernel = spec()
    const signed = await signTx(kernel, { to: EXECUTOR, data: exec })

    const tx = parseTransaction(signed.raw as Hex)
    expect(signed.hash).toBe(keccak256(signed.raw as Hex))
    expect(tx.to).toBe(EXECUTOR)
    expect(tx.data).toBe(exec)
    expect(tx.gas).toBe(GAS)
    expect(tx.maxFeePerGas).toBe(LIMITS.maxSpendWei / GAS)
    expect(kernel.feesOf(signed.hash)).toStrictEqual({
      maxFeePerGasWei: LIMITS.maxSpendWei / GAS,
      priorityFeePerGasWei: LIMITS.priorityFeePerGasWei
    })
  })

  it.each([
    { name: 'another target', to: STRANGER, data: exec, check: 'target' },
    {
      name: 'another selector',
      to: EXECUTOR,
      data: `0x12345678${'00'.repeat(64)}`,
      check: 'selector'
    },
    {
      name: 'calldata over 64 KiB',
      to: EXECUTOR,
      data: `${EXECUTOR_SELECTOR}${'00'.repeat(65_536)}`,
      check: 'maxDataBytes'
    }
  ])('refuses $name before signing', async ({ to, data, check }) => {
    mockRpc()
    const kernel = spec()
    const refusal = signTx(kernel, { to, data })
    await expect(refusal).rejects.toBeInstanceOf(PolicyViolationError)
    await expect(refusal).rejects.toMatchObject({ check })
    expect(kernel.events.map(e => [e.level, e.event, e.fields?.check])).toStrictEqual([
      ['error', 'signer.policy_violation', check]
    ])
  })

  it('refuses a fee the kernel offers past the spend ceiling', async () => {
    mockRpc()
    await expect(
      signTx(spec(), { to: EXECUTOR, data: exec }, LIMITS.maxFeePerGasWei * GAS)
    ).rejects.toMatchObject({ check: 'spend' })
  })

  it('refuses gas above the gas ceiling', async () => {
    mockRpc(LIMITS.maxGasLimit + 1n)
    await expect(
      signTx(spec(), { to: EXECUTOR, data: exec }, LIMITS.maxSpendWei * 1_000n)
    ).rejects.toMatchObject({ check: 'gas' })
  })

  it('keeps the targets it was built with when the caller later changes its list', async () => {
    mockRpc()
    const targets = [EXECUTOR]
    const kernel = spec({ ...LIMITS, targets })
    targets.push(STRANGER)
    expect(kernel.live.config.policy.targets).toStrictEqual([EXECUTOR])
    await expect(signTx(kernel, { to: STRANGER, data: exec })).rejects.toMatchObject({
      check: 'target'
    })
  })

  it('pins the configured selector', async () => {
    mockRpc()
    const selector = '0xabcdef01'
    const kernel = spec({ ...LIMITS, selector })
    await expect(signTx(kernel, { to: EXECUTOR, data: exec })).rejects.toMatchObject({
      check: 'selector'
    })
    const signed = await signTx(kernel, { to: EXECUTOR, data: `${selector}${'00'.repeat(4)}` })
    expect(parseTransaction(signed.raw as Hex).to).toBe(EXECUTOR)
  })

  describe('nonce fill', () => {
    const fill: TxPayload = { kind: 'tx', to: account.address, data: '0x', value: 0n }
    const signFill = (kernel: ReturnType<typeof spec>, payload = fill) =>
      kernel.live.effects.signTx(payload, { nonce: 3, fee: LIMITS.maxSpendWei, level: 1 }, guard)

    it.each([
      ['exec_606BaXt', LIMITS],
      ['a configured selector', { ...LIMITS, selector: '0xabcdef01' as const }]
    ])('signs the kernel fill for an Executor pinned to %s', async (_, limits) => {
      mockRpc()
      const signed = await signFill(spec(limits))
      const tx = parseTransaction(signed.raw as Hex)
      expect(tx.to).toBe(account.address.toLowerCase())
      expect(tx.value ?? 0n).toBe(0n)
      expect(tx.data ?? '0x').toBe('0x')
      expect(tx.gas).toBe(GAS)
    })

    it.each([
      { name: 'calldata', payload: { ...fill, data: '0x00' }, gas: GAS, check: 'maxDataBytes' },
      { name: 'another target', payload: { ...fill, to: STRANGER }, gas: GAS, check: 'target' },
      {
        name: 'gas above the fill bound',
        payload: fill,
        gas: NONCE_FILL_MAX_GAS + 1n,
        check: 'gas'
      }
    ])('refuses a fill with $name', async ({ payload, gas, check }) => {
      mockRpc(gas)
      const kernel = spec()
      await expect(signFill(kernel, payload)).rejects.toMatchObject({
        constructor: PolicyViolationError,
        check
      })
      expect(kernel.events.map(e => e.event)).toStrictEqual(['signer.policy_violation'])
    })

    it('refuses a fill carrying value before reaching the signer', async () => {
      mockRpc()
      await expect(signFill(spec(), { ...fill, value: 1n })).rejects.toThrow(/sends no value/)
    })
  })
})
