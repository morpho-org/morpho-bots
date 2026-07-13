import type { Hex } from 'viem'

import { describe, expect, it } from 'bun:test'
import { parseGwei } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { resolveLiquidatorAddress, resolveMaxFeeWei, resolveSignerBackend } from '../src/env'

const KEY: Hex = `0x${'1'.repeat(64)}`
const DERIVED = privateKeyToAccount(KEY).address

// The queue-signing env the resolvers read; both liquidation cores feed a superset of this.
function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {
    LIQUIDATOR_PRIVATE_KEY: KEY,
    LIQUIDATOR_ADDRESS: DERIVED,
    ...overrides
  }
  for (const k of Object.keys(overrides)) if (overrides[k] === undefined) delete env[k]
  return env
}

describe('resolveSignerBackend', () => {
  it('requires the signing agent when SIGNER_SOCKET is unset', () => {
    expect(() => resolveSignerBackend(baseEnv({ LIQUIDATOR_PRIVATE_KEY: undefined }))).toThrow(
      /SIGNER_SOCKET/
    )
  })

  it('selects the agent backend without reading a key when SIGNER_SOCKET is set', () => {
    // No LIQUIDATOR_PRIVATE_KEY at all — agent selection must not require it (the agent holds it).
    const backend = resolveSignerBackend(
      baseEnv({ SIGNER_SOCKET: '/tmp/x.sock', LIQUIDATOR_PRIVATE_KEY: undefined })
    )
    expect(backend).toEqual({ kind: 'agent', socketPath: '/tmp/x.sock' })
  })

  it('requires LIQUIDATOR_ADDRESS independently of signer selection', () => {
    expect(() => resolveLiquidatorAddress(baseEnv({ LIQUIDATOR_ADDRESS: undefined }))).toThrow(
      /LIQUIDATOR_ADDRESS/
    )
  })

  it('still validates LIQUIDATOR_ADDRESS in agent mode (fails loud on a malformed one)', () => {
    expect(() => resolveLiquidatorAddress(baseEnv({ LIQUIDATOR_ADDRESS: 'nope' }))).toThrow(
      /LIQUIDATOR_ADDRESS is not a valid address/
    )
  })

  it('rejects local key material even when SIGNER_SOCKET is set', () => {
    expect(() => resolveSignerBackend(baseEnv({ SIGNER_SOCKET: '/tmp/x.sock' }))).toThrow(
      /not accepted by morpho-queued/
    )
  })
})

describe('signing-path key helpers', () => {
  it('resolveLiquidatorAddress checksums a set address and throws on garbage', () => {
    expect(resolveLiquidatorAddress(baseEnv({ LIQUIDATOR_ADDRESS: DERIVED.toLowerCase() }))).toBe(
      DERIVED
    )
    expect(() => resolveLiquidatorAddress(baseEnv({ LIQUIDATOR_ADDRESS: 'nope' }))).toThrow(
      /not a valid address/
    )
  })
})

describe('resolveMaxFeeWei', () => {
  it('defaults to 300 gwei when MAX_FEE_GWEI is unset', () => {
    expect(resolveMaxFeeWei(baseEnv())).toBe(parseGwei('300'))
  })

  it('honors a MAX_FEE_GWEI override', () => {
    expect(resolveMaxFeeWei(baseEnv({ MAX_FEE_GWEI: '42' }))).toBe(parseGwei('42'))
  })

  it('throws on a non-numeric or non-positive MAX_FEE_GWEI', () => {
    expect(() => resolveMaxFeeWei(baseEnv({ MAX_FEE_GWEI: 'abc' }))).toThrow(
      /MAX_FEE_GWEI must be a positive number/
    )
    expect(() => resolveMaxFeeWei(baseEnv({ MAX_FEE_GWEI: '0' }))).toThrow(
      /MAX_FEE_GWEI must be a positive number/
    )
  })
})
