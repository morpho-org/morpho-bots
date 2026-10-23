import type { VaultV2Cap, VaultV2Witness } from '@repo/validators'
import type { Address, Hex } from 'viem'

import { MarketUtils } from '@morpho-org/blue-sdk'
import { task } from '@repo/controller'
import { vaultV2CapIds } from '@repo/validators'
import { getAddress, isAddressEqual } from 'viem'

import type { Reallocation, Strategy } from './strategies'
import type { VaultV2Data } from './vault-data'

/** One whitelisted vault as the world read it, at one block of the kernel's chain. */
export type VaultReading = VaultV2Data & Readonly<{ block: number }>

/** Which way one leg of a reallocation moves the adapter's assets in a market. */
type Leg = Readonly<{ market: Hex; side: 'deallocate' | 'allocate' }>

/** A vault's reallocation as its strategy found it, or why it has none this read. */
export type Decision =
  | Readonly<{ reallocation: Reallocation; reason?: undefined }>
  | Readonly<{ reallocation?: undefined; reason: 'missing_role' | 'adapter_changed' | 'balanced' }>

/**
 * VaultV2's strict `isAllocator`, then the adapter the validator was configured with at startup:
 * a vault whose adapter changed since is not acted on until a restart re-reads it.
 */
export const decide = (reading: VaultV2Data, strategy: Strategy, adapter: Address): Decision => {
  if (!reading.isAllocator) return { reason: 'missing_role' }
  if (!isAddressEqual(reading.adapterAddress, adapter)) return { reason: 'adapter_changed' }
  const reallocation = strategy(reading)
  return reallocation ? { reallocation } : { reason: 'balanced' }
}

/**
 * What a vault's act rests on: the markets its reallocation moves, each with its direction. Accrual
 * moves every amount between reads without changing this, so only a change in what the strategy
 * wants to do refuses an act in flight; the vault's own caps and simulation bound the amounts.
 */
export const legsOf = (reallocation: Reallocation): Leg[] => [
  ...reallocation.deallocations.map(leg => ({ market: leg.marketId, side: 'deallocate' as const })),
  ...reallocation.allocations.map(leg => ({ market: leg.marketId, side: 'allocate' as const }))
]

/**
 * The vault as read for the validator: its total assets, the market, collateral and adapter cap of
 * each market, and the adapter's shares and the market's supply totals, with every id derived from the market's params as
 * the validator derives it from the calldata.
 */
export const witnessOf = (reading: VaultV2Data): VaultV2Witness => {
  const caps = new Map<Hex, VaultV2Cap>()
  for (const market of reading.marketsData) {
    const ids = vaultV2CapIds(reading.adapterAddress, market.params)
    const collateral = reading.collateralCaps[getAddress(market.params.collateralToken)]
    caps.set(ids.market, { id: ids.market, ...market.cap })
    if (collateral) caps.set(ids.collateral, { id: ids.collateral, ...collateral })
    caps.set(ids.adapter, { id: ids.adapter, ...reading.adapterCap })
  }
  return {
    totalAssets: reading.totalAssets,
    caps: [...caps.values()],
    positions: reading.marketsData.map(({ params, state, shares }) => ({
      market: MarketUtils.getMarketId(params),
      shares: shares.vault,
      totalAssets: state.totalSupplyAssets,
      totalShares: shares.total
    }))
  }
}

/** A vault with a reallocation wants it; two reallocations of one vault never run beside each other. */
export const reallocationTask = ({ bid }: Readonly<{ bid: bigint }>, key: string) =>
  task('reallocate', { priority: bid, conflicts: { writes: [`vault:${key}`] } })
