import type { Hex } from 'viem'

import { describe, expect, it } from 'bun:test'
import { parseGwei } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import {
  assertLiquidatorAddressMatchesKey,
  optionalLiquidatorAddress,
  resolveBackoff,
  resolveMaxFeeWei,
  resolvePrivateKey,
  resolveSignerBackend
} from '../../src/queue/env'

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
  it('selects the local backend (key read) when SIGNER_SOCKET is unset', () => {
    expect(resolveSignerBackend(baseEnv())).toEqual({ kind: 'local', privateKey: KEY })
  })

  it('selects the agent backend WITHOUT reading the key when SIGNER_SOCKET is set', () => {
    // No LIQUIDATOR_PRIVATE_KEY at all — agent selection must not require it (the agent holds it).
    const backend = resolveSignerBackend(
      baseEnv({ SIGNER_SOCKET: '/tmp/x.sock', LIQUIDATOR_PRIVATE_KEY: undefined })
    )
    expect(backend).toEqual({ kind: 'agent', socketPath: '/tmp/x.sock', expectedAddress: DERIVED })
  })

  it('carries no expectedAddress in agent mode when LIQUIDATOR_ADDRESS is unset', () => {
    const backend = resolveSignerBackend(
      baseEnv({ SIGNER_SOCKET: '/tmp/x.sock', LIQUIDATOR_ADDRESS: undefined })
    )
    expect(backend).toEqual({
      kind: 'agent',
      socketPath: '/tmp/x.sock',
      expectedAddress: undefined
    })
  })

  it('still validates LIQUIDATOR_ADDRESS in agent mode (fails loud on a malformed one)', () => {
    expect(() =>
      resolveSignerBackend(baseEnv({ SIGNER_SOCKET: '/tmp/x.sock', LIQUIDATOR_ADDRESS: 'nope' }))
    ).toThrow(/LIQUIDATOR_ADDRESS is not a valid address/)
  })

  it('rejects a LIQUIDATOR_ADDRESS that does not match the key-derived signer address', () => {
    expect(() =>
      resolveSignerBackend(
        baseEnv({ LIQUIDATOR_ADDRESS: '0x2222222222222222222222222222222222222222' })
      )
    ).toThrow(/does not match the address derived from LIQUIDATOR_PRIVATE_KEY/)
  })

  it('still requires the key in local mode', () => {
    expect(() => resolveSignerBackend(baseEnv({ LIQUIDATOR_PRIVATE_KEY: undefined }))).toThrow(
      /LIQUIDATOR_PRIVATE_KEY/
    )
  })
})

describe('signing-path key helpers', () => {
  it('resolvePrivateKey accepts a 32-byte hex key and rejects a malformed one', () => {
    expect(resolvePrivateKey(baseEnv())).toBe(KEY)
    expect(() => resolvePrivateKey(baseEnv({ LIQUIDATOR_PRIVATE_KEY: '0xabc' }))).toThrow(
      /32-byte hex/
    )
  })

  it('optionalLiquidatorAddress checksums a set address, returns undefined when unset, throws on garbage', () => {
    expect(optionalLiquidatorAddress(baseEnv({ LIQUIDATOR_ADDRESS: DERIVED.toLowerCase() }))).toBe(
      DERIVED
    )
    expect(optionalLiquidatorAddress(baseEnv({ LIQUIDATOR_ADDRESS: undefined }))).toBeUndefined()
    expect(() => optionalLiquidatorAddress(baseEnv({ LIQUIDATOR_ADDRESS: 'nope' }))).toThrow(
      /not a valid address/
    )
  })

  it('assertLiquidatorAddressMatchesKey passes on a match and throws on a mismatch', () => {
    expect(() => assertLiquidatorAddressMatchesKey(baseEnv(), KEY)).not.toThrow()
    expect(() =>
      assertLiquidatorAddressMatchesKey(
        baseEnv({ LIQUIDATOR_ADDRESS: '0x2222222222222222222222222222222222222222' }),
        KEY
      )
    ).toThrow(/does not match/)
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

describe('resolveBackoff', () => {
  it('defaults to base 2 / max 64 blocks', () => {
    expect(resolveBackoff(baseEnv())).toEqual({ baseBlocks: 2n, maxBlocks: 64n })
  })

  it('honors BACKOFF_BASE_BLOCKS / BACKOFF_MAX_BLOCKS overrides', () => {
    expect(
      resolveBackoff(baseEnv({ BACKOFF_BASE_BLOCKS: '5', BACKOFF_MAX_BLOCKS: '100' }))
    ).toEqual({
      baseBlocks: 5n,
      maxBlocks: 100n
    })
  })

  it('throws on a non-integer backoff bound', () => {
    expect(() => resolveBackoff(baseEnv({ BACKOFF_BASE_BLOCKS: '2.5' }))).toThrow(
      /must be a non-negative integer/
    )
  })
})
