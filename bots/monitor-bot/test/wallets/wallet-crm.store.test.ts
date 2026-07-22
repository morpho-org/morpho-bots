import { describe, expect, it } from 'vitest'

import type { WalletCrmRow } from '../../src/wallets/wallet-csv'

import { InMemoryWalletCrmStore } from '../../src/wallets/wallet-crm.store'

const CHECKSUM = '0xC5e0E2Bd8B8663c621b5051d863D072295dA9720'
const LOWER = CHECKSUM.toLowerCase()

function rows(): WalletCrmRow[] {
  return [{ address: CHECKSUM, values: { Company: 'Kraken', 'Net USD Value': '135661960.92' } }]
}

describe('InMemoryWalletCrmStore', () => {
  it('is empty when constructed with no rows', () => {
    const store = new InMemoryWalletCrmStore()
    expect(store.size).toBe(0)
    expect(store.get(CHECKSUM)).toBeNull()
  })

  it('returns the row values for a tracked address', () => {
    const store = new InMemoryWalletCrmStore(rows())
    expect(store.get(CHECKSUM)).toEqual({ Company: 'Kraken', 'Net USD Value': '135661960.92' })
    expect(store.size).toBe(1)
  })

  it('looks up case-insensitively regardless of the query casing', () => {
    const store = new InMemoryWalletCrmStore(rows())
    expect(store.get(LOWER)).toEqual(store.get(CHECKSUM))
    expect(store.has(LOWER)).toBe(true)
    expect(store.has(CHECKSUM)).toBe(true)
  })

  it('returns null / false for an untracked address', () => {
    const store = new InMemoryWalletCrmStore(rows())
    expect(store.get('0x0000000000000000000000000000000000000000')).toBeNull()
    expect(store.has('0x0000000000000000000000000000000000000000')).toBe(false)
  })

  it('returns null / false for a non-address string instead of throwing', () => {
    const store = new InMemoryWalletCrmStore(rows())
    expect(store.get('not-an-address')).toBeNull()
    expect(store.has('not-an-address')).toBe(false)
  })

  it('exposes every tracked row via entries()', () => {
    const store = new InMemoryWalletCrmStore(rows())
    expect(store.entries()).toEqual([
      { address: CHECKSUM, values: { Company: 'Kraken', 'Net USD Value': '135661960.92' } }
    ])
  })
})
