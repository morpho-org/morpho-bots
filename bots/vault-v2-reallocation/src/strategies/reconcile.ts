import { MathLib } from '@morpho-org/blue-sdk'
import { wholePercentToWAD } from '@repo/utils'

import type { VaultV2Data, VaultV2MarketData } from '../vault-data'
import type { Reallocation, ReallocationAction, Strategy } from './strategy'

import {
  createDepositPools,
  creditPools,
  getDepositableAmount,
  getUtilization,
  getWithdrawableAmount,
  takeFromPools
} from '../math'

/**
 * Ceiling on any classifier target: a WAD target (an APY bound past the curve's max on a market
 * whose `rateAtTarget` decayed toward the minimum, or an aggregate utilization at/above 100%)
 * would size a deallocation to the market's ENTIRE free liquidity — exact to the snapshot and
 * unrealizable one accrual later, so the plan sim-passes then reverts on-chain forever. The ~10
 * bips left behind scale with the market's borrow, which is what accrues; deliberately looser than
 * the 99.99% cap buffer, whose sliver absorbs supply-side drift instead.
 */
const MAX_TARGET_UTILIZATION = wholePercentToWAD(99.9)

/** Where one market should sit, and whether getting it there is worth a transaction. */
export type MarketTarget = {
  targetUtilization: bigint
  /** Whether this market's own move clears the strategy's min-delta threshold. */
  clearsMinDelta: boolean
}

/** Verdict for one market; `undefined` leaves the market out of the plan entirely. */
export type Classify = (marketData: VaultV2MarketData) => MarketTarget | undefined

type ReconcilerOptions = {
  /** WAD-scaled cap scale factor (e.g. 99.99% as 0.9999e18). */
  capBufferWad: bigint
  /**
   * Whether excess deallocations may park in the vault's idle balance; when off, deallocations are
   * clamped to the allocation total. Allocations always draw on idle (up to `idleAssets`) — beyond
   * that `allocate` would pull more than the vault balance holds and revert.
   */
  allowIdleParking: boolean
  /** Built per vault so a strategy's target may depend on vault-wide aggregates. */
  classifierFor: (vaultData: VaultV2Data) => Classify
}

type SizedMove = {
  marketData: VaultV2MarketData
  side: 'allocate' | 'deallocate'
  amount: bigint
  clearsMinDelta: boolean
}

const { min } = MathLib

const toLeg = ({ marketData }: SizedMove, assets: bigint): ReallocationAction => ({
  marketId: marketData.id,
  marketParams: marketData.params,
  assets
})

/**
 * Turns a per-market target-utilization classifier into a {@link Strategy}: sizes each market's move
 * with the clamped Blue math and the three-level cap pools, nets the imbalance through the vault's
 * idle balance, trims both sides to the shared budget in market order, and emits the
 * `{allocations, deallocations}` delta legs.
 *
 * The min-delta firing gate is evaluated on the TRIMMED legs: a market whose move clears the
 * threshold but whose take is entirely consumed by the budget or the cap pools cannot arm the
 * plan, so a fired plan always contains at least one surviving leg worth its transaction.
 *
 * Deallocations resolve FIRST in both phases — the contract executes them first, so their amounts
 * credit the aggregate cap pools that allocation sizing then draws from; the emission phase re-runs
 * the pools with the TRIMMED deallocation credits so per-collateral funding stays exact even when
 * the deallocation budget clamps.
 *
 * This is the one place in the bot that builds legs; classifiers never size or clamp.
 */
export const createReconciler = (options: ReconcilerOptions): Strategy => {
  return vaultData => {
    const classify = options.classifierFor(vaultData)
    const classified = vaultData.marketsData.flatMap(marketData => {
      const verdict = classify(marketData)
      if (verdict === undefined) return []
      // Feasibility is the reconciler's job: every target is clamped to what a leg can realize.
      const target = {
        ...verdict,
        targetUtilization: min(verdict.targetUtilization, MAX_TARGET_UTILIZATION)
      }
      const utilization = getUtilization(marketData.state)
      // At the target exactly there is nothing to move — skip before sizing.
      if (utilization === target.targetUtilization) return []
      return [{ marketData, target, utilization }]
    })

    const moves: SizedMove[] = []
    let totalAmountToDeallocate = 0n
    let totalAmountToAllocate = 0n

    const sizingPools = createDepositPools(vaultData, options.capBufferWad)
    for (const { marketData, target, utilization } of classified) {
      if (utilization > target.targetUtilization) continue
      const amount = getWithdrawableAmount(marketData, target.targetUtilization)
      totalAmountToDeallocate += amount
      creditPools(sizingPools, marketData.params.collateralToken, amount)
      if (amount > 0n) {
        moves.push({
          marketData,
          side: 'deallocate',
          amount,
          clearsMinDelta: target.clearsMinDelta
        })
      }
    }
    for (const { marketData, target, utilization } of classified) {
      if (utilization < target.targetUtilization) continue
      const amount = takeFromPools(
        sizingPools,
        marketData.params.collateralToken,
        getDepositableAmount(
          marketData,
          vaultData.totalAssets,
          target.targetUtilization,
          options.capBufferWad
        )
      )
      totalAmountToAllocate += amount
      if (amount > 0n) {
        moves.push({ marketData, side: 'allocate', amount, clearsMinDelta: target.clearsMinDelta })
      }
    }

    if (totalAmountToDeallocate > totalAmountToAllocate && !options.allowIdleParking) {
      totalAmountToDeallocate = totalAmountToAllocate
    } else if (totalAmountToAllocate > totalAmountToDeallocate) {
      // `allocate` pulls from the vault's asset balance: only this plan's own deallocations plus
      // the existing idle can fund allocations — anything beyond reverts the whole multicall.
      totalAmountToAllocate =
        totalAmountToDeallocate +
        min(totalAmountToAllocate - totalAmountToDeallocate, vaultData.idleAssets)
    }

    if (min(totalAmountToDeallocate, totalAmountToAllocate) === 0n) return undefined

    let remainingAmountToDeallocate = totalAmountToDeallocate
    let remainingAmountToAllocate = totalAmountToAllocate
    let didClearMinDelta = false // true if *at least one surviving* leg moves enough

    const allocations: ReallocationAction[] = []
    const deallocations: ReallocationAction[] = []

    const legPools = createDepositPools(vaultData, options.capBufferWad)
    for (const move of moves) {
      if (move.side !== 'deallocate') continue
      if (remainingAmountToDeallocate === 0n) break
      const toDeallocate = min(move.amount, remainingAmountToDeallocate)
      remainingAmountToDeallocate -= toDeallocate
      creditPools(legPools, move.marketData.params.collateralToken, toDeallocate)
      if (toDeallocate > 0n) {
        didClearMinDelta ||= move.clearsMinDelta
        deallocations.push(toLeg(move, toDeallocate))
      }
    }
    for (const move of moves) {
      if (move.side !== 'allocate') continue
      if (remainingAmountToAllocate === 0n) break
      const toAllocate = takeFromPools(
        legPools,
        move.marketData.params.collateralToken,
        min(move.amount, remainingAmountToAllocate)
      )
      remainingAmountToAllocate -= toAllocate
      if (toAllocate > 0n) {
        didClearMinDelta ||= move.clearsMinDelta
        allocations.push(toLeg(move, toAllocate))
      }
    }

    if (!didClearMinDelta) return undefined
    return { allocations, deallocations } satisfies Reallocation
  }
}
