import type { Logger, SimulateResult } from '@repo/bot-kit'
import type { Address, Hex } from 'viem'

import { tryCatch } from '@repo/utils'

import type { Reallocation, Strategy } from '../strategies'
import type { VaultV2Data } from '../vault-data'

export type TickDeps = {
  vaults: Address[]
  chainHead: bigint
  /** Live allocator-role check; a vault without the role is skipped (and resumes once granted). */
  isAllocator: (vault: Address) => Promise<boolean>
  /**
   * The adapter the signing policy was pinned to at startup. A curator swapping the adapter
   * mid-run would otherwise surface as an opaque PolicyViolationError on every submit — the tick
   * skips the vault with an actionable `adapter.changed` instead (restart to re-pin).
   */
  expectedAdapter: (vault: Address) => Address | undefined
  fetchVault: (vault: Address, blockNumber: bigint) => Promise<VaultV2Data>
  strategy: Strategy
  encodeReallocation: (vaultData: VaultV2Data, reallocation: Reallocation) => Hex
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
  adapter_changed: number
  reallocations_found: number
  sim_reverts: number
  dry_runs: number
  submitted: number
  errors: number
}

const summarize = (reallocation: Reallocation) => [
  ...reallocation.deallocations.map(leg => ({
    action: 'deallocate',
    marketId: leg.marketId,
    collateralToken: leg.marketParams.collateralToken,
    lltv: leg.marketParams.lltv,
    assets: leg.assets
  })),
  ...reallocation.allocations.map(leg => ({
    action: 'allocate',
    marketId: leg.marketId,
    collateralToken: leg.marketParams.collateralToken,
    lltv: leg.marketParams.lltv,
    assets: leg.assets
  }))
]

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

  const expectedAdapter = deps.expectedAdapter(vault)
  if (expectedAdapter !== undefined && vaultData.adapterAddress !== expectedAdapter) {
    counters.adapter_changed++
    deps.logger.warn('adapter.changed', {
      vault,
      expected: expectedAdapter,
      actual: vaultData.adapterAddress,
      detail: 'restart the bot to re-pin the signing policy to the new adapter'
    })
    return
  }

  // Surfaced because `apy-range` excludes these outright — the curve inversion it relies on needs a
  // real AdaptiveCurveIRM `rateAtTarget` (`equalize-utilizations` keeps them).
  const foreignIrmMarkets = vaultData.marketsData
    .filter(marketData => !marketData.isAdaptiveCurve)
    .map(marketData => marketData.id)
  if (foreignIrmMarkets.length > 0) {
    deps.logger.debug('market.non_adaptive_curve', { vault, markets: foreignIrmMarkets })
  }

  const reallocation = deps.strategy(vaultData)
  if (!reallocation) return
  counters.reallocations_found++

  const legs = reallocation.deallocations.length + reallocation.allocations.length
  const summary = summarize(reallocation)
  deps.logger.info('reallocation.found', { vault, legs, allocations: summary })

  const data = deps.encodeReallocation(vaultData, reallocation)
  const sim = await deps.simulate(vault, data)
  if (sim.status === 'revert') {
    counters.sim_reverts++
    deps.logger.warn('reallocation.sim_revert', { vault, reason: sim.reason })
    return
  }

  if (deps.dryRun) {
    counters.dry_runs++
    deps.logger.info('reallocation.dry_run', { vault, legs, allocations: summary })
    return
  }

  await deps.submit({ vault, data, blockNumber: deps.chainHead })
  counters.submitted++
}

/**
 * One reallocation pass: for each whitelisted vault — skip if a tx is in flight, skip (loudly) if
 * the allocator role is missing, then fetch a block-pinned snapshot, run the strategy, simulate the
 * exact multicall bytes, and submit (or dry-run-log) on sim-ok. A failure in one vault logs
 * `vault.error` and never blocks the others; one wide `tick.end` counters line closes the pass.
 */
export const runTick = async (deps: TickDeps): Promise<void> => {
  const started = Date.now()
  const counters: TickCounters = {
    vaults: deps.vaults.length,
    skipped_inflight: 0,
    missing_role: 0,
    adapter_changed: 0,
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
