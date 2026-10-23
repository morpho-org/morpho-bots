import type { VaultV1Witness } from '@repo/validators'
import type { Address, Hex } from 'viem'

import { MarketUtils } from '@morpho-org/blue-sdk'
import { task } from '@repo/controller'
import { isAddressEqual, maxUint256 } from 'viem'

import type { MarketAllocation, Strategy } from './strategies'
import type { VaultData } from './vault-data'

import { UnlistedMarketError } from './errors'

/** One whitelisted vault as the world read it, at one block of the kernel's chain. */
export type VaultReading = VaultData & Readonly<{ block: number }>

/** Which way one leg of a reallocation moves the vault's assets in a market. */
type Leg = Readonly<{ market: Hex; side: 'withdraw' | 'deposit' }>

/** A vault's reallocation as its strategy found it, or why it has none this read. */
export type Decision =
  | Readonly<{ allocations: readonly MarketAllocation[]; reason?: undefined }>
  | Readonly<{ allocations?: undefined; reason: 'missing_role' | 'balanced' }>

/** Vault V1's `onlyAllocatorRole`: the allocator set, the curator, or the owner. */
const hasAllocatorRole = (vault: VaultData, eoa: Address) =>
  vault.isAllocator || isAddressEqual(vault.owner, eoa) || isAddressEqual(vault.curator, eoa)

export const decide = (reading: VaultData, strategy: Strategy, eoa: Address): Decision => {
  if (!hasAllocatorRole(reading, eoa)) return { reason: 'missing_role' }
  const allocations = strategy(reading)
  return allocations ? { allocations } : { reason: 'balanced' }
}

/**
 * What a vault's act rests on: the markets its reallocation moves, each with its direction. Accrual
 * moves every amount between reads without changing this, so only a change in what the strategy
 * wants to do refuses an act in flight; the vault's own checks and simulation bound the amounts.
 */
export const legsOf = (reading: VaultData, allocations: readonly MarketAllocation[]): Leg[] =>
  allocations.map(({ marketParams, assets }) => {
    const market = MarketUtils.getMarketId(marketParams)
    const held = reading.marketsData.find(
      data => MarketUtils.getMarketId(data.params) === market
    )?.vaultAssets
    if (held === undefined) throw new UnlistedMarketError(reading.vaultAddress, market)
    return { market, side: assets === maxUint256 || assets > held ? 'deposit' : 'withdraw' }
  })

/**
 * The vault's markets, caps and positions as read, with each id derived from its params as the
 * validator derives it from the calldata.
 */
export const witnessOf = (reading: VaultData): VaultV1Witness => ({
  markets: reading.marketsData.map(({ params, cap, vaultAssets }) => ({
    id: MarketUtils.getMarketId(params),
    cap,
    assets: vaultAssets
  }))
})

/** A vault with a reallocation wants it; two reallocations of one vault never run beside each other. */
export const reallocationTask = ({ bid }: Readonly<{ bid: bigint }>, key: string) =>
  task('reallocate', { priority: bid, conflicts: { writes: [`vault:${key}`] } })
