import type { Address } from 'viem'

import { Injectable } from '@nestjs/common'
import { getAddress, isAddress } from 'viem'

import type { WalletCrmRecord, WalletCrmRow } from './wallet-csv'

export const WALLET_CRM_STORE = Symbol('WALLET_CRM_STORE')

/**
 * Read-only, address-keyed view over the Attio wallet-CRM export. Lookups are case-insensitive:
 * any valid address casing resolves to the same checksummed key, so callers holding viem-style
 * checksummed addresses hit the lowercase-keyed export without pre-normalizing.
 */
interface WalletCrmStore {
  /** The CRM columns for `address` (excluding the address itself), or `null` if not tracked. */
  get(address: string): WalletCrmRecord | null
  has(address: string): boolean
  readonly size: number
  /** Every tracked row — used for exports/diagnostics, not hot-path lookups. */
  entries(): WalletCrmRow[]
}

/**
 * In-process only, matching the repo's cross-tick-state philosophy: nothing is persisted and the
 * CSV is re-loaded from disk on each boot. Populated once at construction by the module factory
 * (see `buildWalletCrmStore`); the map is never mutated afterwards.
 */
@Injectable()
export class InMemoryWalletCrmStore implements WalletCrmStore {
  private readonly byAddress = new Map<Address, WalletCrmRecord>()

  constructor(rows: readonly WalletCrmRow[] = []) {
    for (const row of rows) {
      this.byAddress.set(row.address, row.values)
    }
  }

  // strict:false so callers can pass any valid-format address regardless of checksum casing.
  private normalize(address: string): Address | null {
    return isAddress(address, { strict: false }) ? getAddress(address) : null
  }

  get(address: string): WalletCrmRecord | null {
    const key = this.normalize(address)
    return key ? (this.byAddress.get(key) ?? null) : null
  }

  has(address: string): boolean {
    const key = this.normalize(address)
    return key !== null && this.byAddress.has(key)
  }

  get size(): number {
    return this.byAddress.size
  }

  entries(): WalletCrmRow[] {
    return [...this.byAddress.entries()].map(([address, values]) => ({ address, values }))
  }
}
