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

import { bucketKey } from '../pollers/book-offers.model'
import { isBadDebtLiquidation } from '../pollers/filter'
import { escapeSlack, slackLink } from './mrkdwn'
import { formatUtcDate, formatUtcTime } from './time'

// Owns message construction: it turns a poller's domain object (a transaction, a take pair, a book
// offer event) into an `Alert` — the other half of the alert domain from the dispatcher, which only
// sends. It lives in `alerts/` beside the `Alert` type and the dispatcher (Formatter constructs,
// Dispatcher sends), which means it imports "up" into poller domain (the event types, plus runtime
// `isBadDebtLiquidation` and `bucketKey`). That is a deliberate, one-directional edge —
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

// Full-precision amounts with thousands separators — the channel shows exact figures, and the
// linked explorer tx carries the on-chain truth. Significant digits below 1 so a dust-sized amount
// renders as 0.0000420 instead of rounding to 0; grouped fixed-2 at or above 1 so 5000 → `5,000`.
const AMOUNT_LARGE = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
const AMOUNT_SMALL = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 4 })

/** `$149.99` / `$32,450` — whole values drop the cents, fractional values keep exactly two. */
const USD_WHOLE = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
})
const USD_FRACTION = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
})

/**
 * `1.25%` APR — adjacent ticks sit ~2.5bp apart at typical rates, so 2 decimals resolves them.
 * Not @repo/utils' formatUint256Percent, which truncates instead of rounding (2.5076% renders as
 * `2.5%`), dropping the second decimal that separates neighbouring ticks.
 */
const APR = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })

/** Three-space indent leading every field / footer / link line under the emoji title. */
const INDENT = '   '

function preciseAmount(value: number) {
  return Math.abs(value) >= 1 ? AMOUNT_LARGE.format(value) : AMOUNT_SMALL.format(value)
}

/** Integer USD amounts drop the `.00`; fractional ones keep two decimals (`$4,999.50`). */
function formatUsd(value: number) {
  return Number.isInteger(value) ? USD_WHOLE.format(value) : USD_FRACTION.format(value)
}

function decimalAmount(raw: string, decimals: number) {
  // A malformed amount from the API shows verbatim rather than dropping the alert.
  const { data } = tryCatch(() => preciseAmount(Number(formatUnits(BigInt(raw), decimals))))
  return data ?? raw
}

/** Loan/collateral-token amount with symbol, e.g. `150 USDC` — no USD; `assetText` adds that. */
export function tokenAmount(raw: string, token: TokenEntry | null) {
  if (!token) return `${raw} assets`
  return `${decimalAmount(raw, token.decimals)} ${token.symbol}`
}

/**
 * Unit (face-value) amounts scale with the loan token's decimals but are NOT loan-token amounts
 * until maturity, so they keep the "units" word instead of borrowing the token's symbol.
 */
function unitsAmount(raw: string, loanToken: TokenEntry | null) {
  return loanToken ? `${decimalAmount(raw, loanToken.decimals)} units` : `${raw} units`
}

/**
 * A make order's tick annualized into the simple APR the Morpho fixed-rate app shows, e.g. `1.25%`
 * — the maker's gross quote, annualized over the market's remaining term the same way
 * `OfferUtils.getApr` does. Null — callers omit the rate — when the market has matured (nothing to
 * annualize over) or when TickLib rejects the tick (out of Midnight's range, or ticks 0–1 whose
 * price snaps to zero).
 */
export function aprLabel(tick: number, maturity: number, observedAt: number) {
  if (maturity <= observedAt) return null
  const { data } = tryCatch(() => TickLib.tickToApr(BigInt(tick), BigInt(maturity - observedAt)))
  if (data === null) return null
  const percent = Number(formatUnits(data, 16))
  return Number.isFinite(percent) ? `${APR.format(percent)}%` : null
}

/**
 * A fill carries no tick, so its rate is reconstructed from the realized price — assets/units in
 * WAD — snapped to the nearest tick via `priceToTick`, an approximation of the average fill price.
 * Null when units is zero, the price falls outside the tick range, or the market has matured.
 */
