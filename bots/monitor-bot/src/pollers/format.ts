import type { Address, Chain } from 'viem'

import { TickLib } from '@morpho-org/midnight-sdk'
import { abbreviateAddress, assertNever, tryCatch } from '@repo/utils'
import { formatUnits, getAddress, isAddress, isHash } from 'viem'
import { base } from 'viem/chains'

import type { Alert } from '../alerts/alert'
import type { TransactionItem } from '../midnight/client'
import type { PriceLookup } from '../tokens/prices'
import type { TokenEntry, TokenRegistry } from '../tokens/registry'
import type { TakePair } from './take'

import { escapeSlack, slackLink } from '../alerts/mrkdwn'
import { formatUtcDate, formatUtcTime } from '../alerts/time'
import { isBadDebtLiquidation } from './filter'

const CHAINS: Record<number, Chain> = { [base.id]: base }

// URL slots are the one place `slackLink` cannot escape (escaping would break the link), so the
// builders validate their API-sourced input and return null — degrading to a plain escaped label
// or an omitted link — rather than ever interpolating a string that could carry `|` or `>` into
// the mrkdwn construct.
export function explorerTxUrl(chainId: number, txHash: string) {
  const explorer = CHAINS[chainId]?.blockExplorers?.default.url
  return explorer && isHash(txHash) ? `${explorer}/tx/${txHash}` : null
}

export function explorerAddressUrl(chainId: number, address: string) {
  const explorer = CHAINS[chainId]?.blockExplorers?.default.url
  return explorer && isAddress(address, { strict: false }) ? `${explorer}/address/${address}` : null
}

/** Debank shows the address's cross-protocol portfolio — the alert link row's second entry. */
export function debankUrl(address: string) {
  return isAddress(address, { strict: false }) ? `https://debank.com/profile/${address}` : null
}

/** Explorer name for the link row, e.g. `Basescan`; only rendered when the URL builders resolve. */
function explorerName(chainId: number) {
  return CHAINS[chainId]?.blockExplorers?.default.name ?? 'Explorer'
}

/** Deployment label in alerts: the protocol plus the chain it runs on, e.g. `midnight-base`. */
export function chainLabel(chainId: number) {
  return `midnight-${CHAINS[chainId]?.name.toLowerCase() ?? chainId}`
}

// Compact notation (20M, 1.5K) — headlines trade digits for glanceability; the linked explorer tx
// carries the exact figure. Significant digits rather than fraction digits so a dust-sized amount
// renders as 0.000042 instead of rounding to 0 — which is also why @repo/utils'
// formatTokenBalance (short mode floors at 0.01) is not reused here.
const COMPACT = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumSignificantDigits: 4
})

/** `$553.31K` — USD context next to a token amount, in the channel's compact-currency shape. */
const USD = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2
})

/** Average trade price (loan token per unit) — a ratio near 1, so plain significant digits. */
const PRICE = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 4 })

/**
 * `1.25% APR` — adjacent ticks sit ~2.5bp apart at typical rates, so 2 decimals resolves them.
 * Not @repo/utils' formatUint256Percent, which truncates instead of rounding (2.5076% renders as
 * `2.5%`), dropping the second decimal that separates neighbouring ticks.
 */
const APR = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

function compactAmount(raw: string, decimals: number) {
  // A malformed amount from the API shows verbatim rather than dropping the alert.
  const { data } = tryCatch(() => COMPACT.format(Number(formatUnits(BigInt(raw), decimals))))
  return data ?? raw
}

/** ` ($553.31K)` when the token has a cached USD price; empty otherwise (display context only). */
function usdSuffix(raw: string, token: TokenEntry | null, prices: PriceLookup) {
  if (!token) return ''
  const usd = prices.usd(token.chainId, token.address)
  if (usd === null) return ''
  const { data } = tryCatch(() =>
    USD.format(Number(formatUnits(BigInt(raw), token.decimals)) * usd)
  )
  return data ? ` (${data})` : ''
}

/**
 * Headline amount: bare compact number + USD, `875.83K ($876.03K)` — the market label carries the
 * token symbols, mirroring the sample channel. Raw base units + "assets" when unresolved.
 */
export function assetsAmount(raw: string, token: TokenEntry | null, prices: PriceLookup) {
  if (!token) return `${raw} assets`
  return `${compactAmount(raw, token.decimals)}${usdSuffix(raw, token, prices)}`
}

