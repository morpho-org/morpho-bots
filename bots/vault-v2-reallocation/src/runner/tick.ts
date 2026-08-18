import type { Logger, SimulateResult } from '@repo/bot-kit'
import type { Address, Hex } from 'viem'

import { tryCatch } from '@repo/utils'

import type { Reallocation, Strategy } from '../strategies'
import type { VaultV2Data } from '../vault-data'

export type TickDeps = {
  vaults: Address[]
  chainHead: bigint
  /**
   * Strict `isAllocator(eoa)` on the vault — VaultV2.allocate admits no curator/owner fallback.
   * Run concurrently with the fetch; a vault the EOA cannot reallocate is skipped, and resumes on
   * its own once the role is granted.
   */
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
  /** Resolves true only when the transaction was actually broadcast. */
  submit: (params: { vault: Address; data: Hex; blockNumber: bigint }) => Promise<boolean>
  /** When true, a sim-ok plan is logged (`reallocation.dry_run`) instead of submitted. */
  dryRun: boolean
  /** Labels (vault addresses) with an in-flight or cooling-down tx — skipped this tick. */
  inflightLabels: () => ReadonlySet<string>
  revertReason: (error: unknown) => string
  logger: Logger
}

type VaultCounters = {
  skipped_inflight: number
  missing_role: number
  adapter_changed: number
  reallocations_found: number
  sim_reverts: number
  dry_runs: number
  submitted: number
  errors: number
}

const NO_COUNTS: VaultCounters = {
  skipped_inflight: 0,
  missing_role: 0,
  adapter_changed: 0,
  reallocations_found: 0,
  sim_reverts: 0,
  dry_runs: 0,
  submitted: 0,
  errors: 0
}

const COUNTER_KEYS = Object.keys(NO_COUNTS) as (keyof VaultCounters)[]

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

const processVault = async (deps: TickDeps, vault: Address): Promise<VaultCounters> => {
  const [vaultData, isAllocator] = await Promise.all([
    deps.fetchVault(vault, deps.chainHead),
    deps.isAllocator(vault)
  ])

  if (!isAllocator) {
    deps.logger.warn('allocator.missing_role', { vault })
    return { ...NO_COUNTS, missing_role: 1 }
  }

  const expectedAdapter = deps.expectedAdapter(vault)
  if (expectedAdapter !== undefined && vaultData.adapterAddress !== expectedAdapter) {
    deps.logger.warn('adapter.changed', {
      vault,
      expected: expectedAdapter,
      actual: vaultData.adapterAddress,
      detail: 'restart the bot to re-pin the signing policy to the new adapter'
    })
    return { ...NO_COUNTS, adapter_changed: 1 }
  }

  // Surfaced because `apy-range` excludes these outright — the curve inversion it relies on needs a
  // real AdaptiveCurveIRM `rateAtTarget` (`equalize-utilizations` keeps them).
  if (vaultData.nonAdaptiveCurveMarketIds.length > 0) {
    deps.logger.debug('market.non_adaptive_curve', {
      vault,
      markets: vaultData.nonAdaptiveCurveMarketIds
    })
  }

  const reallocation = deps.strategy(vaultData)
  if (!reallocation) return NO_COUNTS

  const legs = reallocation.deallocations.length + reallocation.allocations.length
  deps.logger.info('reallocation.found', { vault, legs, allocations: summarize(reallocation) })

  const data = deps.encodeReallocation(vaultData, reallocation)
  const sim = await deps.simulate(vault, data)
  if (sim.status === 'revert') {
    deps.logger.warn('reallocation.sim_revert', { vault, reason: sim.reason })
    return { ...NO_COUNTS, reallocations_found: 1, sim_reverts: 1 }
  }

  if (deps.dryRun) {
    // The plan itself was just logged by reallocation.found — this line only marks the decision.
    deps.logger.info('reallocation.dry_run', { vault })
    return { ...NO_COUNTS, reallocations_found: 1, dry_runs: 1 }
  }

  const sent = await deps.submit({ vault, data, blockNumber: deps.chainHead })
  if (!sent) deps.logger.debug('reallocation.not_broadcast', { vault })
  return { ...NO_COUNTS, reallocations_found: 1, submitted: sent ? 1 : 0 }
}

/**
 * One reallocation pass: every whitelisted vault is processed concurrently — skip if a tx is in
 * flight, fetch a block-pinned snapshot alongside the `isAllocator` read, skip (loudly) if the EOA
 * lacks the role or the vault's adapter changed since startup, run the strategy, simulate the
 * exact multicall bytes, and submit (or dry-run-log) on sim-ok. A failure in one vault logs
 * `vault.error` and never blocks the others; counters are folded after every vault settles and
 * closed by one wide `tick.end` line.
 */
export const runTick = async (deps: TickDeps): Promise<void> => {
  const started = Date.now()
  const inflight = deps.inflightLabels()

  const settled = await Promise.allSettled(
    deps.vaults.map(async (vault): Promise<VaultCounters> => {
      if (inflight.has(vault)) {
        deps.logger.debug('vault.inflight', { vault })
        return { ...NO_COUNTS, skipped_inflight: 1 }
      }
      const { data, error } = await tryCatch(processVault(deps, vault))
      if (error) {
        deps.logger.error('vault.error', { vault, reason: deps.revertReason(error) })
        return { ...NO_COUNTS, errors: 1 }
      }
      return data
    })
  )

  const counters = settled.reduce<VaultCounters>(
    (acc, result) => {
      if (result.status === 'rejected') return { ...acc, errors: acc.errors + 1 }
      for (const key of COUNTER_KEYS) acc[key] += result.value[key]
      return acc
    },
    { ...NO_COUNTS }
  )

  deps.logger.info('tick.end', {
    blockNumber: deps.chainHead,
    vaults: deps.vaults.length,
    ...counters,
    duration_ms: Date.now() - started
  })
}