export function fillAprLabel(assets: string, units: string, maturity: number, observedAt: number) {
  if (maturity <= observedAt) return null
  const { data } = tryCatch(() => {
    const denominator = BigInt(units)
    if (denominator <= 0n) return null
    // Decimals cancel (assets and units both scale with the loan token), so the WAD ratio is price.
    const wadPrice = (BigInt(assets) * 10n ** 18n) / denominator
    return TickLib.tickToApr(TickLib.priceToTick(wadPrice), BigInt(maturity - observedAt))
  })
  if (data == null) return null
  const percent = Number(formatUnits(data, 16))
  return Number.isFinite(percent) ? `${APR.format(percent)}%` : null
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
 * The market segment of an alert: `USDC/WETH (86.0%)` — loan/collateral pair with that collateral's
 * LLTV. The collateral slot takes the event's own collateral when the event names one, else the
 * market's sole configured collateral; a market accepting several shows the loan token alone, since
 * none can be singled out. Degrades tier by tier as registry knowledge thins, down to the bare
 * abbreviated id. The maturity date lives in each order's `Expiry` line, not here. The raw market
 * id lives in the link this label is rendered with (`marketUrl`), not in the label itself.
 */
export function marketLabel(tokens: TokenRegistry, marketId: string, collateral?: string) {
  const market = tokens.get(marketId)
  if (!market) return abbreviateAddress(marketId)

  const symbolOf = (address: Address) =>
    tokens.token(market.chainId, address)?.symbol ?? abbreviateAddress(address)

  const sole = market.collaterals.length === 1 ? market.collaterals[0] : undefined
  const chosen =
    collateral && isAddress(collateral, { strict: false }) ? getAddress(collateral) : sole?.address
  if (!chosen) return symbolOf(market.loanToken)

  const lltv = lltvPercent(tokens.collateral(marketId, chosen)?.lltv)
  const pair = `${symbolOf(market.loanToken)}/${symbolOf(chosen)}`
  return lltv ? `${pair} (${lltv})` : pair
}

/** The market segment of an alert: its display label and the app page it links to. */
type MarketRef = { label: string; url: string | null }

/** One amount-style field: its leading emoji, its label word, and the escaped-at-render value. */
type AmountLine = { emoji: string; label: string; value: string }

/** `   💰 Amount: 150 USDC ($149.99)` — the whole `label: value` is escaped (it carries no link). */
function fieldLine({ emoji, label, value }: AmountLine) {
  return `${INDENT}${emoji} ${escapeSlack(`${label}: ${value}`)}`
}

/** `   📈 APR: 5.12% in <market link>` — rate escaped, market rendered as a link. */
function aprLine(rate: string, market: MarketRef) {
  return `${INDENT}📈 APR: ${escapeSlack(rate)} in ${slackLink(market.url, market.label)}`
}

/** `   🏦 Market: <market link>` — the non-order events' market segment. */
function marketLine(market: MarketRef) {
  return `${INDENT}🏦 Market: ${slackLink(market.url, market.label)}`
}

/** `   📅 Expiry: 28/08/2026` — an order's own validity window. */
function expiryLine(unixSeconds: number) {
  return `${INDENT}📅 Expiry: ${escapeSlack(formatUtcDate(unixSeconds))}`
}

/** `   👤 By <name link> on midnight-base, <time>` — `who` is a finished (escaped) name link. */
function footerLine({
  preposition,
  who,
  where,
  time
}: {
  preposition: 'By' | 'Of'
  who: string
  where: string
  time: string
}) {
  return `${INDENT}👤 ${preposition} ${who}${where}, ${time}`
}

/** The trailing `   🔗 Basescan  Debank` line, or nothing when no URL resolved. */
function linkLine(links: string[]) {
  return links.length > 0 ? [`${INDENT}🔗 ${links.join('  ')}`] : []
}

/**
 * The alert's link entries: each rendered as an mrkdwn link, dropping any whose URL failed to
 * resolve (a dead plain-text label helps no one). Returns finished fragments the caller joins.
 */
function linkRow(links: Array<{ url: string | null; label: string }>) {
  return links.filter(link => link.url !== null).map(link => slackLink(link.url, link.label))
}

/** The plain (title) rendering of a set of amount lines: bare value for `Amount`, else `label value`. */
function amountsSentence(amounts: AmountLine[]) {
  return amounts
    .map(({ label, value }) => (label === 'Amount' ? value : `${label.toLowerCase()} ${value}`))
    .join(', ')
}

type TransactionAlertParameters = {
  item: TransactionItem
  /** Unicode emoji leading the title line, e.g. `🚀`. */
  emoji: string
  /** Event title, e.g. `Lend` or `Liquidation (full)`. */
  title: string
  /** Amount-style lines under the title (Amount / Seized / Repaid / Bad debt). */
  amounts: AmountLine[]
  /** The market the alert names — a mrkdwn link when its URL resolves. */
  market: MarketRef
  actor: string
  /** Resolves `actor` to its display label (CRM company name or abbreviated hex). */
  nameOf: (address: string) => string
  /** "By" for the acting account; "Of" when the address is the liquidated borrower. */
  preposition?: 'By' | 'Of'
  severity: Alert['severity']
}

// <emoji> <title>
//    💰 Amount: <amount>
//    🏦 Market: <market link>
//    👤 By <actor link> on midnight-<chain>, <time>
//    🔗 Basescan  Debank
function transactionAlert({
  item,
  emoji,
  title,
  amounts,
  market,
  actor,
  nameOf,
  preposition = 'By',
  severity
}: TransactionAlertParameters): Alert {
  const time = formatUtcTime(item.created_at)
  const where = ` on ${chainLabel(item.chain_id)}`
  const name = nameOf(actor)
  const actorUrl = explorerAddressUrl(item.chain_id, actor)
  const links = linkRow([
    { url: explorerTxUrl(item.chain_id, item.tx_hash), label: explorerName(item.chain_id) },
    { url: debankUrl(actor), label: 'Debank' }
  ])
  const titlePrep = preposition === 'Of' ? 'of' : 'by'
  return {
    key: item.id,
    title: `${title}: ${amountsSentence(amounts)} in ${market.label} ${titlePrep} ${name}${where} at ${time}`,
    text: [
      `${emoji} ${escapeSlack(title)}`,
      ...amounts.map(fieldLine),
      marketLine(market),
      footerLine({ preposition, who: slackLink(actorUrl, name), where, time }),
      ...linkLine(links)
    ].join('\n'),
    severity
  }
}

const TRADE_ACTIONS = {
  lend: { emoji: '🚀', title: 'Lend' },
  borrow: { emoji: '💵', title: 'Borrow' },
  exit_lend_secondary: { emoji: '🦋', title: 'Lend Exit' },
  exit_borrow_secondary: { emoji: '🔄', title: 'Repay' }
} as const

/** (kind, side) → the title emoji; posted differs by side, resized/closed share one per kind. */
const OFFER_EMOJI = {
  created: { bids: '📝', asks: '💳' },
  resized: { bids: '🔀', asks: '🔀' },
  closed: { bids: '❌', asks: '❌' }
} as const
const OFFER_KIND = { created: 'Posted', resized: 'Resized', closed: 'Closed' } as const

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

  // Bound so it can be handed to the free builders (`transactionAlert`) as a plain callback without
  // losing `this`. Every counterparty address in an alert routes through here so a tracked wallet
  // shows its company name in place of the raw hex.
  private readonly nameOf = (address: string): string => addressLabel(this.deps.wallets, address)

  transaction(item: TransactionItem): Alert {
    const loan = this.loanTokenEntry(item.market_id)
    switch (item.event_type) {
      case 'lend':
      case 'borrow':
      case 'exit_lend_secondary':
      case 'exit_borrow_secondary': {
        const { emoji, title } = TRADE_ACTIONS[item.event_type]
        return transactionAlert({
          item,
          emoji,
          title,
          amounts: [
            { emoji: '💰', label: 'Amount', value: this.assetText(item.data.assets, loan) }
          ],
          market: this.marketRef(item.chain_id, item.market_id),
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
          emoji: repay ? '🔄' : '🦋',
          title: repay ? 'Repay (primary)' : 'Lend Exit (primary)',
          amounts: [{ emoji: '💰', label: 'Amount', value: unitsAmount(item.data.units, loan) }],
          market: this.marketRef(item.chain_id, item.market_id),
          actor: item.data.account,
          nameOf: this.nameOf,
          severity: 'info'
        })
      }
      case 'supply_collateral':
      case 'withdraw_collateral': {
        const supply = item.event_type === 'supply_collateral'
        const collateral = this.collateralTokenEntry(item.market_id, item.data.collateral)
        return transactionAlert({
          item,
          emoji: supply ? '📥' : '📤',
          title: supply ? 'Supply Collateral' : 'Withdraw Collateral',
          amounts: [
            { emoji: '💰', label: 'Amount', value: this.assetText(item.data.assets, collateral) }
          ],
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
        return transactionAlert({
          item,
          emoji: badDebt ? '🚨' : '🔴',
          title: `${badDebt ? 'BAD DEBT ' : ''}Liquidation (${kind})`,
          amounts: [
            {
              emoji: '⚠️',
              label: 'Seized',
              value: this.assetText(item.data.seized_assets, collateral)
            },
            { emoji: '💳', label: 'Repaid', value: this.assetText(item.data.repaid_units, loan) },
            ...(badDebt
              ? [{ emoji: '🩸', label: 'Bad debt', value: unitsAmount(item.data.bad_debt, loan) }]
              : [])
          ],
          market: this.marketRef(item.chain_id, item.market_id, item.data.collateral),
          actor: item.data.borrower,
          nameOf: this.nameOf,
          preposition: 'Of',
          severity: badDebt ? 'critical' : 'warning'
        })
      }
      default:
        return assertNever(item)
    }
  }

  /**
   * One Take fill arrives as two API items — the buyer's lend and the seller's borrow — but is a
   * single on-chain event, so both legs merge into one `Make Order Filled` alert. Each leg keeps its
   * own attributed amount: they differ by the settlement fee, and materially when a position crosses
   * zero — so a divergence renders as two amount lines rather than one.
   */
  take({ lend, borrow }: TakePair): Alert {
    const loan = this.loanTokenEntry(lend.market_id)
    const market = this.marketRef(lend.chain_id, lend.market_id)
    const time = formatUtcTime(lend.created_at)
    const where = ` on ${chainLabel(lend.chain_id)}`
    const buyer = this.nameOf(lend.data.account)
    const seller = this.nameOf(borrow.data.account)
    const meta = this.deps.tokens.get(lend.market_id)
    const rate = meta
      ? fillAprLabel(lend.data.assets, lend.data.units, meta.maturity, lend.created_at)
      : null
    const amounts: AmountLine[] =
      lend.data.assets === borrow.data.assets
        ? [{ emoji: '💰', label: 'Amount', value: this.assetText(lend.data.assets, loan) }]
        : [
            { emoji: '💰', label: 'Lend', value: this.assetText(lend.data.assets, loan) },
            { emoji: '💰', label: 'Borrow', value: this.assetText(borrow.data.assets, loan) }
          ]
    const who = `${slackLink(explorerAddressUrl(lend.chain_id, lend.data.account), buyer)} + ${slackLink(explorerAddressUrl(borrow.chain_id, borrow.data.account), seller)}`
    const context = rate ? `at ${rate} in ${market.label}` : `in ${market.label}`
    return {
      key: `${lend.id}+${borrow.id}`,
      title: `Make Order Filled: ${amountsSentence(amounts)} ${context} by ${buyer} + ${seller}${where} at ${time}`,
      text: [
        '⚡ Make Order Filled',
        ...amounts.map(fieldLine),
        rate ? aprLine(rate, market) : marketLine(market),
        footerLine({ preposition: 'By', who, where, time }),
        ...linkLine(
          linkRow([
            { url: explorerTxUrl(lend.chain_id, lend.tx_hash), label: explorerName(lend.chain_id) }
          ])
        )
      ].join('\n'),
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
    // The maker's side is the order's intent: `bids` are buy offers (the maker lends), `asks` are
    // sell offers (the maker borrows) — so the title names it outright rather than a bare "Make
    // Order" that hides which way the maker is quoting.
    const title = `${bucket.side === 'asks' ? 'Borrow' : 'Lend'} Order ${OFFER_KIND[event.kind]}`
    const ref = this.marketRef(market?.chainId, marketId)
    const maker = this.nameOf(bucket.maker)
    const time = formatUtcTime(observedAt)
    // The registry learns every book market from this poller's own sweep (recordAll runs before the
    // diff), so a miss only happens on drift — degrade to no chain segment rather than guessing.
    const where = market ? ` on ${chainLabel(market.chainId)}` : ''
    const makerUrl = market ? explorerAddressUrl(market.chainId, bucket.maker) : null
    // Raw ticks never surface — operators read rates. When the rate cannot be annualized (registry
    // miss, matured market, or a tick aprLabel declines) the APR line degrades to a plain market
    // line; the tick still disambiguates the bucket via the alert key.
    const rate = market ? aprLabel(bucket.tick, market.maturity, observedAt) : null
    const previous =
      event.kind === 'resized' && event.previous
        ? this.sizeLabel(event.previous, event.previousAssets, loan)
        : null
    // Explorer link labels the maker's address page (Basescan on base); Debank labels their
    // cross-protocol portfolio. Same filtered pattern as the transaction alerts' link row: an entry
    // whose URL fails to resolve is dropped rather than rendered as a dead plain-text label.
    const links = linkRow([
      { url: makerUrl, label: market ? explorerName(market.chainId) : 'Explorer' },
      { url: debankUrl(bucket.maker), label: 'Debank' }
    ])
    const context = rate ? `at ${rate} in ${ref.label}` : `in ${ref.label}`
    const previousPlain = previous ? `, was ${previous}` : ''
    const alert = {
      title: `${title}: ${size}${previousPlain} ${context}, expires ${formatUtcDate(bucket.expiry)} by ${maker}${where} at ${time}`,
      text: [
        `${OFFER_EMOJI[event.kind][bucket.side]} ${escapeSlack(title)}`,
        fieldLine({ emoji: '💰', label: 'Amount', value: size }),
        ...(previous ? [fieldLine({ emoji: '↩️', label: 'Previous', value: previous })] : []),
        rate ? aprLine(rate, ref) : marketLine(ref),
        expiryLine(bucket.expiry),
        footerLine({ preposition: 'By', who: slackLink(makerUrl, maker), where, time }),
        ...linkLine(links)
      ].join('\n'),
      severity: 'info' as const
    }
    const key = bucketKey(bucket.side, bucket.maker, bucket.group, bucket.tick)
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

  /** The market segment of an alert: its display label and the app page it links to. */
  private marketRef(chainId: number | undefined, marketId: string, collateral?: string): MarketRef {
    return {
      label: marketLabel(this.deps.tokens, marketId, collateral),
      url: marketUrl(chainId, marketId)
    }
  }

  /**
   * The amount line value: `150 USDC ($149.99)` — token amount with symbol, plus the USD context
   * when a price is cached. Raw base units + "assets" when the token is unresolved (no symbol/USD).
   */
  private assetText(raw: string, token: TokenEntry | null) {
    return `${tokenAmount(raw, token)}${this.usdSuffix(raw, token)}`
  }

  /** ` ($553.31)` when the token has a cached USD price; empty otherwise (display context only). */
  private usdSuffix(raw: string, token: TokenEntry | null) {
    if (!token) return ''
    const usd = this.deps.prices.usd(token.chainId, token.address)
    if (usd === null) return ''
    const { data } = tryCatch(() =>
      formatUsd(Number(formatUnits(BigInt(raw), token.decimals)) * usd)
    )
    return data ? ` (${data})` : ''
  }

  /** A book offer's size: its loan-token assets when the tick is priced, else its raw units. */
  private sizeLabel(bucket: OfferBucket, assets: bigint | null, loan: TokenEntry | null) {
    return assets === null ? unitsAmount(bucket.maxUnits, loan) : this.assetText(`${assets}`, loan)
  }
}
