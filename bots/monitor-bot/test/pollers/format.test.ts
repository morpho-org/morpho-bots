import { describe, expect, it } from 'vitest'

import {
  chainLabel,
  explorerAddressUrl,
  explorerTxUrl,
  formatTakeAlert,
  formatTransactionAlert,
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
    collaterals: [{ token: WETH_TOKEN }]
  })
  return tokens
}

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
    expect(tokenAmount('not-a-number', { name: null, symbol: 'USDC', decimals: 6 })).toBe(
      'not-a-number USDC'
    )
  })
})

describe('formatTransactionAlert', () => {
  it('renders a lend as one linked sentence: size symbol action / by / on / at', () => {
    const alert = formatTransactionAlert(
      lendItem({ id: 'id-1', created_at: 1_700_000_000, assets: '20000000000000' }),
      registryWithTokens()
    )
    expect(alert.key).toBe('id-1')
    expect(alert.severity).toBe('info')
    expect(alert.title).toBe(
      '20M USDC lend by 0x958e...1917 on midnight-base at 2023-11-14 22:13:20 UTC'
    )
    expect(alert.text).toBe(
      `<https://basescan.org/tx/${TX_HASH}|20M USDC lend> ` +
        `by <https://basescan.org/address/${USER_ONE}|0x958e...1917> ` +
        'on midnight-base at 2023-11-14 22:13:20 UTC'
    )
  })

  it('falls back to raw base units when the market is not in the registry', () => {
    const alert = formatTransactionAlert(
      lendItem({ id: 'id-2', created_at: 1_700_000_000 }),
      new TokenRegistry()
    )
    expect(alert.title).toBe(
      '1000 assets lend by 0x958e...1917 on midnight-base at 2023-11-14 22:13:20 UTC'
    )
  })

  it('falls back to raw base units when the loan token has no metadata', () => {
    const alert = formatTransactionAlert(
      lendItem({ id: 'id-9', created_at: 1_700_000_000 }),
      registryWithTokens(USER_ONE)
    )
    expect(alert.title).toBe(
      '1000 assets lend by 0x958e...1917 on midnight-base at 2023-11-14 22:13:20 UTC'
    )
  })

  it('keeps unit-denominated primary repays labeled as units', () => {
    const alert = formatTransactionAlert(
      exitPrimaryItem({ id: 'id-3', units: '42000000' }),
      registryWithTokens()
    )
    expect(alert.title).toBe(
      '42 units repay (primary) by 0x958e...1917 on midnight-base at 1970-01-01 00:01:40 UTC'
    )
    expect(alert.severity).toBe('info')
  })

  it("resolves collateral amounts against the event's own collateral token", () => {
    const alert = formatTransactionAlert(
      supplyCollateralItem({ id: 'id-4', assets: '5000000000000000000' }),
      registryWithTokens()
    )
    expect(alert.title).toBe(
      '5 WETH collateral supply by 0x958e...1917 on midnight-base at 1970-01-01 00:01:40 UTC'
    )
  })

  it('formats a clean liquidation as warning, naming the borrower', () => {
    const alert = formatTransactionAlert(
      liquidationItem({ id: 'id-5', repaid_units: '500000000' }),
      registryWithTokens()
    )
    expect(alert.severity).toBe('warning')
    expect(alert.title).toBe(
      '500 units full liquidation of 0x5356...4C91 on midnight-base at 1970-01-01 00:01:40 UTC'
    )
  })

  it('escalates bad-debt liquidations to critical with a BAD DEBT headline', () => {
    const alert = formatTransactionAlert(
      liquidationItem({ id: 'id-6', bad_debt: '123000000' }),
      registryWithTokens()
    )
    expect(alert.severity).toBe('critical')
    expect(alert.title).toBe(
      'BAD DEBT — 123 units bad debt (full liquidation) of 0x5356...4C91 ' +
        'on midnight-base at 1970-01-01 00:01:40 UTC'
    )
  })

  it('degrades to plain escaped text when the tx hash and account are malformed', () => {
    const item = {
      ...lendItem({ id: 'id-8', created_at: 1_700_000_000, account: '<!channel>' }),
      tx_hash: `${TX_HASH}> <!here`
    }
    const alert = formatTransactionAlert(item, registryWithTokens())
    // No URL survives validation, so the sentence carries no mrkdwn link at all…
    expect(alert.text).not.toContain('<https')
    // …and every API-sourced fragment is escaped — nothing can form a control sequence.
    expect(alert.text).not.toContain('<!')
    expect(alert.text).toContain('&lt;!chan')
  })

  it('escapes API-sourced strings in the mrkdwn text but not the plain title', () => {
    // The API-sourced fragment reaching the headline here is the raw amount itself — the
    // unresolved-market fallback shows it verbatim. Fetched symbols take the same path: every
    // label fragment goes through slackLink's escaping in the mrkdwn text.
    const alert = formatTransactionAlert(
      lendItem({ id: 'id-7', created_at: 1_700_000_000, assets: '<!channel>' }),
      new TokenRegistry()
    )
    expect(alert.title).toContain('<!channel> assets lend')
    expect(alert.text).toContain('&lt;!channel&gt; assets lend')
  })
})

describe('formatTakeAlert', () => {
  it('merges both legs of one take into a single sentence naming buyer and seller', () => {
    const alert = formatTakeAlert(
      {
        lend: lendItem({ id: 'l', created_at: 1_700_000_000, assets: '20000000000000' }),
        borrow: borrowItem({ id: 'b', created_at: 1_700_000_000, assets: '20000000000000' })
      },
      registryWithTokens()
    )
    expect(alert.key).toBe('l+b')
    expect(alert.severity).toBe('info')
    expect(alert.title).toBe(
      '20M USDC lend by 0x958e...1917 + 20M USDC borrow by 0x5356...4C91 ' +
        'on midnight-base at 2023-11-14 22:13:20 UTC'
    )
    expect(alert.text).toBe(
      `<https://basescan.org/tx/${TX_HASH}|20M USDC lend> ` +
        `by <https://basescan.org/address/${USER_ONE}|0x958e...1917> ` +
        `+ 20M USDC borrow by <https://basescan.org/address/${USER_TWO}|0x5356...4C91> ` +
        'on midnight-base at 2023-11-14 22:13:20 UTC'
    )
  })

  it("keeps each leg's attributed amount when they diverge (position crossing)", () => {
    const borrow = borrowItem({ id: 'b', created_at: 1_700_000_000, assets: '20000000000000' })
    borrow.data.assets = '5000000000000'
    const alert = formatTakeAlert(
      { lend: lendItem({ id: 'l', created_at: 1_700_000_000, assets: '20000000000000' }), borrow },
      registryWithTokens()
    )
    expect(alert.title).toContain('20M USDC lend by')
    expect(alert.title).toContain('5M USDC borrow by')
  })

  it('escapes the API-sourced amount fallback in the plain-text borrow segment', () => {
    // The borrow half is the one label slot not built by slackLink, so it must escape on its own.
    const alert = formatTakeAlert(
      {
        lend: lendItem({ id: 'l', created_at: 1_700_000_000 }),
        borrow: borrowItem({ id: 'b', created_at: 1_700_000_000, assets: '<!channel>' })
      },
      new TokenRegistry()
    )
    expect(alert.title).toContain('<!channel> assets borrow')
    expect(alert.text).toContain('&lt;!channel&gt; assets borrow')
  })
})
