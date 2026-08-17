import type { InputMarketParams, MarketId } from '@morpho-org/blue-sdk'
import type { Address, Client, Hex } from 'viem'

import { SharesMath } from '@morpho-org/blue-sdk'
import { fetchMarket, fetchPosition, metaMorphoAbi } from '@morpho-org/blue-sdk-viem'
import { readContract } from 'viem/actions'

export type MarketState = {
  totalSupplyAssets: bigint
  totalSupplyShares: bigint
  totalBorrowAssets: bigint
  totalBorrowShares: bigint
}

export type VaultMarketData = {
  id: Hex
  params: InputMarketParams
  state: MarketState
  /** The vault's supply cap for this market (`config(id).cap`). */
  cap: bigint
  /** The vault's current position in this market, in assets (shares converted down). */
  vaultAssets: bigint
  /** AdaptiveCurveIRM `rateAtTarget` after accrual; 0 for markets not on that IRM (the idle market). */
  rateAtTarget: bigint
}

export type VaultData = {
  vaultAddress: Address
  marketsData: VaultMarketData[]
}

/**
 * Reads one vault's full reallocation input over RPC: the withdraw queue, then per market the Blue
 * state (interest accrued to now), the vault's position, and the vault's supply cap. All reads are
 * pinned to `blockNumber` so the snapshot is coherent across markets. Throws on any failed read —
 * the tick catches per vault.
 */
export const fetchVaultData = async (
  client: Client,
  vault: Address,
  { chainId, blockNumber }: { chainId: number; blockNumber: bigint }
): Promise<VaultData> => {
  const queueLength = await readContract(client, {
    address: vault,
    abi: metaMorphoAbi,
    functionName: 'withdrawQueueLength',
    blockNumber
  })
  const marketIds = await Promise.all(
    Array.from({ length: Number(queueLength) }, (_, i) =>
      readContract(client, {
        address: vault,
        abi: metaMorphoAbi,
        functionName: 'withdrawQueue',
        args: [BigInt(i)],
        blockNumber
      })
    )
  )

  const now = BigInt(Math.floor(Date.now() / 1000))

  const marketsData = await Promise.all(
    marketIds.map(async (id): Promise<VaultMarketData> => {
      const marketId = id as MarketId
      const [market, position, marketConfig] = await Promise.all([
        fetchMarket(marketId, client, { chainId, blockNumber }),
        fetchPosition(vault, marketId, client, { chainId, blockNumber }),
        readContract(client, {
          address: vault,
          abi: metaMorphoAbi,
          functionName: 'config',
          args: [id],
          blockNumber
        })
      ])
      const accrued = market.accrueInterest(now)
      const [cap] = marketConfig
      return {
        id,
        params: {
          loanToken: accrued.params.loanToken,
          collateralToken: accrued.params.collateralToken,
          oracle: accrued.params.oracle,
          irm: accrued.params.irm,
          lltv: accrued.params.lltv
        },
        state: {
          totalSupplyAssets: accrued.totalSupplyAssets,
          totalSupplyShares: accrued.totalSupplyShares,
          totalBorrowAssets: accrued.totalBorrowAssets,
          totalBorrowShares: accrued.totalBorrowShares
        },
        cap,
        vaultAssets: SharesMath.toAssets(
          position.supplyShares,
          accrued.totalSupplyAssets,
          accrued.totalSupplyShares,
          'Down'
        ),
        rateAtTarget: accrued.rateAtTarget ?? 0n
      }
    })
  )

  return { vaultAddress: vault, marketsData }
}
