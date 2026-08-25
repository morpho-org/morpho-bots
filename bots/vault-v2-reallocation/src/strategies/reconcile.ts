import { MathLib } from '@morpho-org/blue-sdk'
import { getAddress } from 'viem'

import type { VaultV2Data, VaultV2MarketData } from '../vault-data'
import type { ReallocationAction, Strategy } from './strategy'

import {
  createDepositPools,
  creditPools,
  getDepositableAmount,
  getUtilization,
  getUtilizationAfter,
  getWithdrawableAmount,
  MAX_TARGET_UTILIZATION,
  takeFromPools
} from '../math'

/** Which way a classifier wants a market to move, decided on its RAW (unclamped) bound. */
export type MoveIntent = 'allocate' | 'deallocate'

/** Where one market should sit, and whether getting it there is worth a transaction. */
export type MarketTarget = {
  /** Already clamped to {@link MAX_TARGET_UTILIZATION}; the move is sized against this. */
  targetUtilization: bigint
  /**
   * The direction the raw bound asked for. Carried separately because the clamp can pull the target
   * to the near side of current utilization, and re-deriving the side from the clamped target would
   * then emit the opposite leg.
   */
  intent: MoveIntent
  /**
   * Whether a move that lands this market at `utilizationAfter` clears the min-delta. The reconciler
   * calls it with the REALIZED endpoint of the trimmed leg — a full move lands at the clamped
   * target, but a leg cut down by the budget or the cap pools lands short, and a fragment must not
   * arm the plan on the delta its classifier originally wanted.
   */
  clearsMinDelta: (utilizationAfter: bigint) => boolean
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
  amount: bigint
  clearsMinDelta: MarketTarget['clearsMinDelta']
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
 * The min-delta firing gate is evaluated on the TRIMMED legs' REALIZED endpoints: each surviving
 * take is converted back to the utilization it lands the market at, and the classifier judges that
 * delta — a clearing move cut down to a fragment by the budget or the cap pools cannot arm the
 * plan, so a fired plan always contains at least one leg worth its transaction.
 *
 * Deallocations resolve FIRST in both phases — the contract executes them first, so their amounts
 * credit the aggregate cap pools that allocation sizing then draws from; the emission phase re-runs
 * the pools with the TRIMMED deallocation credits so per-collateral funding stays exact even when
 * the deallocation budget clamps.
 *
 * This is the one place in the bot that builds legs; classifiers never size or trim. A classifier
 * DOES decide the side (`intent`, off its raw bound) and hands over an already-clamped target — see
 * {@link MarketTarget} and {@link MAX_TARGET_UTILIZATION}.
 */
export const createReconciler = (options: ReconcilerOptions): Strategy => {
  return vaultData => {
    const classify = options.classifierFor(vaultData)
    const classified = vaultData.marketsData.flatMap(marketData => {
      const verdict = classify(marketData)
      if (verdict === undefined) return []
      // Inert backstop — classifiers already clamp. Kept so a future classifier that forgets
      // cannot size a leg against a >99.9% target.
      const targetUtilization = min(verdict.targetUtilization, MAX_TARGET_UTILIZATION)
      const utilization = getUtilization(marketData.state)
      const side = verdict.intent
      // An empty-or-backwards move is no move. The clamp can pull the target to the near side of
      // current utilization, and sizing the opposite leg would invert what the classifier asked
      // for; this generalizes the at-target skip to the whole wrong-side span. Deliberately NOT a
      // market-level policy skip — a dead cold market is still exited whenever it sits below the
      // clamped target.
      if (
        side === 'deallocate' ? utilization >= targetUtilization : utilization <= targetUtilization
      ) {
        return []
      }
      return [
        { marketData, side, target: { targetUtilization, clearsMinDelta: verdict.clearsMinDelta } }
      ]
    })

    const deallocateMoves: SizedMove[] = []
    const allocateMoves: SizedMove[] = []
    let totalAmountToDeallocate = 0n
    let totalAmountToAllocate = 0n

    const sizingPools = createDepositPools(vaultData, options.capBufferWad)
    for (const { marketData, side, target } of classified) {
      if (side !== 'deallocate') continue
      const amount = getWithdrawableAmount(marketData, target.targetUtilization)
      totalAmountToDeallocate += amount
      creditPools(sizingPools, marketData.params.collateralToken, amount)
      if (amount > 0n) {
        deallocateMoves.push({ marketData, amount, clearsMinDelta: target.clearsMinDelta })
      }
    }
    for (const { marketData, side, target } of classified) {
      if (side !== 'allocate') continue
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
        allocateMoves.push({ marketData, amount, clearsMinDelta: target.clearsMinDelta })
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

    type EmittedLeg = { move: SizedMove; assets: bigint }
    const emittedDeallocations: EmittedLeg[] = []
    const emittedAllocations: EmittedLeg[] = []

    const legPools = createDepositPools(vaultData, options.capBufferWad)
    for (const move of deallocateMoves) {
      if (remainingAmountToDeallocate === 0n) break
      // Sized amounts and the remaining budget are both positive here, so the take always is.
      const toDeallocate = min(move.amount, remainingAmountToDeallocate)
      remainingAmountToDeallocate -= toDeallocate
      creditPools(legPools, move.marketData.params.collateralToken, toDeallocate)
      emittedDeallocations.push({ move, assets: toDeallocate })
    }
    for (const move of allocateMoves) {
      if (remainingAmountToAllocate === 0n) break
      const toAllocate = takeFromPools(
        legPools,
        move.marketData.params.collateralToken,
        min(move.amount, remainingAmountToAllocate)
      )
      remainingAmountToAllocate -= toAllocate
      if (toAllocate > 0n) emittedAllocations.push({ move, assets: toAllocate })
    }

    if (!options.allowIdleParking) {
      // The deallocation budget trim can keep a leg whose planned counterpart allocation was then
      // clamped away by the cap pools — the sides no longer match, and the mismatch would park in
      // idle against the operator's setting. Shrink deallocations in reverse by credits no
      // allocation consumed: each reduction is bounded by the leg's own collateral leftover and
      // the shared adapter leftover, so every emitted allocation keeps its on-chain funding.
      const allocated = emittedAllocations.reduce((acc, leg) => acc + leg.assets, 0n)
      let surplus = emittedDeallocations.reduce((acc, leg) => acc + leg.assets, 0n) - allocated
      for (let i = emittedDeallocations.length - 1; i >= 0 && surplus > 0n; i--) {
        const leg = emittedDeallocations[i]!
        const room = legPools.byCollateral.get(
          getAddress(leg.move.marketData.params.collateralToken)
        )
        const reducible = min(
          min(surplus, leg.assets),
          min(legPools.adapter.headroom, room?.headroom ?? 0n)
        )
        leg.assets -= reducible
        legPools.adapter.headroom -= reducible
        if (room) room.headroom -= reducible
        surplus -= reducible
      }
      // Unreachable by construction — every credit either funded an allocation or is still pool
      // leftover — but refusing to plan beats parking assets in idle.
      if (surplus > 0n) return undefined
    }

    // The min-delta gate judges the FINAL legs' realized endpoints (see the TSDoc above).
    let didClearMinDelta = false
    const allocations: ReallocationAction[] = []
    const deallocations: ReallocationAction[] = []
    for (const { move, assets } of emittedDeallocations) {
      if (assets === 0n) continue
      didClearMinDelta ||= move.clearsMinDelta(
        getUtilizationAfter(move.marketData.state, 'deallocate', assets)
      )
      deallocations.push(toLeg(move, assets))
    }
    for (const { move, assets } of emittedAllocations) {
      didClearMinDelta ||= move.clearsMinDelta(
        getUtilizationAfter(move.marketData.state, 'allocate', assets)
      )
      allocations.push(toLeg(move, assets))
    }

    if (!didClearMinDelta) return undefined
    return { allocations, deallocations }
  }
}
