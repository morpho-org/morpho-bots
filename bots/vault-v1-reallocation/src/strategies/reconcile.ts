import { MathLib } from '@morpho-org/blue-sdk'
import { maxUint256 } from 'viem'

import type { VaultData, VaultMarketData } from '../vault-data'
import type { MarketAllocation, Strategy } from './strategy'

import {
  getDepositableAmount,
  getUtilization,
  getUtilizationAfter,
  getWithdrawableAmount,
  MAX_TARGET_UTILIZATION
} from '../math'

/** Which way a classifier wants a market to move, decided on its RAW (unclamped) bound. */
export type MoveIntent = 'deposit' | 'withdraw'

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
   * Whether the move this market actually realizes is worth a transaction, judged by the classifier
   * in its own units (APY bips, utilization bips, …) against the post-move utilization the reconciler
   * reaches. A full-size move lands on {@link MarketTarget.targetUtilization}; a budget-trimmed one
   * stops short, and a fragment of a leg must not arm a plan.
   */
  clearsMinDelta: (utilizationAfter: bigint) => boolean
}

/** Verdict for one market; `undefined` leaves the market out of the plan entirely. */
export type Classify = (marketData: VaultMarketData) => MarketTarget | undefined

export type ReconcilerOptions = {
  /** WAD-scaled cap scale factor (e.g. 99.99% as 0.9999e18). */
  capBufferWad: bigint
  /**
   * `net` routes the withdraw/deposit imbalance through the vault's idle market (subject to
   * `allowIdleReallocation`); `ignore` keeps the idle market out of the plan, so the plan is sized to
   * the smaller of the two sides.
   */
  idle: 'net' | 'ignore'
  /** Only consulted under `idle: 'net'`: whether excess withdrawals may be parked in the idle market. */
  allowIdleReallocation?: boolean
  /** Built per vault so a strategy's target may depend on vault-wide aggregates. */
  classifierFor: (vaultData: VaultData) => Classify
}

type SizedMove = {
  marketData: VaultMarketData
  side: MoveIntent
  amount: bigint
  clearsMinDelta: MarketTarget['clearsMinDelta']
}

const { min } = MathLib

/**
 * Turns a per-market target-utilization classifier into a {@link Strategy}: sizes each market's move
 * with the clamped Blue math, optionally nets the imbalance through the idle market, trims both sides
 * to the shared budget in withdraw-queue order, and emits the `reallocate` legs (withdrawals first,
 * the budget-exhausting deposit as `maxUint256`).
 *
 * The min-delta firing gate is evaluated on the REALIZED move: each surviving leg's post-move
 * utilization is derived from its trimmed take and handed back to the classifier, so neither a leg the
 * budget consumed entirely nor one trimmed down to a dust fragment can arm the plan. Idle legs never
 * carry a verdict.
 *
 * This is the one place in the bot that builds legs; classifiers never size or trim. A classifier
 * DOES decide the side (`intent`, off its raw bound) and hand over an already-clamped target — see
 * {@link MarketTarget} and {@link MAX_TARGET_UTILIZATION}.
 */
