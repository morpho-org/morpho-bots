import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import type { PriceLookup } from '../../src/tokens/prices'
import type { WalletCrmRow } from '../../src/wallets/wallet-csv'

import {
  addressLabel,
  aprLabel,
  AlertFormatter,
  chainLabel,
  debankUrl,
  explorerAddressUrl,
  explorerTxUrl,
  fillAprLabel,
  marketLabel,
  marketUrl,
  tokenAmount
} from '../../src/alerts/formatter'
import { TokenRegistry } from '../../src/tokens/registry'
import { InMemoryWalletCrmStore } from '../../src/wallets/wallet-crm.store'
import {
  borrowItem,
  exitBorrowSecondaryItem,
  exitPrimaryItem,
  lendItem,
  liquidationItem,
  offerBucket,
  offerEvent,
  supplyCollateralItem,
  withdrawCollateralItem,
  MARKET_A,
  MATURITY,
  NO_PRICES,
  OFFER_GROUP,
  priceLookup,
  TX_HASH,
  USDC_TOKEN,
  USER_ONE,
  USER_TWO,
  WETH_TOKEN
} from '../midnight/fixtures'

/** The formatter under test, holding the given registry + price cache (and optional wallet store). */
const fmt = (tokens: TokenRegistry, prices: PriceLookup, wallets = new InMemoryWalletCrmStore()) =>
  new AlertFormatter({ tokens, prices, wallets })

/** A wallet CRM store mapping each address to a one-column `Company` record. */
const crm = (companies: Record<string, string>) =>
  new InMemoryWalletCrmStore(
    Object.entries(companies).map(
      ([address, company]): WalletCrmRow => ({
        address: getAddress(address),
        values: { Company: company }
      })
    )
  )

/**
 * MARKET_A denominated in Base USDC with Base WETH collateral — both resolve through the
 * registry's seeded KNOWN_TOKENS table, so no metadata is recorded here.
 */
function registryWithTokens(loanToken = USDC_TOKEN) {
  const tokens = new TokenRegistry()
  tokens.record({
    market_id: MARKET_A,
    chain_id: 8453,
    loan_token: loanToken,
    maturity: MATURITY,
    collaterals: [{ token: WETH_TOKEN, lltv: '860000000000000000' }]
  })
  return tokens
}

/** MARKET_A's headline label when its tokens resolve: loan/collateral pair and LLTV (no maturity). */
const USDC_MARKET = 'USDC/WETH (86.0%)'

/** The app page every market segment links to in mrkdwn, replacing the raw market id. */
const MARKET_URL = `https://markets.morpho.org/fixed/base/${MARKET_A}`

/** MARKET_A's market segment as it appears in mrkdwn text: the label linked to the app page. */
const USDC_MARKET_LINK = `<${MARKET_URL}|${USDC_MARKET}>`

const addrUrl = (address: string) => `https://basescan.org/address/${address}`
const txUrl = `https://basescan.org/tx/${TX_HASH}`
const debank = (address: string) => `https://debank.com/profile/${address}`

/** A frozen observation clock one year before maturity, so tick 4250 annualizes to a clean 1.25%. */
const OBSERVED = MATURITY - 31_536_000
const OBSERVED_TIME = '30/09/2025 - 00:00:00 UTC'

describe('explorer urls', () => {
  it('builds basescan links for chain 8453 and null for unknown chains', () => {
    expect(explorerTxUrl(8453, TX_HASH)).toBe(`https://basescan.org/tx/${TX_HASH}`)
    expect(explorerTxUrl(999, TX_HASH)).toBeNull()
    expect(explorerAddressUrl(8453, USER_ONE)).toBe(`https://basescan.org/address/${USER_ONE}`)
    expect(explorerAddressUrl(999, USER_ONE)).toBeNull()
  })

  it('refuses malformed hashes and addresses so they can never enter a link URL slot', () => {
    expect(explorerTxUrl(8453, '0xabc')).toBeNull()
    expect(explorerTxUrl(8453, `${TX_HASH}> <!channel`)).toBeNull()
    expect(explorerAddressUrl(8453, 'not-an-address')).toBeNull()
    expect(debankUrl('not-an-address')).toBeNull()
  })

  it('builds debank portfolio links from a valid address', () => {
    expect(debankUrl(USER_ONE)).toBe(`https://debank.com/profile/${USER_ONE}`)
  })
})

