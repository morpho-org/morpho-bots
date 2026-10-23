import type { PrepareOutcome, PrepareRequest } from '@repo/controller'
import type { Logger, SimulateResult } from '@repo/kit'
import type { Address, Hex } from 'viem'

import { tryCatch } from '@repo/utils'

import type { VaultReading } from './reallocation'
import type { MarketAllocation } from './strategies'

import { witnessOf } from './reallocation'
import { revertReason } from './revert.utils'

/** What a preparation builds from: the vault as read, and the reallocation its strategy found. */
type ReallocationInput = Readonly<{
  reading: VaultReading
  allocations: readonly MarketAllocation[]
}>

export type PrepareDeps = Readonly<{
  encode: (allocations: readonly MarketAllocation[]) => Hex
  simulate: (vault: Address, data: Hex) => Promise<SimulateResult>
  /** Read, plan and simulate, but hand the kernel nothing. */
  dryRun: boolean
  /** How long a prepared reallocation may wait to be submitted. */
  validForMs: number
  now: () => number
  logger: Logger
}>

/**
 * Prepares one vault's reallocation from the read its request captured: encodes the strategy's
 * allocations and simulates the exact calldata. A revert or a dry run declines until the next read.
 */
const prepareReallocation = async (
  request: PrepareRequest<ReallocationInput>,
  deps: PrepareDeps
): Promise<PrepareOutcome> => {
  const { reading, allocations } = request.input
  const vault = reading.vaultAddress
  const decline = (reason: string): PrepareOutcome => ({ ok: false, reason, backoff: false })
  deps.logger.info('reallocation.found', {
    vault,
    legs: allocations.length,
    allocations: allocations.map(allocation => ({
      collateralToken: allocation.marketParams.collateralToken,
      lltv: allocation.marketParams.lltv,
      assets: allocation.assets
    }))
  })
  const data = deps.encode(allocations)
  const sim = await deps.simulate(vault, data)
  if (sim.status === 'revert') {
    deps.logger.warn('reallocation.sim_revert', { vault, reason: sim.reason })
    return decline('reverted')
  }
  if (deps.dryRun) {
    deps.logger.info('reallocation.dry_run', { vault })
    return decline('dry_run')
  }
  return {
    ok: true,
    validUntil: deps.now() + deps.validForMs,
    steps: [
      {
        kind: 'tx',
        payload: { kind: 'tx', to: vault, data, value: 0n },
        witness: witnessOf(reading)
      }
    ]
  }
}

/** {@link prepareReallocation} as the family runs it: a throw is an error that backs the vault off. */
export const createReallocationPreparer =
  (deps: PrepareDeps) =>
  async (request: PrepareRequest<ReallocationInput>): Promise<PrepareOutcome> => {
    const answer = await tryCatch(prepareReallocation(request, deps))
    if (!answer.error) return answer.data
    deps.logger.error('vault.error', { vault: request.key, reason: revertReason(answer.error) })
    return { ok: false, reason: 'error', backoff: true }
  }
