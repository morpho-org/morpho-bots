import type { Logger } from '@repo/bot-kit'
import type { Address, Hex } from 'viem'

import { tryCatch } from '@repo/utils'

import type { SimulateResult } from '../simulate'
import type { MarketAllocation, Strategy } from '../strategies'
import type { VaultData } from '../vault-data'

export type TickDeps = {
  vaults: Address[]
  chainHead: bigint
  /** Live allocator-role check; a vault without the role is skipped (and resumes once granted). */
  isAllocator: (vault: Address) => Promise<boolean>
  fetchVault: (vault: Address, blockNumber: bigint) => Promise<VaultData>
  strategy: Strategy
  encodeReallocate: (allocations: MarketAllocation[]) => Hex
  simulate: (vault: Address, data: Hex) => Promise<SimulateResult>
  submit: (params: { vault: Address; data: Hex; blockNumber: bigint }) => Promise<void>
  /** When true, a sim-ok plan is logged (`reallocation.dry_run`) instead of submitted. */
  dryRun: boolean
  /** Labels (vault addresses) with an in-flight or cooling-down tx — skipped this tick. */
  inflightLabels: () => ReadonlySet<string>
  revertReason: (error: unknown) => string
  logger: Logger
}

type TickCounters = {
  vaults: number
  skipped_inflight: number
  missing_role: number
  reallocations_found: number
  sim_reverts: number
  dry_runs: number
  submitted: number
  errors: number
}

const processVault = async (
  deps: TickDeps,
  vault: Address,
  counters: TickCounters
): Promise<void> => {
  if (!(await deps.isAllocator(vault))) {
    counters.missing_role++
    deps.logger.warn('allocator.missing_role', { vault })
    return
  }

  const vaultData = await deps.fetchVault(vault, deps.chainHead)
  const allocations = deps.strategy(vaultData)
  if (!allocations) return
  counters.reallocations_found++

  const summary = allocations.map(allocation => ({
    collateralToken: allocation.marketParams.collateralToken,
    lltv: allocation.marketParams.lltv,
    assets: allocation.assets
  }))
  deps.logger.info('reallocation.found', { vault, legs: allocations.length, allocations: summary })

  const data = deps.encodeReallocate(allocations)
  const sim = await deps.simulate(vault, data)
  if (sim.status === 'revert') {
    counters.sim_reverts++
    deps.logger.warn('reallocation.sim_revert', { vault, reason: sim.reason })
    return
  }

  if (deps.dryRun) {
    counters.dry_runs++
    deps.logger.info('reallocation.dry_run', { vault, legs: allocations.length, allocations: summary })
    return
  }

  await deps.submit({ vault, data, blockNumber: deps.chainHead })
  counters.submitted++
}

/**
 * One reallocation pass: for each whitelisted vault — skip if a tx is in flight, skip (loudly) if
 * the allocator role is missing, then fetch a block-pinned snapshot, run the strategy, simulate the
 * exact broadcast bytes, and submit (or dry-run-log) on sim-ok. A failure in one vault logs
 * `vault.error` and never blocks the others; one wide `tick.end` counters line closes the pass.
 */
export const runTick = async (deps: TickDeps): Promise<void> => {
  const started = Date.now()
  const counters: TickCounters = {
    vaults: deps.vaults.length,
    skipped_inflight: 0,
    missing_role: 0,
    reallocations_found: 0,
    sim_reverts: 0,
    dry_runs: 0,
    submitted: 0,
    errors: 0
  }

  for (const vault of deps.vaults) {
    if (deps.inflightLabels().has(vault)) {
      counters.skipped_inflight++
      deps.logger.debug('vault.inflight', { vault })
      continue
    }
    const { error } = await tryCatch(processVault(deps, vault, counters))
    if (error) {
      counters.errors++
      deps.logger.error('vault.error', { vault, reason: deps.revertReason(error) })
    }
  }

  deps.logger.info('tick.end', {
    blockNumber: deps.chainHead,
    ...counters,
    duration_ms: Date.now() - started
  })
}