describe('chainLabel', () => {
  it('names known chains and falls back to the id', () => {
    expect(chainLabel(8453)).toBe('midnight-base')
    expect(chainLabel(999)).toBe('midnight-999')
  })
})

describe('addressLabel', () => {
  it('returns the CRM company name when the wallet store tracks the address', () => {
    expect(addressLabel(crm({ [USER_ONE]: 'Kraken' }), USER_ONE)).toBe('Kraken')
  })

  it('resolves case-insensitively, so a lowercase query still hits the checksummed key', () => {
    expect(addressLabel(crm({ [USER_ONE]: 'Kraken' }), USER_ONE.toLowerCase())).toBe('Kraken')
  })

  it('falls back to the abbreviated hex for an untracked address', () => {
    expect(addressLabel(new InMemoryWalletCrmStore(), USER_ONE)).toBe('0x958e...1917')
  })

  it('falls back to the abbreviated hex when the tracked Company cell is blank', () => {
    expect(addressLabel(crm({ [USER_ONE]: '   ' }), USER_ONE)).toBe('0x958e...1917')
  })
})

describe('tokenAmount', () => {
  it('shows a malformed amount verbatim instead of dropping the alert', () => {
    expect(
      tokenAmount('not-a-number', {
        chainId: 8453,
        address: USDC_TOKEN,
        name: null,
        symbol: 'USDC',
        decimals: 6
      })
    ).toBe('not-a-number USDC')
  })

  it('renders full-precision amounts with thousands separators', () => {
    const usdc = {
      chainId: 8453,
      address: USDC_TOKEN,
      name: null,
      symbol: 'USDC',
      decimals: 6
    } as const
    expect(tokenAmount('5000000000', usdc)).toBe('5,000 USDC')
    expect(tokenAmount('500000', usdc)).toBe('0.5 USDC')
  })
})

describe('marketLabel', () => {
  it('renders the loan/collateral pair and LLTV when the event names a collateral', () => {
    expect(marketLabel(registryWithTokens(), MARKET_A, WETH_TOKEN)).toBe(USDC_MARKET)
  })

  it('falls back to the sole configured collateral when no collateral is named', () => {
    expect(marketLabel(registryWithTokens(), MARKET_A)).toBe(USDC_MARKET)
  })

  it('renders the loan token alone when several collaterals leave none to single out', () => {
    const tokens = new TokenRegistry()
    tokens.record({
      market_id: MARKET_A,
      chain_id: 8453,
      loan_token: USDC_TOKEN,
      maturity: MATURITY,
      collaterals: [
        { token: WETH_TOKEN, lltv: '860000000000000000' },
        { token: USER_ONE, lltv: '900000000000000000' }
      ]
    })
    expect(marketLabel(tokens, MARKET_A)).toBe('USDC')
  })

  it('omits the LLTV for a collateral the market does not list', () => {
    expect(marketLabel(registryWithTokens(), MARKET_A, USER_TWO)).toBe('USDC/0x5356...4C91')
  })

  it('degrades to the abbreviated market id when the registry has never seen it', () => {
    expect(marketLabel(new TokenRegistry(), MARKET_A)).toBe('0xaaaa...aaaa')
  })
})

describe('marketUrl', () => {
  it('builds the app market page for a known chain', () => {
    expect(marketUrl(8453, MARKET_A)).toBe(MARKET_URL)
  })

  it('returns null for unknown chains', () => {
    expect(marketUrl(999, MARKET_A)).toBeNull()
    expect(marketUrl(undefined, MARKET_A)).toBeNull()
  })

  it('refuses non-hash market ids so they can never enter a link URL slot', () => {
    expect(marketUrl(8453, '0xabc')).toBeNull()
    expect(marketUrl(8453, `${MARKET_A}> <!channel`)).toBeNull()
  })
})

