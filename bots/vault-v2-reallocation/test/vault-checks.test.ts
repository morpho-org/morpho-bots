import type { Logger } from '@repo/bot-kit'

import { getAddress } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import type { VaultCheckReads } from '../src/vault-checks'

import { InvalidVaultError } from '../src/invalid-vault.error'
import { checkVaults } from '../src/vault-checks'
import { ADAPTER, makeMarket, makeVaultData, RATE_AT_TARGET } from './helpers'

const spyLogger = () => {
  const events: { level: string; event: string; fields?: Record<string, unknown> }[] = []
  const make = (level: string) => (event: string, fields?: Record<string, unknown>) =>
    events.push({ level, event, fields })
  const logger: Logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error')
  }
  return { logger, events }
}

const VAULT = getAddress(`0x${'aa'.repeat(20)}`)

const someVaultData = () =>
  makeVaultData([makeMarket({ utilization: 0n, vaultAssets: 0n, rateAtTarget: RATE_AT_TARGET })])

const makeReads = (overrides: Partial<VaultCheckReads> = {}): VaultCheckReads => ({
  assertDeployed: vi.fn(async () => undefined),
  fetchVault: vi.fn(async () => someVaultData()),
  ...overrides
})

describe('checkVaults', () => {
  it('returns the vault → adapter map for the signing policy', async () => {
    const { logger, events } = spyLogger()
    const adapterByVault = await checkVaults([VAULT], makeReads(), logger)
    expect(adapterByVault).toEqual({ [VAULT]: [ADAPTER] })
    expect(events).toEqual([])
  })

  it('propagates a fetch rejection (non-V2 address, unsupported adapter shape)', async () => {
    const { logger } = spyLogger()
    await expect(
      checkVaults(
        [VAULT],
        makeReads({ fetchVault: vi.fn(async () => Promise.reject(new InvalidVaultError('nope'))) }),
        logger
      )
    ).rejects.toBeInstanceOf(InvalidVaultError)
  })

  it('warns but does not throw when the allocator role is missing', async () => {
    const { logger, events } = spyLogger()
    await checkVaults(
      [VAULT],
      makeReads({ fetchVault: vi.fn(async () => ({ ...someVaultData(), isAllocator: false })) }),
      logger
    )
    expect(events.some(e => e.event === 'allocator.missing_role' && e.level === 'warn')).toBe(true)
  })
})
