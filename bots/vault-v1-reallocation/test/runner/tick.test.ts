import type { Logger } from '@repo/bot-kit'
import type { Address } from 'viem'

import { getAddress, maxUint256 } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import type { TickDeps } from '../../src/runner/tick'
import type { VaultData } from '../../src/vault-data'

import { runTick } from '../../src/runner/tick'
import { makeMarket, makeVaultData, VAULT_CURATOR, VAULT_OWNER } from '../strategies/helpers'

function spyLogger() {
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

const VAULT_A: Address = getAddress(`0x${'aa'.repeat(20)}`)
const VAULT_B: Address = getAddress(`0x${'bb'.repeat(20)}`)
const DATA = '0xdeadbeef' as const

const EOA: Address = getAddress(`0x${'ee'.repeat(20)}`)

const someVaultData = (): VaultData =>
  makeVaultData([makeMarket({ utilization: 0n, vaultAssets: 0n, cap: 0n })])

// The lens reads `isAllocator` into the snapshot, so "not an allocator" is a snapshot field now.
const notAnAllocator = (): VaultData => ({ ...someVaultData(), isAllocator: false })

const someAllocations = () => [
  {
    marketParams: {
      loanToken: VAULT_A,
      collateralToken: VAULT_B,
      oracle: VAULT_A,
      irm: VAULT_A,
      lltv: 0n
    },
    assets: maxUint256
  }
]

const makeDeps = (overrides: Partial<TickDeps> = {}) => {
  const { logger, events } = spyLogger()
  const deps: TickDeps = {
    vaults: [VAULT_A],
    chainHead: 100n,
    eoa: EOA,
    fetchVault: vi.fn(async () => someVaultData()),
    strategy: vi.fn(() => undefined),
    encodeReallocate: vi.fn(() => DATA),
    simulate: vi.fn(async () => ({ status: 'ok' as const })),
    submit: vi.fn(async () => true),
    dryRun: false,
    inflightLabels: () => new Set<string>(),
    revertReason: error => (error instanceof Error ? error.message : String(error)),
    logger,
    ...overrides
  }
  return { deps, events }
}

const tickEnd = (events: ReturnType<typeof spyLogger>['events']) =>
  events.find(e => e.event === 'tick.end')?.fields

describe('runTick', () => {
  it('submits a sim-ok reallocation and counts it', async () => {
    const { deps, events } = makeDeps({ strategy: vi.fn(() => someAllocations()) })
    await runTick(deps)
    expect(deps.submit).toHaveBeenCalledWith({ vault: VAULT_A, data: DATA, blockNumber: 100n })
    expect(tickEnd(events)).toMatchObject({ reallocations_found: 1, submitted: 1, errors: 0 })
    expect(events.some(e => e.event === 'reallocation.found')).toBe(true)
  })

  it('passes the tick chainHead into the vault fetch (block-pinned snapshot)', async () => {
    const { deps } = makeDeps({ chainHead: 123n })
    await runTick(deps)
    expect(deps.fetchVault).toHaveBeenCalledWith(VAULT_A, 123n)
  })

  it('does nothing when the strategy finds no reallocation', async () => {
    const { deps, events } = makeDeps()
    await runTick(deps)
    expect(deps.simulate).not.toHaveBeenCalled()
    expect(deps.submit).not.toHaveBeenCalled()
    expect(tickEnd(events)).toMatchObject({ reallocations_found: 0, submitted: 0 })
  })

  it('does not submit on a sim revert and logs the reason', async () => {
    const { deps, events } = makeDeps({
      strategy: vi.fn(() => someAllocations()),
      simulate: vi.fn(async () => ({ status: 'revert' as const, reason: 'CapExceeded' }))
    })
    await runTick(deps)
    expect(deps.submit).not.toHaveBeenCalled()
    expect(events).toContainEqual({
      level: 'warn',
      event: 'reallocation.sim_revert',
      fields: { vault: VAULT_A, reason: 'CapExceeded' }
    })
    expect(tickEnd(events)).toMatchObject({ sim_reverts: 1, submitted: 0 })
  })

  it('logs instead of submitting in dry-run mode', async () => {
    const { deps, events } = makeDeps({ strategy: vi.fn(() => someAllocations()), dryRun: true })
    await runTick(deps)
    expect(deps.simulate).toHaveBeenCalled()
    expect(deps.submit).not.toHaveBeenCalled()
    expect(events.some(e => e.event === 'reallocation.dry_run')).toBe(true)
    expect(tickEnd(events)).toMatchObject({ dry_runs: 1, submitted: 0 })
  })

  it('does not count a submit that was not broadcast', async () => {
    const { deps, events } = makeDeps({
      strategy: vi.fn(() => someAllocations()),
      submit: vi.fn(async () => false)
    })
    await runTick(deps)
    expect(deps.submit).toHaveBeenCalled()
    expect(tickEnd(events)).toMatchObject({ reallocations_found: 1, submitted: 0 })
    expect(events).toContainEqual({
      level: 'debug',
      event: 'reallocation.not_broadcast',
      fields: { vault: VAULT_A }
    })
  })

  it('skips a vault whose label is in flight', async () => {
    const { deps, events } = makeDeps({ inflightLabels: () => new Set([VAULT_A]) })
    await runTick(deps)
    expect(deps.fetchVault).not.toHaveBeenCalled()
    expect(tickEnd(events)).toMatchObject({ skipped_inflight: 1 })
  })

  it('skips strategy/simulate while the allocator role is missing', async () => {
    const { deps, events } = makeDeps({ fetchVault: vi.fn(async () => notAnAllocator()) })
    await runTick(deps)
    expect(deps.strategy).not.toHaveBeenCalled()
    expect(deps.simulate).not.toHaveBeenCalled()
    expect(events).toContainEqual({
      level: 'warn',
      event: 'allocator.missing_role',
      fields: { vault: VAULT_A }
    })
    expect(tickEnd(events)).toMatchObject({ missing_role: 1 })
  })

  it.each([
    ['owner', VAULT_OWNER],
    ['curator', VAULT_CURATOR]
  ])('accepts a %s-keyed EOA that is not in the allocator set', async (_role, eoa) => {
    const { deps, events } = makeDeps({
      eoa,
      fetchVault: vi.fn(async () => notAnAllocator()),
      strategy: vi.fn(() => someAllocations())
    })
    await runTick(deps)
    expect(deps.submit).toHaveBeenCalled()
    expect(tickEnd(events)).toMatchObject({ missing_role: 0, submitted: 1 })
  })

  it('processes vaults concurrently and folds their counters', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const fetchVault = vi.fn(async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight)
      await Promise.resolve()
      inFlight--
      return someVaultData()
    })
    const { deps, events } = makeDeps({
      vaults: [VAULT_A, VAULT_B],
      fetchVault,
      strategy: vi.fn(() => someAllocations())
    })
    await runTick(deps)
    expect(maxInFlight).toBe(2)
    expect(tickEnd(events)).toMatchObject({ vaults: 2, reallocations_found: 2, submitted: 2 })
  })

  it('reads the in-flight label set once per pass', async () => {
    const inflightLabels = vi.fn(() => new Set<string>())
    const { deps } = makeDeps({ vaults: [VAULT_A, VAULT_B], inflightLabels })
    await runTick(deps)
    expect(inflightLabels).toHaveBeenCalledTimes(1)
  })

  it('continues past a failing vault and reports vault.error', async () => {
    const fetchVault = vi.fn(async (vault: Address) => {
      if (vault === VAULT_A) throw new Error('rpc exploded')
      return someVaultData()
    })
    const { deps, events } = makeDeps({ vaults: [VAULT_A, VAULT_B], fetchVault })
    await runTick(deps)
    expect(fetchVault).toHaveBeenCalledTimes(2)
    expect(events).toContainEqual({
      level: 'error',
      event: 'vault.error',
      fields: { vault: VAULT_A, reason: 'rpc exploded' }
    })
    expect(tickEnd(events)).toMatchObject({ errors: 1 })
  })
})