/** Loan/collateral-token amount with symbol, e.g. `20M USDC` — for detail lines. */
export function tokenAmount(raw: string, token: TokenEntry | null) {
  if (!token) return `${raw} assets`
  return `${compactAmount(raw, token.decimals)} ${token.symbol}`
}

/**
 * Unit (face-value) amounts scale with the loan token's decimals but are NOT loan-token amounts
 * until maturity, so they keep the "units" word instead of borrowing the token's symbol.
 */
export function unitsAmount(raw: string, loanToken: TokenEntry | null) {
  return loanToken ? `${compactAmount(raw, loanToken.decimals)} units` : `${raw} units`
}

/**
 * A make order's tick annualized into the simple APR the Morpho fixed-rate app shows, e.g.
 * `1.25% APR` — the maker's gross quote, annualized over the market's remaining term the same way
 * `OfferUtils.getApr` does. Null — callers omit the rate — when the market has matured (nothing
 * to annualize over) or when TickLib rejects the tick (out of Midnight's range, or ticks 0–1
 * whose price snaps to zero).
 */
export function aprLabel(tick: number, maturity: number, observedAt: number) {
  if (maturity <= observedAt) return null
  const { data } = tryCatch(() => TickLib.tickToApr(BigInt(tick), BigInt(maturity - observedAt)))
  if (data === null) return null
  const percent = Number(formatUnits(data, 16))
  return Number.isFinite(percent) ? `${APR.format(percent)}% APR` : null
}

/** The registry's loan-token metadata plus the (chain, address) identity price lookups need. */
export function loanTokenEntry(tokens: TokenRegistry, marketId: string): TokenEntry | null {
  const market = tokens.get(marketId)
  if (!market) return null
  const info = tokens.token(market.chainId, market.loanToken)
  return info ? { ...info, chainId: market.chainId, address: market.loanToken } : null
}

// Which collateral an event moved comes from the event's own `data.collateral` — the registry's
// per-market collateral list cannot identify it (markets accept several).
function collateralTokenEntry(
  tokens: TokenRegistry,
  marketId: string,
  collateral: string
): TokenEntry | null {
  const market = tokens.get(marketId)
  if (!market || !isAddress(collateral, { strict: false })) return null
  const address = getAddress(collateral)
  const info = tokens.token(market.chainId, address)
  return info ? { ...info, chainId: market.chainId, address } : null
}

/** WAD LLTV → `86.0%`; null when malformed, so a bad value degrades to omission. */
function lltvPercent(lltv: string | undefined) {
  if (!lltv) return null
  const { data } = tryCatch(() => Number(formatUnits(BigInt(lltv), 16)))
  return data != null && Number.isFinite(data) ? `${data.toFixed(1)}%` : null
}

/**
 * The market's fixed-market page on the Morpho app — what the market segment of every alert links
 * to in place of showing the raw market id. Null when the chain has no configured name or the id
 * is not hash-shaped, so an API-sourced string that could carry `|` or `>` never enters the URL
 * slot (see the guard note above the explorer builders).
 */
export function marketUrl(chainId: number | undefined, marketId: string) {
  const chain = chainId === undefined ? undefined : CHAINS[chainId]
  return chain && isHash(marketId)
    ? `https://markets.morpho.org/fixed/${chain.name.toLowerCase()}/${marketId}`
    : null
}

/** The market segment of a headline: its display label and the app page it links to. */
type MarketRef = { label: string; url: string | null }

export function marketRef(
  tokens: TokenRegistry,
  chainId: number | undefined,
  marketId: string,
  collateral?: string
): MarketRef {
  return { label: marketLabel(tokens, marketId, collateral), url: marketUrl(chainId, marketId) }
}

/**
 * The market segment of a headline: `USDC/WETH (86.0%) 30/09/2026` — loan/collateral pair with
 * that collateral's LLTV, then the maturity date. The collateral slot takes the event's own
 * collateral when the event names one, else the market's sole configured collateral; a market
 * accepting several shows the loan token alone, since none can be singled out. Degrades tier by
 * tier as registry knowledge thins, down to the bare abbreviated id. The raw market id lives in
 * the link this label is rendered with (`marketUrl`), not in the label itself.
 */
