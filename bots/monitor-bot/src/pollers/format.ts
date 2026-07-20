import { assertNever } from '@repo/utils'

import type { Alert } from '../alerts/alert'
import type { TransactionItem } from '../midnight/client'

import { isBadDebtLiquidation } from './filter'

const EXPLORERS: Record<number, string> = { 8453: 'https://basescan.org' }

export function explorerTxUrl(chainId: number, txHash: string) {
  const base = EXPLORERS[chainId]
  return base ? `${base}/tx/${txHash}` : txHash
}

// Amounts are raw loan-token base units — token decimals/symbols are not exposed by this API, so
// human-unit rendering is deferred (the market id + explorer link give full context).
function shortMarket(marketId: string) {
  return `${marketId.slice(0, 10)}…${marketId.slice(-4)}`
}

function baseLines(item: TransactionItem) {
  return [
    `market: ${shortMarket(item.market_id)}`,
    `account: ${item.data.account}`,
    `tx: ${explorerTxUrl(item.chain_id, item.tx_hash)}`
  ]
}

function tradeAlert(
  item: TransactionItem & {
    event_type: 'lend' | 'borrow' | 'exit_lend_secondary' | 'exit_borrow_secondary'
  },
  title: string
): Alert {
  return {
    key: item.id,
    title: `${title}: ${item.data.assets} assets`,
    lines: [
      ...baseLines(item),
      `maker: ${item.data.maker}`,
      `taker: ${item.data.taker}`,
      `units: ${item.data.units} (trade total: ${item.data.take_units})`
    ],
    severity: 'info'
  }
}

function liquidationAlert(
  item: TransactionItem & { event_type: 'partial_liquidation' | 'full_liquidation' }
): Alert {
  const badDebt = isBadDebtLiquidation(item)
  const kind = item.event_type === 'full_liquidation' ? 'full liquidation' : 'partial liquidation'
  return {
    key: item.id,
    title: badDebt
      ? `BAD DEBT — ${kind}: ${item.data.bad_debt} bad debt`
      : `${kind}: ${item.data.repaid_units} units repaid`,
    lines: [
      ...baseLines(item),
      `borrower: ${item.data.borrower}`,
      `seized: ${item.data.seized_assets} collateral (${item.data.collateral})`,
      `repaid: ${item.data.repaid_units} units`,
      `post-maturity: ${item.data.post_maturity_mode}`
    ],
    severity: badDebt ? 'critical' : 'warning'
  }
}

export function formatTransactionAlert(item: TransactionItem): Alert {
  switch (item.event_type) {
    case 'lend':
      return tradeAlert(item, 'take order (lend)')
    case 'borrow':
      return tradeAlert(item, 'take order (borrow)')
    case 'exit_lend_secondary':
      return tradeAlert(item, 'lend exit (secondary trade)')
    case 'exit_borrow_secondary':
      return tradeAlert(item, 'repay (secondary trade)')
    case 'exit_lend_primary':
    case 'exit_borrow_primary':
      return {
        key: item.id,
        title: `${item.event_type === 'exit_borrow_primary' ? 'repay (primary)' : 'lend exit (primary)'}: ${item.data.units} units (face value)`,
        lines: baseLines(item),
        severity: 'info'
      }
    case 'supply_collateral':
    case 'withdraw_collateral':
      return {
        key: item.id,
        title: `${item.event_type === 'supply_collateral' ? 'collateral supplied' : 'collateral withdrawn'}: ${item.data.assets}`,
        lines: [...baseLines(item), `collateral: ${item.data.collateral}`],
        severity: 'info'
      }
    case 'partial_liquidation':
    case 'full_liquidation':
      return liquidationAlert(item)
    default:
      return assertNever(item)
  }
}
