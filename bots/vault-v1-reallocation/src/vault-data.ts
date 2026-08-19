import type { InputMarketParams } from '@morpho-org/blue-sdk'
import type { BatchLensTransportType } from '@repo/utils'
import type { Address, Client, Hex, Transport } from 'viem'

import { getChainAddresses } from '@morpho-org/blue-sdk'
import { isAddressEqual, zeroAddress } from 'viem'

import { LensReadFailedError } from './lens-read-failed.error'
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
   * The vault's idle market: the zero-collateral market MetaMorpho uses to park unallocated assets.
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
   * and `curator` it is the whole of MetaMorpho's `onlyAllocatorRole`.
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
 * Reads one vault's full reallocation input — roles, withdraw queue, and per-market Blue state, cap,
 * position, and `rateAtTarget` — in a single deployless `eth_call` pinned to `blockNumber`, so the
 * snapshot is coherent across markets and reproducible. The lens accrues each market on-chain inside
 * that call, so there is no client-side accrual and no block-timestamp handling here.
 *
 * Throws {@link LensReadFailedError} when the lens returns no row for `vault` (a malformed or empty
 * response); a revert inside the lens propagates as-is. The tick catches per vault either way.
 */
export const fetchVaultData = async (
  client: Client<Transport<BatchLensTransportType>>,
  vault: Address,
  { chainId, blockNumber, eoa }: { chainId: number; blockNumber: bigint; eoa: Address }
): Promise<VaultData> => {
  const { morpho, adaptiveCurveIrm } = getChainAddresses(chainId)
  const rows = await readVaultV1Lens(
    client,
    { morpho, adaptiveCurveIrm },
    [{ vault, eoa }],
    blockNumber
  )
  const row = rows.get(vault.toLowerCase())
  if (!row) throw new LensReadFailedError(vault)

  // The lens walks `withdrawQueue` in order, so array order is withdraw-queue order.
  const marketsData = row.markets.map(
    (market): VaultMarketData => ({
      id: market.id,
      params: market.params,
      state: {
        totalSupplyAssets: market.totalSupplyAssets,
        totalBorrowAssets: market.totalBorrowAssets
      },
      cap: market.cap,
      vaultAssets: market.vaultAssets,
      rateAtTarget: market.rateAtTarget,
      isAdaptiveCurve: isAdaptiveCurveMarket(market.params.irm, market.rateAtTarget, chainId),
      isIdle: isAddressEqual(market.params.collateralToken, zeroAddress)
    })
  )

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