export function marketLabel(tokens: TokenRegistry, marketId: string, collateral?: string) {
  const market = tokens.get(marketId)
  if (!market) return abbreviateAddress(marketId)

  const symbolOf = (address: Address) =>
    tokens.token(market.chainId, address)?.symbol ?? abbreviateAddress(address)

  const sole = market.collaterals.length === 1 ? market.collaterals[0] : undefined
  const chosen =
    collateral && isAddress(collateral, { strict: false }) ? getAddress(collateral) : sole?.address
  let name = symbolOf(market.loanToken)
  if (chosen) {
    name = `${name}/${symbolOf(chosen)}`
    const lltv = lltvPercent(tokens.collateral(marketId, chosen)?.lltv)
    if (lltv) name = `${name} (${lltv})`
  }
  return `${name} ${formatUtcDate(market.maturity)}`
}

/** `1.00K units @ 0.999` — the trade's unit volume and average loan-token-per-unit price. */
function tradeDetail(data: { assets: string; units: string }, loan: TokenEntry | null) {
  const { data: price } = tryCatch(() => {
    const assets = BigInt(data.assets)
    const units = BigInt(data.units)
    // Decimals cancel: assets and units both scale with the loan token, so the ratio is the price.
    return assets > 0n && units > 0n ? Number(assets) / Number(units) : null
  })
  if (!price) return []
  return [`${unitsAmount(data.units, loan)} @ ${PRICE.format(price)}`]
}

type TransactionAlertParameters = {
  item: TransactionItem
  /** Slack emoji shortcode leading the headline, e.g. `:rocket:`. */
  emoji: string
  /** `Action: amount` — the builder appends the market segment as `in <market>`. */
  headline: string
  /** The market the headline's `in …` names — a mrkdwn link when its URL resolves. */
  market: MarketRef
  /** Indented `•` lines under the headline; escaped here, so pass plain text. */
  details?: string[]
  actor: string
  /** "by" for the acting account; "of" when the address is the liquidated borrower. */
  preposition?: 'by' | 'of'
  severity: Alert['severity']
}

// :emoji: $headline in ($market label)[app market page]
//         • $detail
// By ($actor)[explorer link] on midnight-<chain>, $time
// (Basescan)[tx link]  (Debank)[actor portfolio]
function transactionAlert({
  item,
  emoji,
  headline,
  market,
  details = [],
  actor,
  preposition = 'by',
  severity
}: TransactionAlertParameters): Alert {
  const time = formatUtcTime(item.created_at)
  const where = `on ${chainLabel(item.chain_id)}`
  const short = abbreviateAddress(actor)
  const linkRow = [
    { url: explorerTxUrl(item.chain_id, item.tx_hash), label: explorerName(item.chain_id) },
    { url: debankUrl(actor), label: 'Debank' }
  ]
    .filter(link => link.url !== null)
    .map(link => slackLink(link.url, link.label))
    .join('  ')
  const footer = preposition === 'by' ? 'By' : 'Of'
  return {
    key: item.id,
    title: `${headline} in ${market.label} ${preposition} ${short} ${where} at ${time}`,
    text: [
      `${emoji} ${escapeSlack(headline)} in ${slackLink(market.url, market.label)}`,
      ...details.map(detail => `        • ${escapeSlack(detail)}`),
      `${footer} ${slackLink(explorerAddressUrl(item.chain_id, actor), short)} ${where}, ${time}`,
      ...(linkRow ? [linkRow] : [])
    ].join('\n'),
    severity
  }
}

const TRADE_ACTIONS = {
  lend: { emoji: ':rocket:', action: 'Lend' },
  borrow: { emoji: ':moneybag:', action: 'Borrow' },
  exit_lend_secondary: { emoji: ':butterfly:', action: 'Lend exit' },
  exit_borrow_secondary: { emoji: ':leftwards_arrow_with_hook:', action: 'Repay' }
} as const