describe('AlertFormatter.transaction', () => {
  it('renders a lend as the full field block: title, amount, market, footer and link row', () => {
    const alert = fmt(
      registryWithTokens(),
      priceLookup({ [`8453:${USDC_TOKEN.toLowerCase()}`]: 1 })
    ).transaction(
      lendItem({
        id: 'id-1',
        created_at: 1_700_000_000,
        assets: '20000000000000',
        units: '20020000000000'
      })
    )
    expect(alert.key).toBe('id-1')
    expect(alert.severity).toBe('info')
    expect(alert.title).toBe(
      'Lend: 20,000,000 USDC ($20,000,000) in USDC/WETH (86.0%) ' +
        'by 0x958e...1917 on midnight-base at 14/11/2023 - 22:13:20 UTC'
    )
    expect(alert.text).toBe(
      [
        '🚀 Lend',
        '   💰 Amount: 20,000,000 USDC ($20,000,000)',
        `   🏦 Market: ${USDC_MARKET_LINK}`,
        `   👤 By <${addrUrl(USER_ONE)}|0x958e...1917> on midnight-base, 14/11/2023 - 22:13:20 UTC`,
        `   🔗 <${txUrl}|Basescan>  <${debank(USER_ONE)}|Debank>`
      ].join('\n')
    )
  })

  it('renders amounts without a $-figure when no price is cached', () => {
    const alert = fmt(registryWithTokens(), NO_PRICES).transaction(
      lendItem({ id: 'id-1b', created_at: 1_700_000_000, assets: '20000000000000' })
    )
    expect(alert.title).toContain('Lend: 20,000,000 USDC in USDC/WETH (86.0%)')
    expect(alert.title).not.toContain('$')
  })

  it('falls back to raw base units when the market is not in the registry', () => {
    const alert = fmt(new TokenRegistry(), NO_PRICES).transaction(
      lendItem({ id: 'id-2', created_at: 1_700_000_000 })
    )
    expect(alert.title).toBe(
      'Lend: 1000 assets in 0xaaaa...aaaa ' +
        'by 0x958e...1917 on midnight-base at 14/11/2023 - 22:13:20 UTC'
    )
    // The abbreviated-id fallback still links: the chain comes from the item, not the registry.
    expect(alert.text).toContain(`<${MARKET_URL}|0xaaaa...aaaa>`)
  })

  it('falls back to raw base units when the loan token has no metadata', () => {
    const alert = fmt(registryWithTokens(USER_ONE), NO_PRICES).transaction(
      lendItem({ id: 'id-9', created_at: 1_700_000_000 })
    )
    expect(alert.title).toBe(
      'Lend: 1000 assets in 0x958e...1917/WETH (86.0%) ' +
        'by 0x958e...1917 on midnight-base at 14/11/2023 - 22:13:20 UTC'
    )
  })

  it('titles a borrow, lend exit and withdraw with their own emoji', () => {
    const registry = registryWithTokens()
    const borrow = fmt(registry, NO_PRICES).transaction(
      borrowItem({ id: 'id-bo', created_at: 1_700_000_000 })
    )
    expect(borrow.text.startsWith('💵 Borrow\n')).toBe(true)
    const withdraw = fmt(registry, NO_PRICES).transaction(withdrawCollateralItem({ id: 'id-wd' }))
    expect(withdraw.text.startsWith('📤 Withdraw Collateral\n')).toBe(true)
  })

  it('renders a secondary borrow exit as a Repay with a loan-token amount', () => {
    const alert = fmt(
      registryWithTokens(),
      priceLookup({ [`8453:${USDC_TOKEN.toLowerCase()}`]: 1 })
    ).transaction(
      exitBorrowSecondaryItem({ id: 'id-rp', created_at: 1_700_000_000, assets: '300000000' })
    )
    expect(alert.text.startsWith('🔄 Repay\n')).toBe(true)
    expect(alert.text).toContain('   💰 Amount: 300 USDC ($300)')
  })

  it('keeps unit-denominated primary repays labeled as units', () => {
    const alert = fmt(registryWithTokens(), NO_PRICES).transaction(
      exitPrimaryItem({ id: 'id-3', units: '42000000' })
    )
    expect(alert.title).toBe(
      'Repay (primary): 42 units in USDC/WETH (86.0%) ' +
        'by 0x958e...1917 on midnight-base at 01/01/1970 - 00:01:40 UTC'
    )
    expect(alert.text.startsWith('🔄 Repay (primary)')).toBe(true)
    expect(alert.severity).toBe('info')
  })

  it("resolves collateral amounts against the event's own collateral token", () => {
    const alert = fmt(
      registryWithTokens(),
      priceLookup({ [`8453:${WETH_TOKEN.toLowerCase()}`]: 3000 })
    ).transaction(supplyCollateralItem({ id: 'id-4', assets: '5000000000000000000' }))
    expect(alert.title).toBe(
      'Supply Collateral: 5 WETH ($15,000) in USDC/WETH (86.0%) ' +
        'by 0x958e...1917 on midnight-base at 01/01/1970 - 00:01:40 UTC'
    )
    expect(alert.text.startsWith('📥 Supply Collateral')).toBe(true)
    expect(alert.text).toContain('   💰 Amount: 5 WETH ($15,000)')
  })

  it('formats a clean liquidation as warning, naming the borrower, seizure and repayment', () => {
    const alert = fmt(
      registryWithTokens(),
      priceLookup({
        [`8453:${WETH_TOKEN.toLowerCase()}`]: 3000,
        [`8453:${USDC_TOKEN.toLowerCase()}`]: 0.999
      })
    ).transaction(
      liquidationItem({
        id: 'id-5',
        repaid_units: '500000000',
        collateral: WETH_TOKEN,
        seized_assets: '2460000000000000000'
      })
    )
    expect(alert.severity).toBe('warning')
    expect(alert.title).toBe(
      'Liquidation (full): seized 2.46 WETH ($7,380), repaid 500 USDC ($499.50) ' +
        'in USDC/WETH (86.0%) of 0x5356...4C91 on midnight-base at 01/01/1970 - 00:01:40 UTC'
    )
    expect(alert.text).toBe(
      [
        '🔴 Liquidation (full)',
        '   ⚠️ Seized: 2.46 WETH ($7,380)',
        '   💳 Repaid: 500 USDC ($499.50)',
        `   🏦 Market: ${USDC_MARKET_LINK}`,
        `   👤 Of <${addrUrl(USER_TWO)}|0x5356...4C91> on midnight-base, 01/01/1970 - 00:01:40 UTC`,
        `   🔗 <${txUrl}|Basescan>  <${debank(USER_TWO)}|Debank>`
      ].join('\n')
    )
  })

  it('escalates bad-debt liquidations to critical with a BAD DEBT title and bad-debt line', () => {
    const alert = fmt(registryWithTokens(), NO_PRICES).transaction(
      liquidationItem({ id: 'id-6', bad_debt: '123000000' })
    )
    expect(alert.severity).toBe('critical')
    expect(alert.title).toContain('BAD DEBT Liquidation (full):')
    expect(alert.text.startsWith('🚨 BAD DEBT Liquidation (full)')).toBe(true)
    expect(alert.text).toContain('   🩸 Bad debt: 123 units')
  })

  it('degrades to plain escaped text when the tx hash and account are malformed', () => {
    const item = {
      ...lendItem({ id: 'id-8', created_at: 1_700_000_000, account: '<!channel>' }),
      tx_hash: `${TX_HASH}> <!here`
    }
    const alert = fmt(registryWithTokens(), NO_PRICES).transaction(item)
    // Neither malformed value survives URL validation — only the market link remains…
    expect(alert.text).not.toContain('basescan')
    expect(alert.text).not.toContain('debank')
    expect(alert.text).toContain(USDC_MARKET_LINK)
    // …and every API-sourced fragment is escaped — nothing can form a control sequence.
    expect(alert.text).not.toContain('<!')
    expect(alert.text).toContain('&lt;!chan')
  })

  it('replaces a tracked counterparty hex with its CRM company name across the block', () => {
    const alert = fmt(registryWithTokens(), NO_PRICES, crm({ [USER_ONE]: 'Kraken' })).transaction(
      lendItem({ id: 'id-crm', created_at: 1_700_000_000 })
    )
    // Headline "by …" segment and the footer link label both name the company, not the hex.
    expect(alert.title).toContain('by Kraken on midnight-base')
    expect(alert.title).not.toContain('0x958e...1917')
    expect(alert.text).toContain(`<${addrUrl(USER_ONE)}|Kraken>`)
    // The explorer/Debank URLs still carry the raw address — only the visible label changed.
    expect(alert.text).toContain(debank(USER_ONE))
  })

  it('names a tracked liquidated borrower by company after the "of" preposition', () => {
    const alert = fmt(
      registryWithTokens(),
      NO_PRICES,
      crm({ [USER_TWO]: 'Wintermute' })
    ).transaction(liquidationItem({ id: 'id-crm-liq', collateral: WETH_TOKEN }))
    expect(alert.title).toContain('of Wintermute on midnight-base')
    expect(alert.text).toContain(`Of <${addrUrl(USER_TWO)}|Wintermute>`)
  })

  it('escapes API-sourced strings in the mrkdwn text but not the plain title', () => {
    // The API-sourced fragment reaching the amount here is the raw amount itself — the
    // unresolved-market fallback shows it verbatim. Fetched symbols take the same path: every
    // amount fragment goes through escapeSlack in the mrkdwn text.
    const alert = fmt(new TokenRegistry(), NO_PRICES).transaction(
      lendItem({ id: 'id-7', created_at: 1_700_000_000, assets: '<!channel>' })
    )
    expect(alert.title).toContain('Lend: <!channel> assets')
    expect(alert.text).toContain('Amount: &lt;!channel&gt; assets')
  })
})