export const createReconciler = (options: ReconcilerOptions): Strategy => {
  return vaultData => {
    const classify = options.classifierFor(vaultData)
    // A vault with several zero-collateral markets has only its first (in withdraw-queue order)
    // treated as the idle market; the rest are left out of the plan entirely.
    const idleMarket =
      options.idle === 'net'
        ? vaultData.marketsData.find(marketData => marketData.isIdle)
        : undefined

    const moves: SizedMove[] = []
    let totalWithdrawableAmount = 0n
    let totalDepositableAmount = 0n

    for (const marketData of vaultData.marketsData) {
      if (marketData.isIdle) continue
      const target = classify(marketData)
      if (target === undefined) continue
      // Inert backstop — classifiers already clamp. Kept so a future classifier that forgets cannot
      // size a leg against a >99.9% target.
      const targetUtilization = min(target.targetUtilization, MAX_TARGET_UTILIZATION)

      const utilization = getUtilization(marketData.state)
      const side = target.intent
      // An empty-or-backwards move is no move. The clamp can pull the target to the near side of
      // current utilization, and sizing the opposite leg would invert what the classifier asked for;
      // this generalizes the at-target skip to the whole wrong-side span. Deliberately NOT a
      // market-level policy skip — a dead cold market is still exited whenever it sits below the
      // clamped target.
      if (side === 'withdraw' ? utilization >= targetUtilization : utilization <= targetUtilization)
        continue

      const amount =
        side === 'deposit'
          ? getDepositableAmount(marketData, targetUtilization, options.capBufferWad)
          : getWithdrawableAmount(marketData, targetUtilization)

      if (side === 'deposit') totalDepositableAmount += amount
      else totalWithdrawableAmount += amount

      if (amount > 0n)
        moves.push({ marketData, side, amount, clearsMinDelta: target.clearsMinDelta })
    }

    let idleWithdrawal = 0n
    let idleDeposit = 0n

    if (idleMarket) {
      if (totalWithdrawableAmount > totalDepositableAmount && options.allowIdleReallocation) {
        // Same clamped-headroom treatment every other deposit target gets: a curator can lower a cap
        // below the current allocation, and an unclamped `cap - vaultAssets` would go negative and
        // corrupt the plan.
        const idleHeadroom = MathLib.zeroFloorSub(
          MathLib.wMulDown(idleMarket.cap, options.capBufferWad),
          idleMarket.vaultAssets
        )
        idleDeposit = min(totalWithdrawableAmount - totalDepositableAmount, idleHeadroom)
        totalDepositableAmount += idleDeposit
      } else if (totalDepositableAmount > totalWithdrawableAmount) {
        idleWithdrawal = min(
          totalDepositableAmount - totalWithdrawableAmount,
          idleMarket.vaultAssets
        )
        totalWithdrawableAmount += idleWithdrawal
      }
    }

    const toReallocate = min(totalWithdrawableAmount, totalDepositableAmount)
    if (toReallocate === 0n) return undefined

    let remainingWithdrawal = toReallocate
    let remainingDeposit = toReallocate
    let didClearMinDelta = false // true if *at least one surviving* leg moves enough

    const withdrawals: MarketAllocation[] = []
    const deposits: MarketAllocation[] = []

    for (const { marketData, side, amount, clearsMinDelta } of moves) {
      if (side === 'deposit') {
        const deposit = min(amount, remainingDeposit)
        if (deposit === 0n) continue
        remainingDeposit -= deposit
        didClearMinDelta ||= clearsMinDelta(getUtilizationAfter(marketData.state, side, deposit))
        deposits.push({
          marketParams: marketData.params,
          assets: remainingDeposit === 0n ? maxUint256 : marketData.vaultAssets + deposit
        })
      } else {
        const withdrawal = min(amount, remainingWithdrawal)
        if (withdrawal === 0n) continue
        remainingWithdrawal -= withdrawal
        didClearMinDelta ||= clearsMinDelta(getUtilizationAfter(marketData.state, side, withdrawal))
        withdrawals.push({
          marketParams: marketData.params,
          assets: marketData.vaultAssets - withdrawal
        })
      }

      if (remainingWithdrawal === 0n && remainingDeposit === 0n) break
    }

    if (!didClearMinDelta) return undefined

    if (idleMarket) {
      if (idleWithdrawal > 0n) {
        withdrawals.push({
          marketParams: idleMarket.params,
          assets: idleMarket.vaultAssets - idleWithdrawal
        })
      }
      if (idleDeposit > 0n) {
        deposits.push({ marketParams: idleMarket.params, assets: maxUint256 })
      }
    }

    return [...withdrawals, ...deposits]
  }
}
