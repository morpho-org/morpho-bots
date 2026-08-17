import type { InputMarketParams } from '@morpho-org/blue-sdk'
import type { Address, Client, Hex } from 'viem'

import { getChainAddresses } from '@morpho-org/blue-sdk'
import { fetchAccrualVault } from '@morpho-org/blue-sdk-viem'
import { isAddressEqual } from 'viem'
import { getBlock } from 'viem/actions'

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
}

export type VaultData = {
  vaultAddress: Address
  marketsData: VaultMarketData[]
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
 * Reads one vault's full reallocation input over RPC as a single deployless `fetchAccrualVault`
 * query: the withdraw queue plus, per market, the accrued Blue state, the vault's accrued position,
 * and the vault's supply cap. Every read — including the accrual timestamp, taken from the pinned
 * block rather than wall clock — is pinned to `blockNumber`, so the snapshot is coherent across
 * markets and reproducible. Throws on any failed read; the tick catches per vault.
 */
export const fetchVaultData = async (
  client: Client,
  vault: Address,
  { chainId, blockNumber }: { chainId: number; blockNumber: bigint }
): Promise<VaultData> => {
  const [block, accrualVault] = await Promise.all([
    getBlock(client, { blockNumber }),
    fetchAccrualVault(vault, client, { chainId, blockNumber })
  ])
  const accrued = accrualVault.accrueInterest(block.timestamp)

  // Map insertion order is the withdraw-queue order (see `AccrualVault`'s constructor).
  const marketsData = [...accrued.allocations.values()].map((allocation): VaultMarketData => {
    const market = allocation.position.market
    const rateAtTarget = market.rateAtTarget ?? 0n
    return {
      id: market.id,
      params: {
        loanToken: market.params.loanToken,
        collateralToken: market.params.collateralToken,
        oracle: market.params.oracle,
        irm: market.params.irm,
        lltv: market.params.lltv
      },
      state: {
        totalSupplyAssets: market.totalSupplyAssets,
        totalBorrowAssets: market.totalBorrowAssets
      },
      cap: allocation.config.cap,
      vaultAssets: allocation.position.supplyAssets,
      rateAtTarget,
      isAdaptiveCurve: isAdaptiveCurveMarket(market.params.irm, rateAtTarget, chainId)
    }
  })

  return { vaultAddress: vault, marketsData }
}