describe('AlertFormatter.take', () => {
  it('merges both legs of one take into a single Make Order Filled block', () => {
    const alert = fmt(
      registryWithTokens(),
      priceLookup({ [`8453:${USDC_TOKEN.toLowerCase()}`]: 1 })
    ).take({
      lend: lendItem({
        id: 'l',
        created_at: 1_700_000_000,
        assets: '20000000000000',
        units: '20020000000000'
      }),
      borrow: borrowItem({
        id: 'b',
        created_at: 1_700_000_000,
        assets: '20000000000000',
        units: '20020000000000'
      })
    })
    expect(alert.key).toBe('l+b')
    expect(alert.severity).toBe('info')
    expect(alert.title).toBe(
      'Make Order Filled: 20,000,000 USDC ($20,000,000) at 0.03% in USDC/WETH (86.0%) ' +
        'by 0x958e...1917 + 0x5356...4C91 on midnight-base at 14/11/2023 - 22:13:20 UTC'
    )
    expect(alert.text).toBe(
      [
        '⚡ Make Order Filled',
        '   💰 Amount: 20,000,000 USDC ($20,000,000)',
        `   📈 APR: 0.03% in ${USDC_MARKET_LINK}`,
        `   👤 By <${addrUrl(USER_ONE)}|0x958e...1917> + <${addrUrl(USER_TWO)}|0x5356...4C91> ` +
          'on midnight-base, 14/11/2023 - 22:13:20 UTC',
        `   🔗 <${txUrl}|Basescan>`
      ].join('\n')
    )
  })

  it('names tracked buyer and seller by company in the headline and footer', () => {
    const alert = fmt(
      registryWithTokens(),
      NO_PRICES,
      crm({ [USER_ONE]: 'Kraken', [USER_TWO]: 'Wintermute' })
    ).take({
      lend: lendItem({ id: 'l', created_at: 1_700_000_000 }),
      borrow: borrowItem({ id: 'b', created_at: 1_700_000_000 })
    })
    expect(alert.title).toContain('by Kraken + Wintermute')
    expect(alert.text).toContain('Kraken')
    expect(alert.text).toContain('Wintermute')
    // …and neither abbreviated hex survives anywhere in the block.
    expect(alert.text).not.toContain('0x958e...1917')
    expect(alert.text).not.toContain('0x5356...4C91')
  })

  it("splits into two amount lines when the legs' attributed amounts diverge (position crossing)", () => {
    const borrow = borrowItem({ id: 'b', created_at: 1_700_000_000, assets: '20000000000000' })
    borrow.data.assets = '5000000000000'
    const alert = fmt(
      registryWithTokens(),
      priceLookup({ [`8453:${USDC_TOKEN.toLowerCase()}`]: 1 })
    ).take({
      lend: lendItem({ id: 'l', created_at: 1_700_000_000, assets: '20000000000000' }),
      borrow
    })
    expect(alert.text).toContain('   💰 Lend: 20,000,000 USDC')
    expect(alert.text).toContain('   💰 Borrow: 5,000,000 USDC')
    expect(alert.title).toContain('lend 20,000,000 USDC ($20,000,000), borrow 5,000,000 USDC')
  })

  it('escapes the API-sourced amount fallback in the mrkdwn text but not the plain title', () => {
    const alert = fmt(new TokenRegistry(), NO_PRICES).take({
      lend: lendItem({ id: 'l', created_at: 1_700_000_000 }),
      borrow: borrowItem({ id: 'b', created_at: 1_700_000_000, assets: '<!channel>' })
    })
    expect(alert.title).toContain('borrow <!channel> assets')
    expect(alert.text).toContain('Borrow: &lt;!channel&gt; assets')
  })
})

