import type { Address, Chain } from 'viem'

import { TickLib } from '@morpho-org/midnight-sdk'
import { abbreviateAddress, assertNever, tryCatch } from '@repo/utils'
import { formatUnits, getAddress, isAddress, isHash } from 'viem'
import { base } from 'viem/chains'

import type { TransactionItem } from '../midnight/client'
import type { OfferBucket, OfferEvent } from '../pollers/book-offers.model'
import type { TakePair } from '../pollers/take'
import type { PriceLookup } from '../tokens/prices'
import type { TokenEntry, TokenRegistry } from '../tokens/registry'
import type { WalletCrmStore } from '../wallets/wallet-crm.store'
import type { Alert } from './alert'

import { bucketKey, sideLabel } from '../pollers/book-offers.model'
import { isBadDebtLiquidation } from '../pollers/filter'
import { escapeSlack, slackLink } from './mrkdwn'
import { formatUtcDate, formatUtcTime } from './time'

// Owns message construction: it turns a poller's domain object (a transaction, a take pair, a book
// offer event) into an `Alert` — the other half of the alert domain from the dispatcher, which only
// sends. It lives in `alerts/` beside the `Alert` type and the dispatcher (Formatter constructs,
// Dispatcher sends), which means it imports "up" into poller domain (the event types, plus runtime
// `isBadDebtLiquidation` and `bucketKey`/`sideLabel`). That is a deliberate, one-directional edge —
// `pollers/*` never imports back into `alerts/`, so there is no cycle.

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

/** Header of the CRM column holding the counterparty's company name in the Attio wallet export. */
const COMPANY_COLUMN = 'Company'

/**
 * The human label an address renders as in an alert: the CRM company name when the wallet store
 * tracks that wallet (`Kraken`), else the abbreviated hex (`0x958e...1917`). An untracked address,
 * or one whose `Company` cell is blank, degrades to the hex. Explorer/Debank links always carry the
 * raw address regardless — only the visible label swaps, so a named counterparty stays clickable.
 */
