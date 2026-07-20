import { describe, expect, it } from 'vitest'

import {
  chainLabel,
  debankUrl,
  explorerAddressUrl,
  explorerTxUrl,
  formatTakeAlert,
  formatTransactionAlert,
  marketLabel,
  tokenAmount
} from '../../src/pollers/format'
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

/** MARKET_A's headline label when its loan token resolves: symbol, short id, maturity. */
const USDC_MARKET = 'USDC (0xaaaa...aaaa, matures 30/09/2026)'

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
  it('renders pair, LLTV, short id and maturity when the event names a collateral', () => {
    expect(marketLabel(registryWithTokens(), MARKET_A, WETH_TOKEN)).toBe(
      'WETH/USDC (86.0%, 0xaaaa...aaaa, matures 30/09/2026)'
    )
  })

  it('renders the loan token alone when no collateral is named', () => {
    expect(marketLabel(registryWithTokens(), MARKET_A)).toBe(USDC_MARKET)
  })

  it('omits the LLTV for a collateral the market does not list', () => {
    expect(marketLabel(registryWithTokens(), MARKET_A, USER_TWO)).toBe(
      '0x5356...4C91/USDC (0xaaaa...aaaa, matures 30/09/2026)'
    )
  })

  it('degrades to the abbreviated market id when the registry has never seen it', () => {
    expect(marketLabel(new TokenRegistry(), MARKET_A)).toBe('0xaaaa...aaaa')
  })
})

