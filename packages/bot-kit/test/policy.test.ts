import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import type { Policy, PolicyTx } from '../src/policy'

import { evaluatePolicy, EXECUTOR_SELECTOR } from '../src/policy'

const EXECUTOR = getAddress(`0x${'22'.repeat(20)}`)
const OTHER = getAddress(`0x${'33'.repeat(20)}`)

const POLICY: Policy = {
  chainId: 8453,
  executor: EXECUTOR,
  maxFeePerGasWei: 300_000_000_000n,
  maxGasLimit: 15_000_000n,
  maxDataBytes: 64
}

function tx(overrides: Partial<PolicyTx> = {}): PolicyTx {
  return {
    chainId: 8453,
    to: EXECUTOR,
    data: `${EXECUTOR_SELECTOR}deadbeef`,
    value: 0n,
    gas: 1_000_000n,
    maxFeePerGas: 1_000_000_000n,
    ...overrides
  }
}

describe('evaluatePolicy', () => {
  it('accepts a transaction satisfying every invariant and ceiling', () => {
    expect(evaluatePolicy(POLICY, tx())).toEqual({ ok: true })
    // Exactly at the ceilings, bare selector (zero-arg calldata) is still fine.
    expect(
      evaluatePolicy(
        POLICY,
        tx({ maxFeePerGas: 300_000_000_000n, gas: 15_000_000n, data: EXECUTOR_SELECTOR })
      )
    ).toEqual({ ok: true })
  })

  it.each([
    ['chainId', { chainId: 1 }],
    ['executor', { to: OTHER }],
    ['value', { value: 1n }],
    ['maxFeePerGas', { maxFeePerGas: 300_000_000_001n }],
    ['gas', { gas: 15_000_001n }],
    ['maxDataBytes', { data: `${EXECUTOR_SELECTOR}${'00'.repeat(61)}` }],
    ['selector', { data: '0x00000002' }]
  ] as const)('rejects on %s', (check, overrides) => {
    expect(evaluatePolicy(POLICY, tx(overrides))).toMatchObject({ ok: false, check })
  })

  it('accepts any member of a target list and rejects non-members', () => {
    const listed: Policy = { ...POLICY, executor: [EXECUTOR, OTHER] }
    expect(evaluatePolicy(listed, tx())).toEqual({ ok: true })
    expect(evaluatePolicy(listed, tx({ to: OTHER }))).toEqual({ ok: true })
    expect(evaluatePolicy(listed, tx({ to: getAddress(`0x${'44'.repeat(20)}`) }))).toMatchObject({
      ok: false,
      check: 'executor'
    })
  })

  it('denies every transaction under an empty target list', () => {
    expect(evaluatePolicy({ ...POLICY, executor: [] }, tx())).toMatchObject({
      ok: false,
      check: 'executor'
    })
  })

  it('accepts a caller-pinned selector', () => {
    const selector = '0x12345678' as const
    expect(evaluatePolicy({ ...POLICY, selector }, tx({ data: `${selector}deadbeef` }))).toEqual({
      ok: true
    })
    expect(evaluatePolicy({ ...POLICY, selector }, tx())).toMatchObject({
      ok: false,
      check: 'selector'
    })
  })

  it('defaults to zero value and exec_606BaXt', () => {
    expect(evaluatePolicy(POLICY, tx({ value: 1n }))).toMatchObject({ check: 'value' })
    expect(evaluatePolicy(POLICY, tx({ data: '0xdeadbeef' }))).toMatchObject({ check: 'selector' })
  })
})
