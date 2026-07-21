import { describe, expect, it } from 'vitest'

import type { PriceLookup } from '../../src/tokens/prices'

import {
  aprLabel,
  AlertFormatter,
  chainLabel,
  debankUrl,
  explorerAddressUrl,
  explorerTxUrl,
  marketLabel,
  marketUrl,
  tokenAmount
} from '../../src/alerts/formatter'
import { TokenRegistry } from '../../src/tokens/registry'
import {
  borrowItem,
  exitPrimaryItem,
  lendItem,
  liquidationItem,
  supplyCollateralItem,
  MARKET_A,
  MATURITY,
  NO_PRICES,
  priceLookup,
  TX_HASH,
  USDC_TOKEN,
  USER_ONE,
  USER_TWO,
  WETH_TOKEN
} from '../midnight/fixtures'

/** The formatter under test, holding the given registry + price cache. */
const fmt = (tokens: TokenRegistry, prices: PriceLookup) => new AlertFormatter({ tokens, prices })

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

/**
 * MARKET_A's headline label when its tokens resolve: loan/collateral pair (WETH is the sole
 * configured collateral, so it shows even when the event names none), LLTV, maturity.
 */
const USDC_MARKET = 'USDC/WETH (86.0%) 30/09/2026'

/** The app page every market segment links to in mrkdwn, replacing the raw market id. */
const MARKET_URL = `https://markets.morpho.org/fixed/base/${MARKET_A}`

/** MARKET_A's market segment as it appears in mrkdwn text: the label linked to the app page. */
const USDC_MARKET_LINK = `<${MARKET_URL}|${USDC_MARKET}>`

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
})