describe('AlertFormatter.offer', () => {
  const registry = () => registryWithTokens()
  const priced = () => priceLookup({ [`8453:${USDC_TOKEN.toLowerCase()}`]: 1 })

  it('renders a lend order posted as the full order block with APR and expiry', () => {
    const alert = fmt(registry(), priced()).offer(offerEvent({ assets: 150000000n }), OBSERVED)
    expect(alert.key).toBe(`${MARKET_A}:bids:${USER_ONE}:${OFFER_GROUP}:4250:created`)
    expect(alert.severity).toBe('info')
    expect(alert.title).toBe(
      'Lend Order Posted: 150 USDC ($150) at 1.25% in USDC/WETH (86.0%), ' +
        `expires 28/08/2026 by 0x958e...1917 on midnight-base at ${OBSERVED_TIME}`
    )
    expect(alert.text).toBe(
      [
        '📝 Lend Order Posted',
        '   💰 Amount: 150 USDC ($150)',
        `   📈 APR: 1.25% in ${USDC_MARKET_LINK}`,
        '   📅 Expiry: 28/08/2026',
        `   👤 By <${addrUrl(USER_ONE)}|0x958e...1917> on midnight-base, ${OBSERVED_TIME}`,
        `   🔗 <${addrUrl(USER_ONE)}|Basescan>  <${debank(USER_ONE)}|Debank>`
      ].join('\n')
    )
  })

  it('titles the ask side as a borrow order with its own emoji', () => {
    const alert = fmt(registry(), priced()).offer(
      offerEvent({ bucket: offerBucket({ side: 'asks' }), assets: 150000000n }),
      OBSERVED
    )
    expect(alert.key).toBe(`${MARKET_A}:asks:${USER_ONE}:${OFFER_GROUP}:4250:created`)
    expect(alert.text.startsWith('💳 Borrow Order Posted\n')).toBe(true)
  })

  it('adds a Previous line and encodes both caps in the key when a bucket resizes', () => {
    const alert = fmt(registry(), priced()).offer(
      offerEvent({
        kind: 'resized',
        bucket: offerBucket({ maxUnits: '2000' }),
        previous: offerBucket({ maxUnits: '1000' }),
        assets: 200000000n,
        previousAssets: 100000000n
      }),
      OBSERVED
    )
    expect(alert.key).toBe(
      `${MARKET_A}:bids:${USER_ONE}:${OFFER_GROUP}:4250:resized:1000/0->2000/0`
    )
    expect(alert.text.startsWith('🔀 Lend Order Resized\n')).toBe(true)
    expect(alert.text).toContain('   💰 Amount: 200 USDC ($200)')
    expect(alert.text).toContain('   ↩️ Previous: 100 USDC ($100)')
  })

  it('titles a closed bucket and keys it as closed', () => {
    const alert = fmt(registry(), NO_PRICES).offer(
      offerEvent({ kind: 'closed', bucket: offerBucket({ maxUnits: '1000000000' }) }),
      OBSERVED
    )
    expect(alert.key).toBe(`${MARKET_A}:bids:${USER_ONE}:${OFFER_GROUP}:4250:closed`)
    expect(alert.text.startsWith('❌ Lend Order Closed\n')).toBe(true)
    expect(alert.text).toContain('   💰 Amount: 1,000 units')
  })

  it('degrades to a plain market line and drops the chain when the market is unknown', () => {
    const alert = fmt(new TokenRegistry(), NO_PRICES).offer(offerEvent(), OBSERVED)
    expect(alert.text).toBe(
      [
        '📝 Lend Order Posted',
        '   💰 Amount: 1000 units',
        '   🏦 Market: 0xaaaa...aaaa',
        '   📅 Expiry: 28/08/2026',
        `   👤 By 0x958e...1917, ${OBSERVED_TIME}`,
        `   🔗 <${debank(USER_ONE)}|Debank>`
      ].join('\n')
    )
  })
})

