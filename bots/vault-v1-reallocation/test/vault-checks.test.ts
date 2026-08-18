import type { Logger } from '@repo/bot-kit'
import type { Address } from 'viem'

import { getAddress } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import type { VaultCheckReads } from '../src/vault-checks'

import { InvalidVaultError } from '../src/invalid-vault.error'
import { checkVaults } from '../src/vault-checks'

const VAULT_A: Address = getAddress(`0x${'aa'.repeat(20)}`)
const VAULT_B: Address = getAddress(`0x${'bb'.repeat(20)}`)

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

const makeReads = (overrides: Partial<VaultCheckReads> = {}): VaultCheckReads => ({
  assertDeployed: vi.fn(async () => undefined),
  readV1Surface: vi.fn(async () => 'asset'),
  hasAllocatorRole: vi.fn(async () => true),
  ...overrides
})

describe('checkVaults', () => {
  it('accepts every deployed vault answering the V1 surface with the role granted', async () => {
    const reads = makeReads()
    const { logger, events } = spyLogger()
    await checkVaults([VAULT_A, VAULT_B], reads, logger)
    expect(reads.assertDeployed).toHaveBeenCalledTimes(2)
    expect(reads.readV1Surface).toHaveBeenCalledTimes(2)
    expect(events).toEqual([])
  })

  it('propagates the liveness failure', async () => {
    const reads = makeReads({
      assertDeployed: vi.fn(async () => {
        throw new Error('no code')
      })
    })
    const { logger } = spyLogger()
    await expect(checkVaults([VAULT_A], reads, logger)).rejects.toThrow('no code')
    expect(reads.readV1Surface).not.toHaveBeenCalled()
  })

  it('throws InvalidVaultError when the V1 surface does not answer', async () => {
    const reads = makeReads({
      readV1Surface: vi.fn(async () => {
        throw new Error('execution reverted')
      })
    })
    const { logger } = spyLogger()
    await expect(checkVaults([VAULT_A], reads, logger)).rejects.toBeInstanceOf(InvalidVaultError)
  })

  it.each([
    ['the role is not granted', vi.fn(async () => false)],
    [
      'the role probe fails',
      vi.fn(async () => {
        throw new Error('rpc down')
      })
    ]
  ])('warns without throwing when %s', async (_case, hasAllocatorRole) => {
    const { logger, events } = spyLogger()
    await checkVaults([VAULT_A], makeReads({ hasAllocatorRole }), logger)
    expect(events).toContainEqual({
      level: 'warn',
      event: 'allocator.missing_role',
      fields: { vault: VAULT_A, detail: 'grant the allocator role to the EOA' }
    })
  })
})
