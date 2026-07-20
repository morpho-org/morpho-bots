import type { Address } from 'viem'

import { assertNever } from '@repo/utils'
import { isAddress, isAddressEqual } from 'viem'

import type { TransactionItem } from '../midnight/client'

type TransactionFilterConfig = {
  /** Minimum attributed size in loan-token base units; 0 disables the size filter. */
  minAssets: bigint
  /** When non-empty, only items whose position owner (`data.account`) is listed pass. */
  users: Address[]
}

// A liquidation that realizes bad debt is THE curator signal: it is socialized to lenders via the
// loss factor, so it must never be filtered out by size or user scoping.
export function isBadDebtLiquidation(item: TransactionItem) {
  if (item.event_type !== 'partial_liquidation' && item.event_type !== 'full_liquidation') {
    return false
  }
  return BigInt(item.data.bad_debt) > 0n || item.data.pure_bad_debt_realization
}

// The comparable "size" of an item differs per payload: trades carry the attributed loan-token
// `assets`; primary exits only carry `units` (face value at maturity); liquidations are sized by
// the repaid debt.
export function sizeOf(item: TransactionItem): bigint {
  switch (item.event_type) {
    case 'lend':
    case 'borrow':
    case 'exit_lend_secondary':
    case 'exit_borrow_secondary':
    case 'supply_collateral':
    case 'withdraw_collateral':
      return BigInt(item.data.assets)
    case 'exit_lend_primary':
    case 'exit_borrow_primary':
      return BigInt(item.data.units)
    case 'partial_liquidation':
    case 'full_liquidation':
      return BigInt(item.data.repaid_units)
    default:
      return assertNever(item)
  }
}

export class TransactionFilter {
  constructor(private readonly config: TransactionFilterConfig) {}

  matches(item: TransactionItem) {
    if (isBadDebtLiquidation(item)) return true
    return this.matchesUser(item) && sizeOf(item) >= this.config.minAssets
  }

  private matchesUser(item: TransactionItem) {
    if (this.config.users.length === 0) return true
    const account = item.data.account
    if (!isAddress(account)) return false
    return this.config.users.some(user => isAddressEqual(user, account))
  }
}
