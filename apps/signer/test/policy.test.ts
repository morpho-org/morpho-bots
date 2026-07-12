import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { WireTx } from '../src/protocol'

import { evaluatePolicy, EXECUTOR_SELECTOR, parsePolicy, PolicyConfigError } from '../src/policy'

const EXECUTOR = getAddress(`0x${'22'.repeat(20)}`)
const OTHER = getAddress(`0x${'33'.repeat(20)}`)

const rawPolicy = {
  chainId: 8453,
  executor: EXECUTOR,
  maxFeePerGasWei: '300000000000',
  maxGasLimit: '15000000',
  maxDataBytes: 64
}

function tx(overrides: Partial<WireTx> = {}): WireTx {
  return {
    type: 'eip1559',
    chainId: 8453,
    to: EXECUTOR,
    data: `${EXECUTOR_SELECTOR}deadbeef`,
    value: '0',
    nonce: 1,
    gas: '1000000',
    maxFeePerGas: '1000000000',
    maxPriorityFeePerGas: '1000000',
    ...overrides
  }
}

describe('parsePolicy', () => {
  it('parses and normalizes the flat one-authority policy', () => {
    expect(parsePolicy(rawPolicy)).toEqual({
      chainId: 8453,
      executor: EXECUTOR,
      maxFeePerGasWei: 300000000000n,
      maxGasLimit: 15000000n,
      maxDataBytes: 64
    })
  })

  it('rejects missing, malformed, and unknown fields', () => {
    expect(() => parsePolicy({})).toThrow(PolicyConfigError)
    expect(() => parsePolicy({ ...rawPolicy, chainId: 0 })).toThrow(/chainId/)
    expect(() => parsePolicy({ ...rawPolicy, executor: 'nope' })).toThrow(/executor/)
    expect(() => parsePolicy({ ...rawPolicy, maxFeePerGasWei: '0' })).toThrow(/greater than zero/)
    expect(() => parsePolicy({ ...rawPolicy, extra: true })).toThrow(/unknown policy field/)
  })
})

describe('evaluatePolicy', () => {
  const policy = parsePolicy(rawPolicy)

  it('accepts only a transaction satisfying every invariant and ceiling', () => {
    expect(evaluatePolicy(policy, tx())).toEqual({ ok: true })
    expect(
      evaluatePolicy(
        policy,
        tx({ maxFeePerGas: '300000000000', gas: '15000000', data: EXECUTOR_SELECTOR })
      )
    ).toEqual({ ok: true })
  })

  it.each([
    ['chainId', { chainId: 1 }],
    ['executor', { to: OTHER }],
    ['value', { value: '1' }],
    ['maxFeePerGas', { maxFeePerGas: '300000000001' }],
    ['gas', { gas: '15000001' }],
    ['maxDataBytes', { data: `${EXECUTOR_SELECTOR}${'00'.repeat(61)}` }],
    ['selector', { data: '0x00000002' }]
  ] as const)('rejects on %s', (check, overrides) => {
    expect(evaluatePolicy(policy, tx(overrides))).toMatchObject({ ok: false, check })
  })

  it('hard-codes zero value and exec_606BaXt instead of making them configurable', () => {
    expect(Object.keys(policy)).not.toContain('maxValueWei')
    expect(Object.keys(policy)).not.toContain('selectors')
    expect(evaluatePolicy(policy, tx({ value: '1' }))).toMatchObject({ check: 'value' })
    expect(evaluatePolicy(policy, tx({ data: '0xdeadbeef' }))).toMatchObject({ check: 'selector' })
  })
})
