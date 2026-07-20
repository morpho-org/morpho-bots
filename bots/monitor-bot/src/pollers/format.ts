import type { Chain } from 'viem'

import { abbreviateAddress, assertNever, tryCatch } from '@repo/utils'
import { formatUnits, isAddress, isHash } from 'viem'
import { base } from 'viem/chains'

import type { Alert } from '../alerts/alert'
import type { TransactionItem } from '../midnight/client'
import type { TokenInfo, TokenRegistry } from '../tokens/registry'

import { slackLink } from '../alerts/mrkdwn'
import { isBadDebtLiquidation } from './filter'

const CHAINS: Record<number, Chain> = { [base.id]: base }

// URL slots are the one place `slackLink` cannot escape (escaping would break the link), so both
// builders validate their API-sourced input and return null — degrading to a plain escaped label —
// rather than ever interpolating a string that could carry `|` or `>` into the mrkdwn construct.
export function explorerTxUrl(chainId: number, txHash: string) {
  const explorer = CHAINS[chainId]?.blockExplorers?.default.url
  return explorer && isHash(txHash) ? `${explorer}/tx/${txHash}` : null
}

export function explorerAddressUrl(chainId: number, address: string) {
  const explorer = CHAINS[chainId]?.blockExplorers?.default.url
  return explorer && isAddress(address, { strict: false }) ? `${explorer}/address/${address}` : null
}

/** Deployment label in alerts: the protocol plus the chain it runs on, e.g. `midnight-base`. */
export function chainLabel(chainId: number) {
  return `midnight-${CHAINS[chainId]?.name.toLowerCase() ?? chainId}`
}

function formatUtcTime(unixSeconds: number) {
  return `${new Date(unixSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

// Compact notation (20M, 1.5K) — headlines trade digits for glanceability; the linked explorer tx
// carries the exact figure. Significant digits rather than fraction digits so a dust-sized amount
// renders as 0.000042 instead of rounding to 0 — which is also why @repo/utils'
// formatTokenBalance (short mode floors at 0.01) is not reused here.
const COMPACT = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumSignificantDigits: 4
})

function compactAmount(raw: string, decimals: number) {
  // A malformed amount from the API shows verbatim rather than dropping the alert.
  const { data } = tryCatch(() => COMPACT.format(Number(formatUnits(BigInt(raw), decimals))))
  return data ?? raw
}

/** Loan/collateral-token amount, e.g. `20M USDC`; raw base units + "assets" when unresolved. */
export function tokenAmount(raw: string, token: TokenInfo | null) {
  if (!token) return `${raw} assets`
  return `${compactAmount(raw, token.decimals)} ${token.symbol ?? abbreviateAddress(token.address)}`
}

/**
 * Unit (face-value) amounts scale with the loan token's decimals but are NOT loan-token amounts
 * until maturity, so they keep the "units" word instead of borrowing the token's symbol.
 */
export function unitsAmount(raw: string, loanToken: TokenInfo | null) {
  return loanToken ? `${compactAmount(raw, loanToken.decimals)} units` : `${raw} units`
}

type TransactionAlertParameters = {
  item: TransactionItem
  /** The linked lead segment: `$size $symbol $action`. */
  headline: string
  actor: string
  /** "by" for the acting account; "of" when the address is the liquidated borrower. */
  preposition?: 'by' | 'of'
  severity: Alert['severity']
}

// ($size $symbol $action)[tx link] by ($address)[explorer link] on midnight-<chain> at $time
function transactionAlert({
  item,
  headline,
  actor,
  preposition = 'by',
  severity
}: TransactionAlertParameters): Alert {
  const where = `on ${chainLabel(item.chain_id)} at ${formatUtcTime(item.created_at)}`
  const short = abbreviateAddress(actor)
  return {
    key: item.id,
    title: `${headline} ${preposition} ${short} ${where}`,
    text: [
      slackLink(explorerTxUrl(item.chain_id, item.tx_hash), headline),
      preposition,
      slackLink(explorerAddressUrl(item.chain_id, actor), short),
      where
    ].join(' '),
    severity
  }
}

// Which collateral an event moved comes from the event's own `data.collateral` — the registry's
// per-market collateral list cannot identify it (markets accept several).
function collateralToken(tokens: TokenRegistry, marketId: string, collateral: string) {
  const market = tokens.get(marketId)
  if (!market || !isAddress(collateral, { strict: false })) return null
  return tokens.token(market.chainId, collateral)
}

export function formatTransactionAlert(item: TransactionItem, tokens: TokenRegistry): Alert {
  const loan = tokens.loanTokenInfo(item.market_id)
  switch (item.event_type) {
    case 'lend':
      return transactionAlert({
        item,
        headline: `${tokenAmount(item.data.assets, loan)} lend`,
        actor: item.data.account,
        severity: 'info'
      })
    case 'borrow':
      return transactionAlert({
        item,
        headline: `${tokenAmount(item.data.assets, loan)} borrow`,
        actor: item.data.account,
        severity: 'info'
      })
    case 'exit_lend_secondary':
      return transactionAlert({
        item,
        headline: `${tokenAmount(item.data.assets, loan)} lend exit`,
        actor: item.data.account,
        severity: 'info'
      })
    case 'exit_borrow_secondary':
      return transactionAlert({
        item,
        headline: `${tokenAmount(item.data.assets, loan)} repay`,
        actor: item.data.account,
        severity: 'info'
      })
    case 'exit_lend_primary':
    case 'exit_borrow_primary':
      return transactionAlert({
        item,
        headline: `${unitsAmount(item.data.units, loan)} ${
          item.event_type === 'exit_borrow_primary' ? 'repay' : 'lend exit'
        } (primary)`,
        actor: item.data.account,
        severity: 'info'
      })
    case 'supply_collateral':
    case 'withdraw_collateral':
      return transactionAlert({
        item,
        headline: `${tokenAmount(
          item.data.assets,
          collateralToken(tokens, item.market_id, item.data.collateral)
        )} collateral ${item.event_type === 'supply_collateral' ? 'supply' : 'withdraw'}`,
        actor: item.data.account,
        severity: 'info'
      })
    case 'partial_liquidation':
    case 'full_liquidation': {
      const kind =
        item.event_type === 'full_liquidation' ? 'full liquidation' : 'partial liquidation'
      const badDebt = isBadDebtLiquidation(item)
      return transactionAlert({
        item,
        headline: badDebt
          ? `BAD DEBT — ${unitsAmount(item.data.bad_debt, loan)} bad debt (${kind})`
          : `${unitsAmount(item.data.repaid_units, loan)} ${kind}`,
        actor: item.data.borrower,
        preposition: 'of',
        severity: badDebt ? 'critical' : 'warning'
      })
    }
    default:
      return assertNever(item)
  }
}
