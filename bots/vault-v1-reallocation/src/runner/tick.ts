import type { Logger, SimulateResult, SubmitOutcome } from '@repo/bot-kit'
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
  /**
   * One deployless read covering every eligible vault. Returns a map keyed by lower-cased vault
   * address; a vault the lens could not serve is simply absent.
   */
  fetchVaults: (vaults: readonly Address[], blockNumber: bigint) => Promise<Map<string, VaultData>>
  strategy: Strategy
  encodeReallocate: (allocations: MarketAllocation[]) => Hex
  simulate: (vault: Address, data: Hex) => Promise<SimulateResult>
  /** Resolves true only when the transaction was actually broadcast. */
  submit: (params: { vault: Address; data: Hex }) => Promise<SubmitOutcome>
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

const processVault = async (
  deps: TickDeps,
  vault: Address,
  vaultData: VaultData
): Promise<VaultCounters> => {
  // The whole of Vault V1's `onlyAllocatorRole`, all three parts read in the snapshot's single call.
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

  const outcome = await deps.submit({ vault, data })
  if (!outcome.sent) {
    deps.logger.debug('reallocation.not_broadcast', { vault, reason: outcome.reason })
  }
  return { ...noCounts(), reallocations_found: 1, submitted: outcome.sent ? 1 : 0 }
}

/**
 * One reallocation pass: in-flight vaults are dropped, the rest are read in ONE block-pinned
 * deployless call (roles included), then processed concurrently — skip (loudly) if the EOA holds no
 * allocator role, run the strategy, simulate the exact broadcast bytes, and submit (or dry-run-log)
 * on sim-ok. A failure in one vault logs `vault.error` and never blocks the others; counters are
 * folded after every vault settles and closed by one wide `tick.end` line.
 *
 * The read is batched, so unlike the per-vault work it is a single point of failure: a rejected
 * request costs every vault this pass rather than one, and the interval gate means the retry is the
 * next reallocation interval rather than the next block. That is the trade for N-1 fewer round trips
 * and N-1 fewer deployless deploys; the failure is fanned out below so the counters and `vault.error`
 * lines still read per vault.
 */
export const runTick = async (deps: TickDeps): Promise<void> => {
  const started = Date.now()
  const inflight = deps.inflightLabels()

  // Filtered BEFORE the read, not per vault after it: an in-flight vault should not be paid for.
  const eligible = deps.vaults.filter(vault => {
    if (!inflight.has(vault)) return true
    deps.logger.debug('vault.inflight', { vault })
    return false
  })
  const skippedInflight = deps.vaults.length - eligible.length

  const snapshot = await tryCatch(
    eligible.length === 0
      ? Promise.resolve(new Map<string, VaultData>())
      : deps.fetchVaults(eligible, deps.chainHead)
  )
  if (snapshot.error) {
    // One rejection yields no rows at all, so the per-vault lines have to be emitted explicitly or
    // the tick would close having silently done nothing for the whole whitelist.
    const reason = deps.revertReason(snapshot.error)
    for (const vault of eligible) deps.logger.error('vault.error', { vault, reason })
    deps.logger.info('tick.end', {
      blockNumber: deps.chainHead,
      ...noCounts(),
      skipped_inflight: skippedInflight,
      errors: eligible.length,
      vaults: deps.vaults.length,
      duration_ms: Date.now() - started
    })
    return
  }

  // Never rejects: every mapped element folds its own failure into a counter via `tryCatch`.
  const perVault = await Promise.all(
    eligible.map(async (vault): Promise<VaultCounters> => {
      const vaultData = snapshot.data.get(vault.toLowerCase())
      if (!vaultData) {
        deps.logger.error('vault.error', { vault, reason: 'lens returned no row for this vault' })
        return { ...noCounts(), errors: 1 }
      }
      const { data, error } = await tryCatch(processVault(deps, vault, vaultData))
      if (error) {
        deps.logger.error('vault.error', { vault, reason: deps.revertReason(error) })
        return { ...noCounts(), errors: 1 }
      }
      return data
    })
  )

  const counters = perVault.reduce<VaultCounters>((acc, result) => {
    for (const key of COUNTER_KEYS) acc[key] += result[key]
    return acc
  }, noCounts())
  counters.skipped_inflight += skippedInflight

  deps.logger.info('tick.end', {
    blockNumber: deps.chainHead,
    vaults: deps.vaults.length,
    ...counters,
    duration_ms: Date.now() - started
  })
}
