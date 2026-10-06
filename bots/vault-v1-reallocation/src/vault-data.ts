import type { InputMarketParams } from '@morpho-org/blue-sdk'
import type { BatchLensTransportType } from '@repo/utils'
import type { Address, Client, Hex, Transport } from 'viem'

import { getChainAddresses } from '@morpho-org/blue-sdk'
import { advanceRateAtTarget } from '@repo/utils'
import { isAddressEqual, zeroAddress } from 'viem'

import { readVaultV1Lens } from './state/lens.sol'

export type MarketState = {
  totalSupplyAssets: bigint
  totalBorrowAssets: bigint
}

export type VaultMarketData = {
  id: Hex
  params: InputMarketParams
  state: MarketState
  /** The vault's supply cap for this market (`config(id).cap`). */
  cap: bigint
  /** The vault's current position in this market, in assets (shares converted down). */
  vaultAssets: bigint
  /** AdaptiveCurveIRM `rateAtTarget` after accrual; 0 for markets not on that IRM. */
  rateAtTarget: bigint
  /**
   * Whether this market runs the chain's canonical AdaptiveCurveIRM. Only then is `rateAtTarget`
   * meaningful, so only then may APY↔utilization inversion be applied — see
   * {@link isAdaptiveCurveMarket}.
   */
  isAdaptiveCurve: boolean
  /**
   * The vault's idle market: the zero-collateral market Vault V1 uses to park unallocated assets.
   * It never borrows, so no rate strategy applies to it — it only ever absorbs or supplies a plan's
   * imbalance.
   */
  isIdle: boolean
}

export type VaultData = {
  vaultAddress: Address
  owner: Address
  curator: Address
  /**
   * `isAllocator(eoa)` on this vault, read in the same call as the snapshot. Combined with `owner`
   * and `curator` it is the whole of Vault V1's `onlyAllocatorRole`.
   */
  isAllocator: boolean
  marketsData: VaultMarketData[]
  /**
   * Ids of the non-idle markets excluded from `apy-range` for running a foreign IRM. Precomputed
   * here rather than in the tick — the mapping above already walks every market.
   */
  nonAdaptiveCurveMarketIds: Hex[]
}

/**
 * A market qualifies only if it runs the chain's canonical AdaptiveCurveIRM **and** reports a
 * non-zero `rateAtTarget`. The second half is belt-and-suspenders: `AdaptiveCurveIrmLib`'s inverse
 * returns WAD for every rate when `rateAtTarget` is 0, which would silently read as "far below
 * range" and drain the vault's whole position out of the market on valid, simulation-passing
 * calldata.
 */
const isAdaptiveCurveMarket = (irm: Address, rateAtTarget: bigint, chainId: number): boolean =>
  rateAtTarget > 0n && isAddressEqual(irm, getChainAddresses(chainId).adaptiveCurveIrm)

/**
 * Reads EVERY given vault's full reallocation input — roles, withdraw queue, and per-market Blue
 * state, cap, position, and `rateAtTarget` — in ONE deployless `eth_call` pinned to `blockNumber`,
 * so the snapshot is coherent across vaults and markets alike. The lens projects each market's
 * accrual read-only inside that call; only the IRM's `rateAtTarget` is finished off here, by
 * {@link advanceRateAtTarget} from `@repo/utils`.
 *
 * Keyed by lower-cased vault address. A vault the lens declined is absent rather than throwing —
 * the reader's `declined: 'throw'` default means that can only happen if the envelope itself could
 * not serve it, which the tick reports per vault.
 */
export const fetchVaults = async (
  client: Client<Transport<BatchLensTransportType>>,
  vaults: readonly Address[],
  { chainId, blockNumber, eoa }: { chainId: number; blockNumber: bigint; eoa: Address }
): Promise<Map<string, VaultData>> => {
  const { morpho, adaptiveCurveIrm } = getChainAddresses(chainId)
  const rows = await readVaultV1Lens(
    client,
    { morpho, adaptiveCurveIrm },
    vaults.map(vault => ({ vault, eoa })),
    blockNumber
  )
  return new Map(
    vaults
      .map(vault => [vault, rows.get(vault.toLowerCase())] as const)
      .filter((entry): entry is readonly [Address, NonNullable<(typeof entry)[1]>] => !!entry[1])
      .map(([vault, row]) => [vault.toLowerCase(), toVaultData(vault, row, chainId)])
  )
}

const toVaultData = (
  vault: Address,
  row: Awaited<ReturnType<typeof readVaultV1Lens>> extends Map<string, infer R> ? R : never,
  chainId: number
): VaultData => {
  // The lens walks `withdrawQueue` in order, so array order is withdraw-queue order.
  const marketsData = row.markets.map((market): VaultMarketData => {
    const rateAtTarget = advanceRateAtTarget(market)
    return {
      id: market.id,
      params: market.params,
      state: {
        totalSupplyAssets: market.totalSupplyAssets,
        totalBorrowAssets: market.totalBorrowAssets
      },
      cap: market.cap,
      vaultAssets: market.vaultAssets,
      rateAtTarget,
      isAdaptiveCurve: isAdaptiveCurveMarket(market.params.irm, rateAtTarget, chainId),
      isIdle: isAddressEqual(market.params.collateralToken, zeroAddress)
    }
  })

  return {
    vaultAddress: vault,
    owner: row.owner,
    curator: row.curator,
    isAllocator: row.isAllocator,
    marketsData,
    nonAdaptiveCurveMarketIds: marketsData
      .filter(marketData => !marketData.isAdaptiveCurve && !marketData.isIdle)
      .map(marketData => marketData.id)
  }
}
