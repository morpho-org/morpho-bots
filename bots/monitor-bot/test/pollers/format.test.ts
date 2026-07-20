import { describe, expect, it } from 'vitest'

import { explorerTxUrl, formatTransactionAlert } from '../../src/pollers/format'
import {
  exitPrimaryItem,
  lendItem,
  liquidationItem,
  supplyCollateralItem,
  USER_ONE,
  USER_TWO
} from '../midnight/fixtures'

describe('explorerTxUrl', () => {
  it('builds a basescan link for chain 8453 and falls back to the raw hash', () => {
    expect(explorerTxUrl(8453, '0xabc')).toBe('https://basescan.org/tx/0xabc')
    expect(explorerTxUrl(999, '0xabc')).toBe('0xabc')
  })
})

describe('formatTransactionAlert', () => {
  it('formats a lend take order', () => {
    const alert = formatTransactionAlert(lendItem({ id: 'id-1', created_at: 1, assets: '500' }))
    expect(alert.key).toBe('id-1')
    expect(alert.title).toBe('take order (lend): 500 assets')
    expect(alert.severity).toBe('info')
    expect(alert.lines).toContain(`maker: ${USER_ONE}`)
    expect(alert.lines).toContain(`taker: ${USER_TWO}`)
    expect(alert.lines.some(line => line.startsWith('tx: https://basescan.org/tx/'))).toBe(true)
  })

  it('labels primary repays as face value', () => {
    const alert = formatTransactionAlert(exitPrimaryItem({ id: 'id-2', units: '42' }))
    expect(alert.title).toBe('repay (primary): 42 units (face value)')
    expect(alert.severity).toBe('info')
  })

  it('formats collateral supply with the collateral token', () => {
    const alert = formatTransactionAlert(supplyCollateralItem({ id: 'id-3', assets: '7' }))
    expect(alert.title).toBe('collateral supplied: 7')
    expect(alert.lines).toContain(`collateral: ${USER_TWO}`)
  })

  it('formats a clean liquidation as warning', () => {
    const alert = formatTransactionAlert(liquidationItem({ id: 'id-4', repaid_units: '500' }))
    expect(alert.title).toBe('full liquidation: 500 units repaid')
    expect(alert.severity).toBe('warning')
    expect(alert.lines).toContain(`borrower: ${USER_TWO}`)
  })

  it('escalates bad-debt liquidations to critical with a BAD DEBT title', () => {
    const alert = formatTransactionAlert(liquidationItem({ id: 'id-5', bad_debt: '123' }))
    expect(alert.title).toBe('BAD DEBT — full liquidation: 123 bad debt')
    expect(alert.severity).toBe('critical')
  })
})