export function addressLabel(wallets: WalletCrmStore, address: string) {
  const company = wallets.get(address)?.[COMPANY_COLUMN]?.trim()
  return company ? company : abbreviateAddress(address)
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

/** Loan/collateral-token amount with symbol, e.g. `20M USDC` — for detail lines. */
export function tokenAmount(raw: string, token: TokenEntry | null) {
  if (!token) return `${raw} assets`
  return `${compactAmount(raw, token.decimals)} ${token.symbol}`
}

/**
 * Unit (face-value) amounts scale with the loan token's decimals but are NOT loan-token amounts
 * until maturity, so they keep the "units" word instead of borrowing the token's symbol.
 */
function unitsAmount(raw: string, loanToken: TokenEntry | null) {
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

/** The market segment of a headline: its display label and the app page it links to. */
type MarketRef = { label: string; url: string | null }

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

/**
 * A Take detail line names the party that traded the leg — `lend: 0.20 units @ 0.996 by 0x…
 * Basescan  Debank` — so the reader can tell lender from borrower without decoding the summary
 * line's order. The amount text is escaped, but the trailing explorer/Debank links are raw mrkdwn,
 * so this returns finished lines (bullet included) that the caller must not run through escapeSlack.
 */
function takeLegLines(
  prefix: string,
  leg: { chain_id: number; data: { assets: string; units: string; account: string } },
  loan: TokenEntry | null,
  nameOf: (address: string) => string
) {
  const { account } = leg.data
  const links = linkRow([
    { url: explorerAddressUrl(leg.chain_id, account), label: explorerName(leg.chain_id) },
    { url: debankUrl(account), label: 'Debank' }
  ]).join('  ')
  const by = `by ${escapeSlack(nameOf(account))}${links ? `  ${links}` : ''}`
  return tradeDetail(leg.data, loan).map(
    detail => `        • ${escapeSlack(`${prefix}: ${detail}`)} ${by}`
  )
}

/** The escaped, 8-space-indented bullet a plain detail string becomes in the mrkdwn body. */
function detailLine(detail: string) {
  return `        • ${escapeSlack(detail)}`
}

/**
 * The alert's trailing link row: each entry rendered as an mrkdwn link, dropping any whose URL
 * failed to resolve (a dead plain-text label helps no one). Returns the finished fragments; callers
 * join them with two spaces.
 */
function linkRow(links: Array<{ url: string | null; label: string }>) {
  return links.filter(link => link.url !== null).map(link => slackLink(link.url, link.label))
}

/**
 * The shared block every alert renders into:
 *   :emoji: headline in <market link>
 *           • detail…
 *   footer line
 *   <link row>
 * `details` and `footer` arrive finished — each event escapes and shapes its own (take's detail
 * lines carry raw mrkdwn links, the others are plain) — and the link row is omitted entirely when
 * nothing resolved.
 */
function renderText({
  emoji,
  headline,
  market,
  details,
  footer,
  links
}: {
  emoji: string
  headline: string
  market: MarketRef
  details: string[]
  footer: string
  links: string[]
}) {
  return [
    `${emoji} ${escapeSlack(headline)} in ${slackLink(market.url, market.label)}`,
    ...details,
    footer,
    ...(links.length > 0 ? [links.join('  ')] : [])
  ].join('\n')
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
  /** Resolves `actor` to its display label (CRM company name or abbreviated hex). */
  nameOf: (address: string) => string
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
  nameOf,
  preposition = 'by',
  severity
}: TransactionAlertParameters): Alert {
  const time = formatUtcTime(item.created_at)
  const where = `on ${chainLabel(item.chain_id)}`
  const short = nameOf(actor)
  const links = linkRow([
    { url: explorerTxUrl(item.chain_id, item.tx_hash), label: explorerName(item.chain_id) },
    { url: debankUrl(actor), label: 'Debank' }
  ])
  const footer = preposition === 'by' ? 'By' : 'Of'
  return {
    key: item.id,
    title: `${headline} in ${market.label} ${preposition} ${short} ${where} at ${time}`,
    text: renderText({
      emoji,
      headline,
      market,
      details: details.map(detailLine),
      footer: `${footer} ${slackLink(explorerAddressUrl(item.chain_id, actor), short)} ${where}, ${time}`,
      links
    }),
    severity
  }
}

const TRADE_ACTIONS = {
  lend: { emoji: ':rocket:', action: 'Lend' },
  borrow: { emoji: ':moneybag:', action: 'Borrow' },
  exit_lend_secondary: { emoji: ':butterfly:', action: 'Lend exit' },
  exit_borrow_secondary: { emoji: ':leftwards_arrow_with_hook:', action: 'Repay' }
} as const

const OFFER_EMOJI = { created: ':memo:', resized: ':arrows_counterclockwise:', closed: ':x:' }
const OFFER_ACTION = { created: 'posted', resized: 'resized', closed: 'closed' }

/** Both caps in the dedupe key so an A→B→A→B resize cycle stays distinct for dedupe consumers. */
function capKey(bucket: OfferBucket) {
  return `${bucket.maxUnits}/${bucket.maxAssets}`
}

/**
 * Constructs the `Alert` for every poller event family — one public method each. Holds the token
 * registry and price cache so callers hand it a domain object and get back a finished alert,
 * instead of threading those two deps through a free function on every call.
 */
export class AlertFormatter {
  constructor(
    private readonly deps: { tokens: TokenRegistry; prices: PriceLookup; wallets: WalletCrmStore }
  ) {}

  // Bound so it can be handed to the free builders (`transactionAlert`, `takeLegLines`) as a plain
  // callback without losing `this`. Every counterparty address in an alert routes through here so a
  // tracked wallet shows its company name in place of the raw hex.
  private readonly nameOf = (address: string): string => addressLabel(this.deps.wallets, address)

  transaction(item: TransactionItem): Alert {
    const loan = this.loanTokenEntry(item.market_id)
    switch (item.event_type) {
      case 'lend':
      case 'borrow':
      case 'exit_lend_secondary':
      case 'exit_borrow_secondary': {
        const { emoji, action } = TRADE_ACTIONS[item.event_type]
        return transactionAlert({
          item,
          emoji,
          headline: `${action}: ${this.assetsAmount(item.data.assets, loan)}`,
          market: this.marketRef(item.chain_id, item.market_id),
          details: tradeDetail(item.data, loan),
          actor: item.data.account,
          nameOf: this.nameOf,
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
          market: this.marketRef(item.chain_id, item.market_id),
          actor: item.data.account,
          nameOf: this.nameOf,
          severity: 'info'
        })
      }
      case 'supply_collateral':
      case 'withdraw_collateral': {
        const collateral = this.collateralTokenEntry(item.market_id, item.data.collateral)
        const action =
          item.event_type === 'supply_collateral' ? 'Supply collateral' : 'Withdraw collateral'
        return transactionAlert({
          item,
          emoji: ':sparkles:',
          headline: `${action}: ${this.assetsAmount(item.data.assets, collateral)}`,
          market: this.marketRef(item.chain_id, item.market_id, item.data.collateral),
          actor: item.data.account,
          nameOf: this.nameOf,
          severity: 'info'
        })
      }
      case 'partial_liquidation':
      case 'full_liquidation': {
        const kind = item.event_type === 'full_liquidation' ? 'full' : 'partial'
        const badDebt = isBadDebtLiquidation(item)
        const collateral = this.collateralTokenEntry(item.market_id, item.data.collateral)
        const seized = tokenAmount(item.data.seized_assets, collateral)
        return transactionAlert({
          item,
          emoji: badDebt ? ':rotating_light:' : ':zap:',
          headline: `${badDebt ? 'BAD DEBT — ' : ''}Liquidation (${kind}): ${unitsAmount(item.data.repaid_units, loan)} repaid`,
          market: this.marketRef(item.chain_id, item.market_id, item.data.collateral),
          details: [
            `seized: ${seized}${this.usdSuffix(item.data.seized_assets, collateral)}`,
            ...(badDebt ? [`bad debt: ${unitsAmount(item.data.bad_debt, loan)}`] : [])
          ],
          actor: item.data.borrower,
          nameOf: this.nameOf,
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
  take({ lend, borrow }: TakePair): Alert {
    const loan = this.loanTokenEntry(lend.market_id)
    const headline = `Take: ${this.assetsAmount(lend.data.assets, loan)} lend + ${this.assetsAmount(borrow.data.assets, loan)} borrow`
    const market = this.marketRef(lend.chain_id, lend.market_id)
    const time = formatUtcTime(lend.created_at)
    const where = `on ${chainLabel(lend.chain_id)}`
    const buyer = this.nameOf(lend.data.account)
    const seller = this.nameOf(borrow.data.account)
    return {
      key: `${lend.id}+${borrow.id}`,
      title: `${headline} in ${market.label} by ${buyer} + ${seller} ${where} at ${time}`,
      text: renderText({
        emoji: ':handshake:',
        headline,
        market,
        details: [
          ...takeLegLines('lend', lend, loan, this.nameOf),
          ...takeLegLines('borrow', borrow, loan, this.nameOf)
        ],
        footer: `By ${slackLink(explorerAddressUrl(lend.chain_id, lend.data.account), buyer)} + ${slackLink(explorerAddressUrl(borrow.chain_id, borrow.data.account), seller)} ${where}, ${time}`,
        links: linkRow([
          { url: explorerTxUrl(lend.chain_id, lend.tx_hash), label: explorerName(lend.chain_id) }
        ])
      }),
      severity: 'info'
    }
  }

  // Same block shape as the transaction alerts, minus what an off-chain make order does not have:
  // EIP-712 signatures carry no tx to link, so the link row drops the tx entry and carries the
  // maker's explorer-address and Debank links instead — and no on-chain timestamp, so the footer
  // carries the poller's observation time instead (at most one poll interval after the change).
  // Identity stays market + side + maker + group + tick.
  offer(event: OfferEvent, observedAt: number): Alert {
    const { bucket, marketId } = event
    const market = this.deps.tokens.get(marketId)
    const loan = this.loanTokenEntry(marketId)
    const size = this.sizeLabel(bucket, event.assets, loan)
    const side = sideLabel(bucket.side)
    const key = bucketKey(bucket.side, bucket.maker, bucket.group, bucket.tick)
    const maker = this.nameOf(bucket.maker)
    const time = formatUtcTime(observedAt)
    // The registry learns every book market from this poller's own sweep (recordAll runs before the
    // diff), so a miss only happens on drift — degrade to no chain segment rather than guessing.
    const where = market ? ` on ${chainLabel(market.chainId)}` : ''
    const makerUrl = market ? explorerAddressUrl(market.chainId, bucket.maker) : null
    // Raw ticks never surface — operators read rates. When the rate cannot be annualized (registry
    // miss, matured market, or a tick aprLabel declines) the `@ …` clause is omitted rather than
    // falling back to the tick; the tick still disambiguates the bucket via the alert key.
    const rate = market ? aprLabel(bucket.tick, market.maturity, observedAt) : null
    const headline = `Make order ${OFFER_ACTION[event.kind]}: ${size} ${side}${rate ? ` @ ${rate}` : ''}`
    const ref = this.marketRef(market?.chainId, marketId)
    const details =
      event.kind === 'resized' && event.previous
        ? [`was ${this.sizeLabel(event.previous, event.previousAssets, loan)}`]
        : []
    // Explorer link labels the maker's address page (Basescan on base); Debank labels their
    // cross-protocol portfolio. Same filtered pattern as the transaction alerts' link row: an entry
    // whose URL fails to resolve is dropped rather than rendered as a dead plain-text label.
    const links = linkRow([
      { url: makerUrl, label: market ? explorerName(market.chainId) : 'Explorer' },
      { url: debankUrl(bucket.maker), label: 'Debank' }
    ])
    const alert = {
      title: `${headline} in ${ref.label} by ${maker}${where} at ${time}`,
      text: renderText({
        emoji: OFFER_EMOJI[event.kind],
        headline,
        market: ref,
        details: details.map(detailLine),
        footer: `By ${slackLink(makerUrl, maker)}${where}, ${time}`,
        links
      }),
      severity: 'info' as const
    }
    switch (event.kind) {
      case 'created':
        return { key: `${marketId}:${key}:created`, ...alert }
      case 'resized':
        return {
          key: `${marketId}:${key}:resized:${event.previous ? capKey(event.previous) : '?'}->${capKey(bucket)}`,
          ...alert
        }
      case 'closed':
        return { key: `${marketId}:${key}:closed`, ...alert }
      default:
        return assertNever(event.kind)
    }
  }

  /** The registry's loan-token metadata plus the (chain, address) identity price lookups need. */
  private loanTokenEntry(marketId: string): TokenEntry | null {
    const market = this.deps.tokens.get(marketId)
    if (!market) return null
    const info = this.deps.tokens.token(market.chainId, market.loanToken)
    return info ? { ...info, chainId: market.chainId, address: market.loanToken } : null
  }

  // Which collateral an event moved comes from the event's own `data.collateral` — the registry's
  // per-market collateral list cannot identify it (markets accept several).
  private collateralTokenEntry(marketId: string, collateral: string): TokenEntry | null {
    const market = this.deps.tokens.get(marketId)
    if (!market || !isAddress(collateral, { strict: false })) return null
    const address = getAddress(collateral)
    const info = this.deps.tokens.token(market.chainId, address)
    return info ? { ...info, chainId: market.chainId, address } : null
  }

  /** The market segment of a headline: its display label and the app page it links to. */
  private marketRef(chainId: number | undefined, marketId: string, collateral?: string): MarketRef {
    return {
      label: marketLabel(this.deps.tokens, marketId, collateral),
      url: marketUrl(chainId, marketId)
    }
  }

  /**
   * Headline amount: bare compact number + USD, `875.83K ($876.03K)` — the market label carries the
   * token symbols, mirroring the sample channel. Raw base units + "assets" when unresolved.
   */
  private assetsAmount(raw: string, token: TokenEntry | null) {
    if (!token) return `${raw} assets`
    return `${compactAmount(raw, token.decimals)}${this.usdSuffix(raw, token)}`
  }

  /** ` ($553.31K)` when the token has a cached USD price; empty otherwise (display context only). */
  private usdSuffix(raw: string, token: TokenEntry | null) {
    if (!token) return ''
    const usd = this.deps.prices.usd(token.chainId, token.address)
    if (usd === null) return ''
    const { data } = tryCatch(() =>
      USD.format(Number(formatUnits(BigInt(raw), token.decimals)) * usd)
    )
    return data ? ` (${data})` : ''
  }

  /** A book offer's size: its loan-token assets when the tick is priced, else its raw units. */
  private sizeLabel(bucket: OfferBucket, assets: bigint | null, loan: TokenEntry | null) {
    return assets === null
      ? unitsAmount(bucket.maxUnits, loan)
      : this.assetsAmount(`${assets}`, loan)
  }
}
