import type { InputMarketParams } from '@morpho-org/blue-sdk'
import type { Address, Client, Hex } from 'viem'

import {
  AccrualVaultV2MorphoMarketV1Adapter,
  VaultV2MorphoMarketV1Adapter
} from '@morpho-org/blue-sdk'
import { fetchAccrualVaultV2, vaultV2Abi } from '@morpho-org/blue-sdk-viem'
import { getAddress } from 'viem'
import { readContract } from 'viem/actions'

import { InvalidVaultError } from './invalid-vault.error'

export type MarketState = {
  totalSupplyAssets: bigint
  totalSupplyShares: bigint
  totalBorrowAssets: bigint
  totalBorrowShares: bigint
}

/**
 * One cap id's state: the vault's absolute cap, WAD-scaled relative cap (fraction of totalAssets),
 * and the on-chain `allocation(id)` the contract enforces both caps against.
 */
export type CapState = {
  absolute: bigint
  relative: bigint
  allocation: bigint
}

export type VaultV2MarketData = {
  /** The Blue market id (what strategy-config overrides key on). */
  id: Hex
  /** The vault cap id (`keccak256(abi.encode("this/marketParams", adapter, params))`). */
  capId: Hex
  params: InputMarketParams
  state: MarketState
  cap: CapState
  /** The adapter's accrued position in this market, in assets. */
  vaultAssets: bigint
  /** AdaptiveCurveIRM `rateAtTarget` after accrual; 0 for markets not on that IRM. */
  rateAtTarget: bigint
}

export type VaultV2Data = {
  vaultAddress: Address
  adapterAddress: Address
  /** The vault's total assets, interest accrued to now. */
  totalAssets: bigint
  /** The vault's un-allocated asset balance (deallocate parks here; allocate draws from here). */
  idleAssets: bigint
  /** Adapter-level ("this") cap state — an aggregate ceiling over every allocation. */
  adapterCap: CapState
  /** Collateral-level cap state per distinct collateral token (checksummed key). */
  collateralCaps: Record<Address, CapState>
  marketsData: VaultV2MarketData[]
}

const readCap = async (
  client: Client,
  vault: Address,
  id: Hex,
  blockNumber: bigint
): Promise<CapState> => {
  const [absolute, relative, allocation] = await Promise.all([
    readContract(client, {
      address: vault,
      abi: vaultV2Abi,
      functionName: 'absoluteCap',
      args: [id],
      blockNumber
    }),
    readContract(client, {
      address: vault,
      abi: vaultV2Abi,
      functionName: 'relativeCap',
      args: [id],
      blockNumber
    }),
    readContract(client, {
      address: vault,
      abi: vaultV2Abi,
      functionName: 'allocation',
      args: [id],
      blockNumber
    })
  ])
  return { absolute, relative, allocation }
}

/**
 * Reads one VaultV2's full reallocation input over RPC, pinned to `blockNumber` for a coherent
 * snapshot: the accrued vault tree via blue-sdk's `fetchAccrualVaultV2` (which also proves the
 * address is a factory-made VaultV2), plus the per-id cap/allocation reads the SDK fetcher does not
 * cover for a regular adapter (market ids, the adapter id, and each distinct collateral id).
 * Throws {@link InvalidVaultError} unless the vault has exactly one adapter and it is a
 * MorphoMarketV1 adapter. Throws on any failed read — the tick catches per vault.
 */
export const fetchVaultV2Data = async (
  client: Client,
  vault: Address,
  { chainId, blockNumber }: { chainId: number; blockNumber: bigint }
): Promise<VaultV2Data> => {
  const vaultV2 = await fetchAccrualVaultV2(vault, client, { chainId, blockNumber })

  const marketAdapters = vaultV2.accrualAdapters.filter(
    (adapter): adapter is AccrualVaultV2MorphoMarketV1Adapter =>
      adapter instanceof AccrualVaultV2MorphoMarketV1Adapter
  )
  if (vaultV2.adapters.length !== 1 || marketAdapters.length !== 1) {
    throw new InvalidVaultError(
      `vault ${vault} must have exactly one MorphoMarketV1 adapter; found ` +
        `${vaultV2.adapters.length} adapter(s) of which ${marketAdapters.length} are MorphoMarketV1`
    )
  }
  const adapter = marketAdapters[0]!
  const adapterAddress = getAddress(adapter.address)

  const now = BigInt(Math.floor(Date.now() / 1000))

  const positionByMarketId = new Map(
    adapter.positions.map(position => [position.marketId, position])
  )
  const collateralTokens = [
    ...new Set(adapter.marketParamsList.map(params => getAddress(params.collateralToken)))
  ]

  const [adapterCap, collateralCapList, marketsData] = await Promise.all([
    readCap(client, vault, VaultV2MorphoMarketV1Adapter.adapterId(adapterAddress), blockNumber),
    Promise.all(
      collateralTokens.map(async token => ({
        token,
        cap: await readCap(
          client,
          vault,
          VaultV2MorphoMarketV1Adapter.collateralId(token),
          blockNumber
        )
      }))
    ),
    Promise.all(
      adapter.marketParamsList.map(async (params): Promise<VaultV2MarketData> => {
        const position = positionByMarketId.get(params.id)
        if (position === undefined) {
          throw new InvalidVaultError(
            `vault ${vault} adapter position missing for market ${params.id}`
          )
        }
        const capId = VaultV2MorphoMarketV1Adapter.marketParamsId(adapterAddress, params)
        const cap = await readCap(client, vault, capId, blockNumber)
        const accrued = position.accrueInterest(now)
        return {
          id: params.id,
          capId,
          params: {
            loanToken: params.loanToken,
            collateralToken: params.collateralToken,
            oracle: params.oracle,
            irm: params.irm,
            lltv: params.lltv
          },
          state: {
            totalSupplyAssets: accrued.market.totalSupplyAssets,
            totalSupplyShares: accrued.market.totalSupplyShares,
            totalBorrowAssets: accrued.market.totalBorrowAssets,
            totalBorrowShares: accrued.market.totalBorrowShares
          },
          cap,
          vaultAssets: accrued.supplyAssets,
          rateAtTarget: accrued.market.rateAtTarget ?? 0n
        }
      })
    )
  ])

  return {
    vaultAddress: vault,
    adapterAddress,
    totalAssets: vaultV2.accrueInterest(now).vault._totalAssets,
    idleAssets: vaultV2.assetBalance,
    adapterCap,
    collateralCaps: Object.fromEntries(collateralCapList.map(({ token, cap }) => [token, cap])),
    marketsData
  }
}
