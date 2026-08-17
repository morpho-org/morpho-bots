import { MathLib } from '@morpho-org/blue-sdk'
import { maxUint256 } from 'viem'

import type { VaultData, VaultMarketData } from '../vault-data'
import type { MarketAllocation, Strategy } from './strategy'

import { isIdleMarket } from '../market.utils'
import { getDepositableAmount, getUtilization, getWithdrawableAmount } from '../math'

/** Where one market should sit, and whether getting it there is worth a transaction. */
export type MarketTarget = {
  targetUtilization: bigint
  /** Whether this market's own move clears the strategy's min-delta threshold. */
  clearsMinDelta: boolean
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
  side: 'deposit' | 'withdraw'
  amount: bigint
  clearsMinDelta: boolean
}

const { min } = MathLib

/**
 * Turns a per-market target-utilization classifier into a {@link Strategy}: sizes each market's move
 * with the clamped Blue math, optionally nets the imbalance through the idle market, trims both sides
 * to the shared budget in withdraw-queue order, and emits the `reallocate` legs (withdrawals first,
 * the budget-exhausting deposit as `maxUint256`).
 *
 * The min-delta firing gate is evaluated on the TRIMMED legs: a market whose move clears the
 * threshold but whose take is entirely consumed by the budget cannot arm the plan, so a fired plan
 * always contains at least one surviving leg worth its transaction. Idle legs never carry a verdict.
 *
 * This is the one place in the bot that builds legs; classifiers never size or clamp.
 */
export const createReconciler = (options: ReconcilerOptions): Strategy => {
  return vaultData => {
    const classify = options.classifierFor(vaultData)
    const idleMarket = options.idle === 'net' ? vaultData.marketsData.find(isIdleMarket) : undefined

    const moves: SizedMove[] = []
    let totalWithdrawableAmount = 0n
    let totalDepositableAmount = 0n

    for (const marketData of vaultData.marketsData) {
      if (isIdleMarket(marketData)) continue
      const target = classify(marketData)
      if (target === undefined) continue

      const utilization = getUtilization(marketData.state)
      if (utilization === target.targetUtilization) continue

      const side = utilization > target.targetUtilization ? 'deposit' : 'withdraw'
      const amount =
        side === 'deposit'
          ? getDepositableAmount(marketData, target.targetUtilization, options.capBufferWad)
          : getWithdrawableAmount(marketData, target.targetUtilization)

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
        const bufferedIdleCap = MathLib.wMulDown(idleMarket.cap, options.capBufferWad)
        const idleHeadroom =
          bufferedIdleCap > idleMarket.vaultAssets ? bufferedIdleCap - idleMarket.vaultAssets : 0n
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
        didClearMinDelta ||= clearsMinDelta
        deposits.push({
          marketParams: marketData.params,
          assets: remainingDeposit === 0n ? maxUint256 : marketData.vaultAssets + deposit
        })
      } else {
        const withdrawal = min(amount, remainingWithdrawal)
        if (withdrawal === 0n) continue
        remainingWithdrawal -= withdrawal
        didClearMinDelta ||= clearsMinDelta
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