export function formatTransactionAlert(
  item: TransactionItem,
  tokens: TokenRegistry,
  prices: PriceLookup
): Alert {
  const loan = loanTokenEntry(tokens, item.market_id)
  switch (item.event_type) {
    case 'lend':
    case 'borrow':
    case 'exit_lend_secondary':
    case 'exit_borrow_secondary': {
      const { emoji, action } = TRADE_ACTIONS[item.event_type]
      return transactionAlert({
        item,
        emoji,
        headline: `${action}: ${assetsAmount(item.data.assets, loan, prices)}`,
        market: marketRef(tokens, item.chain_id, item.market_id),
        details: tradeDetail(item.data, loan),
        actor: item.data.account,
        severity: 'info'
      })
    }
    case 'exit_lend_primary':
    case 'exit_borrow_primary': {
      const repay = item.event_type === 'exit_borrow_primary'
      return transactionAlert({
        item,
        emoji: repay ? ':leftwards_arrow_with_hook:' : ':butterfly:',
        headline: `${repay ? 'Repay' : 'Lend exit'} (primary): ${unitsAmount(item.data.units, loan)}`,
        market: marketRef(tokens, item.chain_id, item.market_id),
        actor: item.data.account,
        severity: 'info'
      })
    }
    case 'supply_collateral':
    case 'withdraw_collateral': {
      const collateral = collateralTokenEntry(tokens, item.market_id, item.data.collateral)
      const action =
        item.event_type === 'supply_collateral' ? 'Supply collateral' : 'Withdraw collateral'
      return transactionAlert({
        item,
        emoji: ':sparkles:',
        headline: `${action}: ${assetsAmount(item.data.assets, collateral, prices)}`,
        market: marketRef(tokens, item.chain_id, item.market_id, item.data.collateral),
        actor: item.data.account,
        severity: 'info'
      })
    }
    case 'partial_liquidation':
    case 'full_liquidation': {
      const kind = item.event_type === 'full_liquidation' ? 'full' : 'partial'
      const badDebt = isBadDebtLiquidation(item)
      const collateral = collateralTokenEntry(tokens, item.market_id, item.data.collateral)
      const seized = tokenAmount(item.data.seized_assets, collateral)
      return transactionAlert({
        item,
        emoji: badDebt ? ':rotating_light:' : ':zap:',
        headline: `${badDebt ? 'BAD DEBT — ' : ''}Liquidation (${kind}): ${unitsAmount(item.data.repaid_units, loan)} repaid`,
        market: marketRef(tokens, item.chain_id, item.market_id, item.data.collateral),
        details: [
          `seized: ${seized}${usdSuffix(item.data.seized_assets, collateral, prices)}`,
          ...(badDebt ? [`bad debt: ${unitsAmount(item.data.bad_debt, loan)}`] : [])
        ],
        actor: item.data.borrower,
        preposition: 'of',
        severity: badDebt ? 'critical' : 'warning'
      })
    }
    default:
      return assertNever(item)
  }
}

/**
 * One Take fill arrives as two API items — the buyer's lend and the seller's borrow — but is a
 * single on-chain event, so both legs merge into one alert. Each leg keeps its own attributed
 * amount: they differ by the settlement fee, and materially when a position crosses zero (part of
 * the trade then retires debt or credit instead of creating it).
 */
export function formatTakeAlert(
  { lend, borrow }: TakePair,
  tokens: TokenRegistry,
  prices: PriceLookup
): Alert {
  const loan = loanTokenEntry(tokens, lend.market_id)
  const headline = `Take: ${assetsAmount(lend.data.assets, loan, prices)} lend + ${assetsAmount(borrow.data.assets, loan, prices)} borrow`
  const market = marketRef(tokens, lend.chain_id, lend.market_id)
  const details = [
    ...tradeDetail(lend.data, loan).map(detail => `lend: ${detail}`),
    ...tradeDetail(borrow.data, loan).map(detail => `borrow: ${detail}`)
  ]
  const time = formatUtcTime(lend.created_at)
  const where = `on ${chainLabel(lend.chain_id)}`
  const buyer = abbreviateAddress(lend.data.account)
  const seller = abbreviateAddress(borrow.data.account)
  const txUrl = explorerTxUrl(lend.chain_id, lend.tx_hash)
  return {
    key: `${lend.id}+${borrow.id}`,
    title: `${headline} in ${market.label} by ${buyer} + ${seller} ${where} at ${time}`,
    text: [
      `:handshake: ${escapeSlack(headline)} in ${slackLink(market.url, market.label)}`,
      ...details.map(detail => `        • ${escapeSlack(detail)}`),
      `By ${slackLink(explorerAddressUrl(lend.chain_id, lend.data.account), buyer)} + ${slackLink(explorerAddressUrl(borrow.chain_id, borrow.data.account), seller)} ${where}, ${time}`,
      ...(txUrl ? [slackLink(txUrl, explorerName(lend.chain_id))] : [])
    ].join('\n'),
    severity: 'info'
  }
}