describe('formatTransactionAlert', () => {
  it('renders a lend as the full block: headline, trade detail, footer and link row', () => {
    const alert = formatTransactionAlert(
      lendItem({
        id: 'id-1',
        created_at: 1_700_000_000,
        assets: '20000000000000',
        units: '20020000000000'
      }),
      registryWithTokens(),
      priceLookup({ [`8453:${USDC_TOKEN.toLowerCase()}`]: 1 })
    )
    expect(alert.key).toBe('id-1')
    expect(alert.severity).toBe('info')
    expect(alert.title).toBe(
      `Lend: 20M ($20M) in ${USDC_MARKET} ` +
        'by 0x958e...1917 on midnight-base at 14/11/2023 - 22:13:20 UTC'
    )
    expect(alert.text).toBe(
      [
        `:rocket: Lend: 20M ($20M) in ${USDC_MARKET}`,
        '        • 20.02M units @ 0.999',
        `By <https://basescan.org/address/${USER_ONE}|0x958e...1917> ` +
          'on midnight-base, 14/11/2023 - 22:13:20 UTC',
        `<https://basescan.org/tx/${TX_HASH}|Basescan>  ` +
          `<https://debank.com/profile/${USER_ONE}|Debank>`
      ].join('\n')
    )
  })

  it('renders amounts without a $-figure when no price is cached', () => {
    const alert = formatTransactionAlert(
      lendItem({ id: 'id-1b', created_at: 1_700_000_000, assets: '20000000000000' }),
      registryWithTokens(),
      NO_PRICES
    )
    expect(alert.title).toContain('Lend: 20M in USDC')
    expect(alert.title).not.toContain('$')
  })

  it('falls back to raw base units when the market is not in the registry', () => {
    const alert = formatTransactionAlert(
      lendItem({ id: 'id-2', created_at: 1_700_000_000 }),
      new TokenRegistry(),
      NO_PRICES
    )
    expect(alert.title).toBe(
      'Lend: 1000 assets in 0xaaaa...aaaa ' +
        'by 0x958e...1917 on midnight-base at 14/11/2023 - 22:13:20 UTC'
    )
  })

  it('falls back to raw base units when the loan token has no metadata', () => {
    const alert = formatTransactionAlert(
      lendItem({ id: 'id-9', created_at: 1_700_000_000 }),
      registryWithTokens(USER_ONE),
      NO_PRICES
    )
    expect(alert.title).toBe(
      'Lend: 1000 assets in 0x958e...1917 (0xaaaa...aaaa, matures 30/09/2026) ' +
        'by 0x958e...1917 on midnight-base at 14/11/2023 - 22:13:20 UTC'
    )
  })

  it('keeps unit-denominated primary repays labeled as units', () => {
    const alert = formatTransactionAlert(
      exitPrimaryItem({ id: 'id-3', units: '42000000' }),
      registryWithTokens(),
      NO_PRICES
    )
    expect(alert.title).toBe(
      `Repay (primary): 42 units in ${USDC_MARKET} ` +
        'by 0x958e...1917 on midnight-base at 01/01/1970 - 00:01:40 UTC'
    )
    expect(alert.text.startsWith(':leftwards_arrow_with_hook:')).toBe(true)
    expect(alert.severity).toBe('info')
  })

  it("resolves collateral amounts against the event's own collateral token", () => {
    const alert = formatTransactionAlert(
      supplyCollateralItem({ id: 'id-4', assets: '5000000000000000000' }),
      registryWithTokens(),
      priceLookup({ [`8453:${WETH_TOKEN.toLowerCase()}`]: 3000 })
    )
    expect(alert.title).toBe(
      'Supply collateral: 5 ($15K) in WETH/USDC (86.0%, 0xaaaa...aaaa, matures 30/09/2026) ' +
        'by 0x958e...1917 on midnight-base at 01/01/1970 - 00:01:40 UTC'
    )
    expect(alert.text.startsWith(':sparkles:')).toBe(true)
  })

  it('formats a clean liquidation as warning, naming the borrower and the seizure', () => {
    const alert = formatTransactionAlert(
      liquidationItem({
        id: 'id-5',
        repaid_units: '500000000',
        collateral: WETH_TOKEN,
        seized_assets: '2460000000000000000'
      }),
      registryWithTokens(),
      priceLookup({ [`8453:${WETH_TOKEN.toLowerCase()}`]: 3000 })
    )
    expect(alert.severity).toBe('warning')
    expect(alert.title).toBe(
      'Liquidation (full): 500 units repaid in ' +
        'WETH/USDC (86.0%, 0xaaaa...aaaa, matures 30/09/2026) ' +
        'of 0x5356...4C91 on midnight-base at 01/01/1970 - 00:01:40 UTC'
    )
    expect(alert.text.startsWith(':zap:')).toBe(true)
    expect(alert.text).toContain('• seized: 2.46 WETH ($7.38K)')
    // The borrower, not the liquidator, is the footer subject.
    expect(alert.text).toContain(`Of <https://basescan.org/address/${USER_TWO}|0x5356...4C91>`)
  })

  it('escalates bad-debt liquidations to critical with a BAD DEBT headline and detail', () => {
    const alert = formatTransactionAlert(
      liquidationItem({ id: 'id-6', bad_debt: '123000000' }),
      registryWithTokens(),
      NO_PRICES
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
    const alert = formatTransactionAlert(item, registryWithTokens(), NO_PRICES)
    // No URL survives validation, so the block carries no mrkdwn link at all…
    expect(alert.text).not.toContain('<https')
    // …and every API-sourced fragment is escaped — nothing can form a control sequence.
    expect(alert.text).not.toContain('<!')
    expect(alert.text).toContain('&lt;!chan')
  })

  it('escapes API-sourced strings in the mrkdwn text but not the plain title', () => {
    // The API-sourced fragment reaching the headline here is the raw amount itself — the
    // unresolved-market fallback shows it verbatim. Fetched symbols take the same path: every
    // headline fragment goes through escapeSlack in the mrkdwn text.
    const alert = formatTransactionAlert(
      lendItem({ id: 'id-7', created_at: 1_700_000_000, assets: '<!channel>' }),
      new TokenRegistry(),
      NO_PRICES
    )
    expect(alert.title).toContain('Lend: <!channel> assets')
    expect(alert.text).toContain('Lend: &lt;!channel&gt; assets')
  })
})

describe('formatTakeAlert', () => {
  it('merges both legs of one take into a single block naming buyer and seller', () => {
    const alert = formatTakeAlert(
      {
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
      },
      registryWithTokens(),
      priceLookup({ [`8453:${USDC_TOKEN.toLowerCase()}`]: 1 })
    )
    expect(alert.key).toBe('l+b')
    expect(alert.severity).toBe('info')
    expect(alert.title).toBe(
      `Take: 20M ($20M) lend + 20M ($20M) borrow in ${USDC_MARKET} ` +
        'by 0x958e...1917 + 0x5356...4C91 on midnight-base at 14/11/2023 - 22:13:20 UTC'
    )
    expect(alert.text).toBe(
      [
        `:handshake: Take: 20M ($20M) lend + 20M ($20M) borrow in ${USDC_MARKET}`,
        '        • lend: 20.02M units @ 0.999',
        '        • borrow: 20.02M units @ 0.999',
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
    const alert = formatTakeAlert(
      { lend: lendItem({ id: 'l', created_at: 1_700_000_000, assets: '20000000000000' }), borrow },
      registryWithTokens(),
      NO_PRICES
    )
    expect(alert.title).toContain('20M lend + 5M borrow')
  })

  it('escapes the API-sourced amount fallback in the mrkdwn text but not the plain title', () => {
    const alert = formatTakeAlert(
      {
        lend: lendItem({ id: 'l', created_at: 1_700_000_000 }),
        borrow: borrowItem({ id: 'b', created_at: 1_700_000_000, assets: '<!channel>' })
      },
      new TokenRegistry(),
      NO_PRICES
    )
    expect(alert.title).toContain('<!channel> assets borrow')
    expect(alert.text).toContain('&lt;!channel&gt; assets borrow')
  })
})
