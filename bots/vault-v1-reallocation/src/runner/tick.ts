import type { Logger, SimulateResult } from '@repo/bot-kit'
import type { Address, Hex } from 'viem'

import { tryCatch } from '@repo/utils'
import { isAddressEqual } from 'viem'

import type { MarketAllocation, Strategy } from '../strategies'
import type { VaultData } from '../vault-data'

export type TickDeps = {
  vaults: Address[]
  chainHead: bigint
  /** The reallocator EOA, compared against each fetched vault's owner and curator. */
  eoa: Address
  fetchVault: (vault: Address, blockNumber: bigint) => Promise<VaultData>
  strategy: Strategy
  encodeReallocate: (allocations: MarketAllocation[]) => Hex
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
  reallocations_found: number
  sim_reverts: number
  dry_runs: number
  submitted: number
  errors: number
}

// A zeroed counter set. Returned as a fresh copy every time — a shared constant would be one object
// the fold then mutates in place.
const noCounts = (): VaultCounters => ({
  skipped_inflight: 0,
  missing_role: 0,
  reallocations_found: 0,
  sim_reverts: 0,
  dry_runs: 0,
  submitted: 0,
  errors: 0
})

const COUNTER_KEYS = Object.keys(noCounts()) as (keyof VaultCounters)[]

const processVault = async (deps: TickDeps, vault: Address): Promise<VaultCounters> => {
  const vaultData = await deps.fetchVault(vault, deps.chainHead)

  // The whole of MetaMorpho's `onlyAllocatorRole`, all three parts read in the snapshot's single call.
  const hasRole =
    vaultData.isAllocator ||
    isAddressEqual(vaultData.owner, deps.eoa) ||
    isAddressEqual(vaultData.curator, deps.eoa)
  if (!hasRole) {
    deps.logger.warn('allocator.missing_role', { vault })
    return { ...noCounts(), missing_role: 1 }
  }

  // Surfaced because `apy-range` excludes these outright — the curve inversion it relies on needs a
  // real AdaptiveCurveIRM `rateAtTarget` (`equalize-utilizations` keeps them).
  if (vaultData.nonAdaptiveCurveMarketIds.length > 0) {
    deps.logger.debug('market.non_adaptive_curve', {
      vault,
      markets: vaultData.nonAdaptiveCurveMarketIds
    })
  }

  const allocations = deps.strategy(vaultData)
  if (!allocations) return noCounts()

  const summary = allocations.map(allocation => ({
    collateralToken: allocation.marketParams.collateralToken,
    lltv: allocation.marketParams.lltv,
    assets: allocation.assets
  }))
  deps.logger.info('reallocation.found', { vault, legs: allocations.length, allocations: summary })

  const data = deps.encodeReallocate(allocations)
  const sim = await deps.simulate(vault, data)
  if (sim.status === 'revert') {
    deps.logger.warn('reallocation.sim_revert', { vault, reason: sim.reason })
    return { ...noCounts(), reallocations_found: 1, sim_reverts: 1 }
  }

  if (deps.dryRun) {
    // The plan itself was just logged by reallocation.found — this line only marks the decision.
    deps.logger.info('reallocation.dry_run', { vault })
    return { ...noCounts(), reallocations_found: 1, dry_runs: 1 }
  }

  const sent = await deps.submit({ vault, data, blockNumber: deps.chainHead })
  if (!sent) deps.logger.debug('reallocation.not_broadcast', { vault })
  return { ...noCounts(), reallocations_found: 1, submitted: sent ? 1 : 0 }
}

/**
 * One reallocation pass: every whitelisted vault is processed concurrently — skip if a tx is in
 * flight, fetch a block-pinned snapshot (one deployless `eth_call`, roles included), skip (loudly) if
 * the EOA holds no allocator role, run the strategy, simulate the exact broadcast bytes, and submit (or
 * dry-run-log) on sim-ok. A failure in one vault logs `vault.error` and never blocks the others;
 * counters are folded after every vault settles and closed by one wide `tick.end` line.
 */
export const runTick = async (deps: TickDeps): Promise<void> => {
  const started = Date.now()
  const inflight = deps.inflightLabels()

  const settled = await Promise.allSettled(
    deps.vaults.map(async (vault): Promise<VaultCounters> => {
      if (inflight.has(vault)) {
        deps.logger.debug('vault.inflight', { vault })
        return { ...noCounts(), skipped_inflight: 1 }
      }
      const { data, error } = await tryCatch(processVault(deps, vault))
      if (error) {
        deps.logger.error('vault.error', { vault, reason: deps.revertReason(error) })
        return { ...noCounts(), errors: 1 }
      }
      return data
    })
  )

  const counters = settled.reduce<VaultCounters>((acc, result) => {
    if (result.status === 'rejected') return { ...acc, errors: acc.errors + 1 }
    for (const key of COUNTER_KEYS) acc[key] += result.value[key]
    return acc
  }, noCounts())

  deps.logger.info('tick.end', {
    blockNumber: deps.chainHead,
    vaults: deps.vaults.length,
    ...counters,
    duration_ms: Date.now() - started
  })
}