describe('aprLabel', () => {
  const NOW = 1_700_000_000
  const YEAR = 31_536_000

  it('annualizes a tick over the remaining term', () => {
    expect(aprLabel(4250, NOW + YEAR, NOW)).toBe('1.25%')
  })

  it('scales with the time left to maturity', () => {
    // Same tick, half the term: the fixed period rate annualizes to twice the APR.
    expect(aprLabel(4250, NOW + YEAR / 2, NOW)).toBe('2.51%')
  })

  it('renders the top of the tick range as a zero rate', () => {
    // MAX_TICK's price snaps to exactly 1, a legitimate 0% quote — not a fallback case.
    expect(aprLabel(6744, NOW + YEAR, NOW)).toBe('0%')
  })

  it('returns null for a matured market', () => {
    expect(aprLabel(4250, NOW, NOW)).toBeNull()
    expect(aprLabel(4250, NOW - 1, NOW)).toBeNull()
  })

  it('returns null when the tick price snaps to zero', () => {
    // Ticks 0–1 round to a zero price, which TickLib rejects with DivisionByZeroError.
    expect(aprLabel(0, NOW + YEAR, NOW)).toBeNull()
  })

  it('returns null for a tick beyond the deployed range', () => {
    expect(aprLabel(6745, NOW + YEAR, NOW)).toBeNull()
    expect(aprLabel(-1, NOW + YEAR, NOW)).toBeNull()
  })

  it('renders a deep low tick at face value, however extreme', () => {
    // Tick 495 over a year — an astronomical quote, but still the offer's actual rate.
    expect(aprLabel(495, NOW + YEAR, NOW)).toBe('166,666,566.67%')
  })
})

describe('fillAprLabel', () => {
  const NOW = 1_700_000_000
  const YEAR = 31_536_000

  it('reads an at-par fill (price 1) as a zero rate', () => {
    expect(fillAprLabel('1000', '1000', NOW + YEAR, NOW)).toBe('0%')
  })

  it('annualizes a discounted fill price over the remaining term', () => {
    // A 5% discount (95 paid per 100 units) over one year annualizes to ~5.22% simple APR.
    expect(fillAprLabel('95', '100', NOW + YEAR, NOW)).toBe('5.22%')
  })

  it('returns null for a matured market and for zero units', () => {
    expect(fillAprLabel('95', '100', NOW, NOW)).toBeNull()
    expect(fillAprLabel('1000', '0', NOW + YEAR, NOW)).toBeNull()
  })
})
