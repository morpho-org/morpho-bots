import type { Address, Hex } from 'viem'

import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import type { Policy, PolicyTx } from '../src/policy'

import { evaluatePolicy, EXECUTOR_SELECTOR, NONCE_FILL_MAX_GAS } from '../src/policy'

const EXECUTOR = getAddress(`0x${'22'.repeat(20)}`)
const OTHER = getAddress(`0x${'33'.repeat(20)}`)
const SIGNER = getAddress(`0x${'ab'.repeat(20)}`)

const POLICY: Policy = {
  chainId: 8453,
  targets: [EXECUTOR],
  maxFeePerGasWei: 300_000_000_000n,
  maxGasLimit: 15_000_000n,
  // Exactly the product of the two ceilings above, so it asserts what they already imply and the
  // at-the-ceilings case below still passes. A budget that BINDS is exercised separately.
  maxSpendWei: 15_000_000n * 300_000_000_000n,
  maxDataBytes: 64
}

function tx(overrides: Partial<PolicyTx> = {}): PolicyTx {
  return {
    chainId: 8453,
    from: SIGNER,
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

  // Neither ceiling alone bounds cost: a tx can sit under both and still be unaffordable, which is
  // the whole reason the product is asserted rather than left implied.
  it('denies on the product when both gas and fee are individually under their ceilings', () => {
    const budgeted: Policy = { ...POLICY, maxSpendWei: 10n ** 17n } // 0.1 ETH
    const overspend = tx({ gas: 10_000_000n, maxFeePerGas: 100_000_000_000n }) // 1 ETH

    expect(evaluatePolicy(POLICY, overspend)).toEqual({ ok: true })
    expect(evaluatePolicy(budgeted, overspend)).toMatchObject({ ok: false, check: 'spend' })
  })

  it('accepts a transaction exactly at the spend ceiling', () => {
    const budgeted: Policy = { ...POLICY, maxSpendWei: 10n ** 17n }

    expect(
      evaluatePolicy(budgeted, tx({ gas: 1_000_000n, maxFeePerGas: 100_000_000_000n }))
    ).toEqual({ ok: true })
  })

  it.each([
    ['chainId', { chainId: 1 }],
    ['target', { to: OTHER }],
    ['value', { value: 1n }],
    ['maxFeePerGas', { maxFeePerGas: 300_000_000_001n }],
    ['gas', { gas: 15_000_001n }],
    ['maxDataBytes', { data: `${EXECUTOR_SELECTOR}${'00'.repeat(61)}` }],
    ['selector', { data: '0x00000002' }]
  ] as const)('rejects on %s', (check, overrides) => {
    expect(evaluatePolicy(POLICY, tx(overrides))).toMatchObject({ ok: false, check })
  })

  it('accepts any member of a target list and rejects non-members', () => {
    const listed: Policy = { ...POLICY, targets: [EXECUTOR, OTHER] }
    expect(evaluatePolicy(listed, tx())).toEqual({ ok: true })
    expect(evaluatePolicy(listed, tx({ to: OTHER }))).toEqual({ ok: true })
    expect(evaluatePolicy(listed, tx({ to: getAddress(`0x${'44'.repeat(20)}`) }))).toMatchObject({
      ok: false,
      check: 'target'
    })
  })

  it('denies every transaction under an empty target list', () => {
    expect(evaluatePolicy({ ...POLICY, targets: [] }, tx())).toMatchObject({
      ok: false,
      check: 'target'
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

  it('applies gas and calldata limits for the matching target and selector rule', () => {
    const otherSelector = '0x12345678' as const
    const ruled: Policy = {
      ...POLICY,
      rules: [
        {
          target: EXECUTOR,
          selector: EXECUTOR_SELECTOR,
          maxGasLimit: 2_000_000n,
          maxDataBytes: 32
        },
        {
          target: OTHER,
          selector: otherSelector,
          maxGasLimit: 50_000n,
          maxDataBytes: 8
        }
      ]
    }

    expect(evaluatePolicy(ruled, tx({ gas: 2_000_000n }))).toEqual({ ok: true })
    expect(evaluatePolicy(ruled, tx({ gas: 2_000_001n }))).toMatchObject({ check: 'gas' })
    expect(
      evaluatePolicy(ruled, tx({ to: OTHER, data: `${otherSelector}deadbeef`, gas: 50_000n }))
    ).toEqual({ ok: true })
    expect(
      evaluatePolicy(ruled, tx({ to: OTHER, data: EXECUTOR_SELECTOR, gas: 50_000n }))
    ).toMatchObject({ check: 'selector' })
  })

  it.each([['before'], ['after']] as const)(
    'prefers an exact selector rule when a wildcard rule appears %s it',
    order => {
      const exact = {
        target: EXECUTOR,
        selector: EXECUTOR_SELECTOR,
        maxGasLimit: 100_000n,
        maxDataBytes: 8
      }
      const wildcard = {
        target: EXECUTOR,
        maxGasLimit: 2_000_000n,
        maxDataBytes: 64
      }
      const rules = order === 'before' ? [wildcard, exact] : [exact, wildcard]
      const policy: Policy = { ...POLICY, rules }

      expect(evaluatePolicy(policy, tx({ gas: 100_000n }))).toEqual({ ok: true })
      expect(evaluatePolicy(policy, tx({ gas: 100_001n }))).toMatchObject({
        ok: false,
        check: 'gas'
      })
    }
  )

  it('defaults to zero value and exec_606BaXt', () => {
    expect(evaluatePolicy(POLICY, tx({ value: 1n }))).toMatchObject({ check: 'value' })
    expect(evaluatePolicy(POLICY, tx({ data: '0xdeadbeef' }))).toMatchObject({ check: 'selector' })
  })

  describe('nonce fill', () => {
    const fill = (overrides: Partial<PolicyTx> = {}) =>
      tx({ to: SIGNER, data: '0x', gas: 21_000n, ...overrides })
    const ruled: Policy = {
      ...POLICY,
      rules: [{ target: EXECUTOR, maxGasLimit: 2_000_000n, maxDataBytes: 64 }]
    }

    it.each([
      ['targets', POLICY],
      ['rules', ruled]
    ] as const)('authorizes a self-send under a %s policy that never names the signer', (_, p) => {
      expect(evaluatePolicy(p, fill())).toEqual({ ok: true })
      expect(evaluatePolicy(p, fill({ to: SIGNER.toLowerCase() as Address }))).toEqual({
        ok: true
      })
      expect(evaluatePolicy(p, fill({ gas: NONCE_FILL_MAX_GAS }))).toEqual({ ok: true })
    })

    it.each([
      ['nonzero value', { value: 1n }, 'value'],
      ['one byte of calldata', { data: '0x00' }, 'maxDataBytes'],
      ['an upper-case empty prefix', { data: '0X' as Hex }, 'maxDataBytes'],
      ['the configured selector', { data: EXECUTOR_SELECTOR }, 'maxDataBytes'],
      ['gas above the fill bound', { gas: NONCE_FILL_MAX_GAS + 1n }, 'gas'],
      ['another chain', { chainId: 1 }, 'chainId'],
      ['a fee above the ceiling', { maxFeePerGas: POLICY.maxFeePerGasWei + 1n }, 'maxFeePerGas'],
      ['a send to an account other than the signer', { to: OTHER }, 'target'],
      ['a fill signed by an account it does not name', { from: OTHER }, 'target']
    ] as const)('refuses %s', (_, overrides, check) => {
      expect(evaluatePolicy(POLICY, fill(overrides))).toMatchObject({ ok: false, check })
    })

    it('refuses a fill over the spend ceiling', () => {
      const budgeted: Policy = { ...POLICY, maxSpendWei: 21_000n * 1_000_000_000n - 1n }
      expect(evaluatePolicy(budgeted, fill())).toMatchObject({ ok: false, check: 'spend' })
    })

    it('holds a self-send to the fill shape even where the signer is a listed target', () => {
      const listed: Policy = {
        ...POLICY,
        targets: [EXECUTOR, SIGNER],
        rules: [{ target: SIGNER, maxGasLimit: 2_000_000n, maxDataBytes: 64 }]
      }
      expect(evaluatePolicy(listed, fill())).toEqual({ ok: true })
      expect(evaluatePolicy(listed, fill({ data: '0xdeadbeef' }))).toMatchObject({
        check: 'maxDataBytes'
      })
      expect(evaluatePolicy(listed, fill({ gas: NONCE_FILL_MAX_GAS + 1n }))).toMatchObject({
        check: 'gas'
      })
    })

    it('refuses a send to another account under a rules policy', () => {
      expect(evaluatePolicy(ruled, fill({ to: OTHER }))).toMatchObject({ check: 'target' })
    })
  })
})
