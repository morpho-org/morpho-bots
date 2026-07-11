import { afterEach, describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { CalldataModule } from '../src/policy'
import type { WireTx } from '../src/protocol'

import { CALLDATA_MODULES, evaluatePolicy, parsePolicy, PolicyConfigError } from '../src/policy'

const EXECUTOR = getAddress(`0x${'22'.repeat(20)}`)
const OTHER = getAddress(`0x${'33'.repeat(20)}`)

function rule(overrides: Record<string, unknown> = {}) {
  return {
    name: 'base-rule',
    chainIds: [8453],
    to: [EXECUTOR],
    maxFeePerGasWei: '300000000000',
    maxGasLimit: '15000000',
    ...overrides
  }
}

function policy(overrides: Record<string, unknown> = {}) {
  return parsePolicy({ version: 1, rules: [rule(overrides)] })
}

function wireTx(overrides: Partial<WireTx> = {}): WireTx {
  return {
    type: 'eip1559',
    chainId: 8453,
    to: EXECUTOR,
    data: '0x',
    value: '0',
    nonce: 1,
    gas: '1000000',
    maxFeePerGas: '1000000000',
    maxPriorityFeePerGas: '1000000',
    ...overrides
  }
}

describe('parsePolicy', () => {
  it('throws PolicyConfigError on an empty rule set', () => {
    expect(() => parsePolicy({ version: 1, rules: [] })).toThrow(PolicyConfigError)
  })

  it('throws PolicyConfigError on a wrong version', () => {
    expect(() => parsePolicy({ version: 2, rules: [rule()] })).toThrow(PolicyConfigError)
  })

  it('throws PolicyConfigError on a malformed rule', () => {
    expect(() => parsePolicy({ version: 1, rules: [{ name: 'x' }] })).toThrow(PolicyConfigError)
  })

  it('throws PolicyConfigError on an unknown calldata module', () => {
    expect(() => policy({ calldata: { module: 'does-not-exist', config: {} } })).toThrow(
      PolicyConfigError
    )
  })
})

describe('evaluatePolicy — single-rule checks', () => {
  it('accepts a tx that passes every check', () => {
    expect(evaluatePolicy(policy(), wireTx())).toEqual({ ok: true, rule: 'base-rule' })
  })

  it('rejects on chainId', () => {
    const decision = evaluatePolicy(policy(), wireTx({ chainId: 1 }))
    expect(decision).toMatchObject({ ok: false, rule: 'base-rule', check: 'chainId' })
  })

  it('rejects on to', () => {
    const decision = evaluatePolicy(policy(), wireTx({ to: OTHER }))
    expect(decision).toMatchObject({ ok: false, check: 'to' })
  })

  it('rejects on value (default maxValueWei is 0)', () => {
    const decision = evaluatePolicy(policy(), wireTx({ value: '1' }))
    expect(decision).toMatchObject({ ok: false, check: 'value' })
  })

  it('rejects on maxFeePerGas', () => {
    const decision = evaluatePolicy(policy(), wireTx({ maxFeePerGas: '300000000001' }))
    expect(decision).toMatchObject({ ok: false, check: 'maxFeePerGas' })
  })

  it('rejects on gas', () => {
    const decision = evaluatePolicy(policy(), wireTx({ gas: '15000001' }))
    expect(decision).toMatchObject({ ok: false, check: 'gas' })
  })

  it('rejects on maxDataBytes', () => {
    const p = policy({ maxDataBytes: 2 })
    const decision = evaluatePolicy(p, wireTx({ data: '0x0011223344' }))
    expect(decision).toMatchObject({ ok: false, check: 'maxDataBytes' })
  })

  it('accepts data at exactly maxDataBytes and rejects one over', () => {
    const p = policy({ maxDataBytes: 2 })
    expect(evaluatePolicy(p, wireTx({ data: '0x0011' })).ok).toBe(true)
    expect(evaluatePolicy(p, wireTx({ data: '0x001122' })).ok).toBe(false)
  })

  it('enforces the selector allowlist', () => {
    const p = policy({ selectors: ['0x00000001'] })
    expect(evaluatePolicy(p, wireTx({ data: '0x00000001dead' })).ok).toBe(true)
    const decision = evaluatePolicy(p, wireTx({ data: '0x00000002dead' }))
    expect(decision).toMatchObject({ ok: false, check: 'selectors' })
  })

  it('accepts values at exactly the ceilings', () => {
    const p = policy({ maxValueWei: '10' })
    expect(
      evaluatePolicy(p, wireTx({ value: '10', maxFeePerGas: '300000000000', gas: '15000000' }))
    ).toEqual({ ok: true, rule: 'base-rule' })
  })
})

describe('evaluatePolicy — multi-rule and default-deny', () => {
  it('first matching rule wins (file order)', () => {
    const p = parsePolicy({
      version: 1,
      rules: [
        rule({ name: 'arbitrum', chainIds: [42161] }),
        rule({ name: 'base', chainIds: [8453] })
      ]
    })
    expect(evaluatePolicy(p, wireTx())).toEqual({ ok: true, rule: 'base' })
  })

  it('aggregates one clause per rule on rejection', () => {
    const p = parsePolicy({
      version: 1,
      rules: [rule({ name: 'r1', chainIds: [1] }), rule({ name: 'r2', chainIds: [10] })]
    })
    const decision = evaluatePolicy(p, wireTx())
    expect(decision.ok).toBe(false)
    if (!decision.ok) {
      expect(decision.rule).toBe('r1')
      expect(decision.message).toContain("rule 'r1'")
      expect(decision.message).toContain("rule 'r2'")
    }
  })

  it('a hand-built empty rule set denies everything', () => {
    const decision = evaluatePolicy({ version: 1, rules: [] }, wireTx())
    expect(decision.ok).toBe(false)
  })
})

describe('evaluatePolicy — calldata module', () => {
  const TOY = 'toy-forbid'

  afterEach(() => {
    delete CALLDATA_MODULES[TOY]
  })

  // A toy module that rejects any tx whose calldata starts with a configured forbidden selector.
  const toyModule: CalldataModule = {
    parseConfig(raw) {
      if (
        typeof raw !== 'object' ||
        raw === null ||
        typeof (raw as { forbidden?: unknown }).forbidden !== 'string'
      ) {
        throw new Error('toy module requires { forbidden: string }')
      }
      return { forbidden: (raw as { forbidden: string }).forbidden }
    },
    check(tx, config) {
      const forbidden = (config as { forbidden: string }).forbidden
      return tx.data.startsWith(forbidden)
        ? { ok: false, reason: 'forbidden selector' }
        : { ok: true }
    }
  }

  it('runs a registered module and rejects on its verdict', () => {
    CALLDATA_MODULES[TOY] = toyModule
    const p = policy({ calldata: { module: TOY, config: { forbidden: '0xbadc0ffe' } } })
    expect(evaluatePolicy(p, wireTx({ data: '0xdeadbeef' })).ok).toBe(true)
    const decision = evaluatePolicy(p, wireTx({ data: '0xbadc0ffe11' }))
    expect(decision).toMatchObject({ ok: false, check: 'calldata' })
  })

  it('propagates a module parseConfig rejection as PolicyConfigError at load time', () => {
    CALLDATA_MODULES[TOY] = toyModule
    expect(() => policy({ calldata: { module: TOY, config: { forbidden: 123 } } })).toThrow(
      PolicyConfigError
    )
  })
})