describe('marketLabel', () => {
  it('renders loan/collateral pair, LLTV and maturity when the event names a collateral', () => {
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
    expect(marketLabel(tokens, MARKET_A)).toBe('USDC 30/09/2026')
  })

  it('omits the LLTV for a collateral the market does not list', () => {
    expect(marketLabel(registryWithTokens(), MARKET_A, USER_TWO)).toBe(
      'USDC/0x5356...4C91 30/09/2026'
    )
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
  it('renders a lend as the full block: headline, trade detail, footer and link row', () => {
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
      `Lend: 20M ($20M) in ${USDC_MARKET} ` +
        'by 0x958e...1917 on midnight-base at 14/11/2023 - 22:13:20 UTC'
    )
    expect(alert.text).toBe(
      [
        `:rocket: Lend: 20M ($20M) in ${USDC_MARKET_LINK}`,
        '        • 20.02M units @ 0.999',
        `By <https://basescan.org/address/${USER_ONE}|0x958e...1917> ` +
          'on midnight-base, 14/11/2023 - 22:13:20 UTC',
        `<https://basescan.org/tx/${TX_HASH}|Basescan>  ` +
          `<https://debank.com/profile/${USER_ONE}|Debank>`
      ].join('\n')
    )
  })

  it('renders amounts without a $-figure when no price is cached', () => {
    const alert = fmt(registryWithTokens(), NO_PRICES).transaction(
      lendItem({ id: 'id-1b', created_at: 1_700_000_000, assets: '20000000000000' })
    )
    expect(alert.title).toContain('Lend: 20M in USDC')
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
      'Lend: 1000 assets in 0x958e...1917/WETH (86.0%) 30/09/2026 ' +
        'by 0x958e...1917 on midnight-base at 14/11/2023 - 22:13:20 UTC'
    )
  })

  it('keeps unit-denominated primary repays labeled as units', () => {
    const alert = fmt(registryWithTokens(), NO_PRICES).transaction(
      exitPrimaryItem({ id: 'id-3', units: '42000000' })
    )
    expect(alert.title).toBe(
      `Repay (primary): 42 units in ${USDC_MARKET} ` +
        'by 0x958e...1917 on midnight-base at 01/01/1970 - 00:01:40 UTC'
    )
    expect(alert.text.startsWith(':leftwards_arrow_with_hook:')).toBe(true)
    expect(alert.severity).toBe('info')
  })

  it("resolves collateral amounts against the event's own collateral token", () => {
    const alert = fmt(
      registryWithTokens(),
      priceLookup({ [`8453:${WETH_TOKEN.toLowerCase()}`]: 3000 })
    ).transaction(supplyCollateralItem({ id: 'id-4', assets: '5000000000000000000' }))
    expect(alert.title).toBe(
      `Supply collateral: 5 ($15K) in ${USDC_MARKET} ` +
        'by 0x958e...1917 on midnight-base at 01/01/1970 - 00:01:40 UTC'
    )
    expect(alert.text.startsWith(':sparkles:')).toBe(true)
  })

  it('formats a clean liquidation as warning, naming the borrower and the seizure', () => {
    const alert = fmt(
      registryWithTokens(),
      priceLookup({ [`8453:${WETH_TOKEN.toLowerCase()}`]: 3000 })
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
      `Liquidation (full): 500 units repaid in ${USDC_MARKET} ` +
        'of 0x5356...4C91 on midnight-base at 01/01/1970 - 00:01:40 UTC'
    )
    expect(alert.text.startsWith(':zap:')).toBe(true)
    expect(alert.text).toContain('• seized: 2.46 WETH ($7.38K)')
    // The borrower, not the liquidator, is the footer subject.
    expect(alert.text).toContain(`Of <https://basescan.org/address/${USER_TWO}|0x5356...4C91>`)
  })

  it('escalates bad-debt liquidations to critical with a BAD DEBT headline and detail', () => {
    const alert = fmt(registryWithTokens(), NO_PRICES).transaction(
      liquidationItem({ id: 'id-6', bad_debt: '123000000' })
    )
    expect(alert.severity).toBe('critical')
    expect(alert.title).toContain('BAD DEBT — Liquidation (full):')
    expect(alert.text.startsWith(':rotating_light:')).toBe(true)
    expect(alert.text).toContain('• bad debt: 123 units')
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

  it('escapes API-sourced strings in the mrkdwn text but not the plain title', () => {
    // The API-sourced fragment reaching the headline here is the raw amount itself — the
    // unresolved-market fallback shows it verbatim. Fetched symbols take the same path: every
    // headline fragment goes through escapeSlack in the mrkdwn text.
    const alert = fmt(new TokenRegistry(), NO_PRICES).transaction(
      lendItem({ id: 'id-7', created_at: 1_700_000_000, assets: '<!channel>' })
    )
    expect(alert.title).toContain('Lend: <!channel> assets')
    expect(alert.text).toContain('Lend: &lt;!channel&gt; assets')
  })
})

describe('AlertFormatter.take', () => {
  it('merges both legs of one take into a single block naming buyer and seller', () => {
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
      `Take: 20M ($20M) lend + 20M ($20M) borrow in ${USDC_MARKET} ` +
        'by 0x958e...1917 + 0x5356...4C91 on midnight-base at 14/11/2023 - 22:13:20 UTC'
    )
    expect(alert.text).toBe(
      [
        `:handshake: Take: 20M ($20M) lend + 20M ($20M) borrow in ${USDC_MARKET_LINK}`,
        '        • lend: 20.02M units @ 0.999 by 0x958e...1917  ' +
          `<https://basescan.org/address/${USER_ONE}|Basescan>  ` +
          `<https://debank.com/profile/${USER_ONE}|Debank>`,
        '        • borrow: 20.02M units @ 0.999 by 0x5356...4C91  ' +
          `<https://basescan.org/address/${USER_TWO}|Basescan>  ` +
          `<https://debank.com/profile/${USER_TWO}|Debank>`,
        `By <https://basescan.org/address/${USER_ONE}|0x958e...1917> ` +
          `+ <https://basescan.org/address/${USER_TWO}|0x5356...4C91> ` +
          'on midnight-base, 14/11/2023 - 22:13:20 UTC',
        `<https://basescan.org/tx/${TX_HASH}|Basescan>`
      ].join('\n')
    )
  })

  it("keeps each leg's attributed amount when they diverge (position crossing)", () => {
    const borrow = borrowItem({ id: 'b', created_at: 1_700_000_000, assets: '20000000000000' })
    borrow.data.assets = '5000000000000'
    const alert = fmt(registryWithTokens(), NO_PRICES).take({
      lend: lendItem({ id: 'l', created_at: 1_700_000_000, assets: '20000000000000' }),
      borrow
    })
    expect(alert.title).toContain('20M lend + 5M borrow')
  })

  it('escapes the API-sourced amount fallback in the mrkdwn text but not the plain title', () => {
    const alert = fmt(new TokenRegistry(), NO_PRICES).take({
      lend: lendItem({ id: 'l', created_at: 1_700_000_000 }),
      borrow: borrowItem({ id: 'b', created_at: 1_700_000_000, assets: '<!channel>' })
    })
    expect(alert.title).toContain('<!channel> assets borrow')
    expect(alert.text).toContain('&lt;!channel&gt; assets borrow')
  })
})

describe('aprLabel', () => {
  const NOW = 1_700_000_000
  const YEAR = 31_536_000

  it('annualizes a tick over the remaining term', () => {
    expect(aprLabel(4250, NOW + YEAR, NOW)).toBe('1.25% APR')
  })

  it('scales with the time left to maturity', () => {
    // Same tick, half the term: the fixed period rate annualizes to twice the APR.
    expect(aprLabel(4250, NOW + YEAR / 2, NOW)).toBe('2.51% APR')
  })

  it('renders the top of the tick range as a zero rate', () => {
    // MAX_TICK's price snaps to exactly 1, a legitimate 0% quote — not a fallback case.
    expect(aprLabel(6744, NOW + YEAR, NOW)).toBe('0% APR')
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
    expect(aprLabel(495, NOW + YEAR, NOW)).toBe('166,666,566.67% APR')
  })
})
