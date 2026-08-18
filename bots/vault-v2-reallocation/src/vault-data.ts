import type { InputMarketParams, MarketParams } from '@morpho-org/blue-sdk'
import type { Address, Client, Hex } from 'viem'

import {
  AccrualVaultV2MorphoMarketV1Adapter,
  AccrualVaultV2MorphoMarketV1AdapterV2,
  getChainAddresses,
  SharesMath,
  VaultV2MorphoMarketV1Adapter
} from '@morpho-org/blue-sdk'
import { fetchAccrualVaultV2, vaultV2Abi } from '@morpho-org/blue-sdk-viem'
import { getAddress, isAddressEqual } from 'viem'
import { getBlock, multicall } from 'viem/actions'

import { InvalidVaultError } from './invalid-vault.error'

export type MarketState = {
  totalSupplyAssets: bigint
  totalBorrowAssets: bigint
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
  /**
   * Whether this market runs the chain's canonical AdaptiveCurveIRM. Only then is `rateAtTarget`
   * meaningful, so only then may APY↔utilization inversion be applied — see
   * {@link isAdaptiveCurveMarket}.
   */
  isAdaptiveCurve: boolean
  /** A zero-collateral Blue market never borrows, so no rate strategy applies to it. */
  isIdle: boolean
}

export type VaultV2Data = {
  vaultAddress: Address
  adapterAddress: Address
  /** The vault's total assets, interest accrued to the pinned block's timestamp. */
  totalAssets: bigint
  /** The vault's un-allocated asset balance (deallocate parks here; allocate draws from here). */
  idleAssets: bigint
  /** Adapter-level ("this") cap state — an aggregate ceiling over every allocation. */
  adapterCap: CapState
  /** Collateral-level cap state per distinct collateral token (checksummed key). */
  collateralCaps: Record<Address, CapState>
  marketsData: VaultV2MarketData[]
  /**
   * Ids of the markets excluded from `apy-range` for running a foreign IRM. Precomputed here rather
   * than in the tick — the mapping below already walks every market.
   */
  nonAdaptiveCurveMarketIds: Hex[]
}

/**
 * A market qualifies only if it runs the chain's canonical AdaptiveCurveIRM **and** reports a
 * non-zero `rateAtTarget`. The second half is belt-and-suspenders: `AdaptiveCurveIrmLib`'s inverse
 * returns WAD for every rate when `rateAtTarget` is 0, which would silently read as "far below
 * range" and drain the adapter's whole position out of the market on valid, simulation-passing
 * calldata.
 */
const isAdaptiveCurveMarket = (irm: Address, rateAtTarget: bigint, chainId: number): boolean =>
  rateAtTarget > 0n && isAddressEqual(irm, getChainAddresses(chainId).adaptiveCurveIrm)

type MarketAdapter = AccrualVaultV2MorphoMarketV1Adapter | AccrualVaultV2MorphoMarketV1AdapterV2

type AdapterMarket = {
  params: MarketParams
  state: MarketState
  vaultAssets: bigint
  rateAtTarget: bigint
  isIdle: boolean
}

// Both Morpho Blue market adapter generations take the same abi-encoded market params in
// allocate/deallocate and derive identical cap ids; they differ only in how the SDK models their
// positions (AccrualPosition list vs supplyShares per market id). Normalize to one shape.
const normalizeAdapterMarkets = (adapter: MarketAdapter, timestamp: bigint): AdapterMarket[] => {
  if (adapter instanceof AccrualVaultV2MorphoMarketV1Adapter) {
    return adapter.marketParamsList.map(params => {
      const position = adapter.positions.find(candidate => candidate.marketId === params.id)
      if (position === undefined) {
        throw new InvalidVaultError(`adapter position missing for market ${params.id}`)
      }
      const accrued = position.accrueInterest(timestamp)
      return {
        params,
        state: accrued.market,
        vaultAssets: accrued.supplyAssets,
        rateAtTarget: accrued.market.rateAtTarget ?? 0n,
        isIdle: accrued.market.isIdle
      }
    })
  }
  return adapter.markets.map(market => {
    const accrued = market.accrueInterest(timestamp)
    return {
      params: accrued.params,
      state: accrued,
      vaultAssets: SharesMath.toAssets(
        adapter.supplyShares[accrued.id] ?? 0n,
        accrued.totalSupplyAssets,
        accrued.totalSupplyShares,
        'Down'
      ),
      rateAtTarget: accrued.rateAtTarget ?? 0n,
      isIdle: accrued.isIdle
    }
  })
}

const CAP_FUNCTIONS = ['absoluteCap', 'relativeCap', 'allocation'] as const

// One multicall for all ids' cap state — 3 × (markets + collaterals + 1) reads would otherwise be
// individual eth_calls per tick.
const readCaps = async (
  client: Client,
  vault: Address,
  ids: readonly Hex[],
  blockNumber: bigint
): Promise<CapState[]> => {
  const results = await multicall(client, {
    allowFailure: false,
    blockNumber,
    contracts: ids.flatMap(id =>
      CAP_FUNCTIONS.map(functionName => ({
        address: vault,
        abi: vaultV2Abi,
        functionName,
        args: [id] as const
      }))
    )
  })
  return ids.map((_, i) => ({
    absolute: results[i * CAP_FUNCTIONS.length] as bigint,
    relative: results[i * CAP_FUNCTIONS.length + 1] as bigint,
    allocation: results[i * CAP_FUNCTIONS.length + 2] as bigint
  }))
}

/**
 * Reads one VaultV2's full reallocation input over RPC, pinned to `blockNumber` for a coherent
 * snapshot: the accrued vault tree via blue-sdk's `fetchAccrualVaultV2` (which also proves the
 * address is a factory-made VaultV2), plus the per-id cap/allocation reads the SDK fetcher does not
 * cover for a regular adapter (market ids, the adapter id, and each distinct collateral id).
 * Throws {@link InvalidVaultError} unless the vault has exactly one adapter and it is a Morpho Blue
 * market adapter (either adapter-contract generation). Throws on any failed read — the tick
 * catches per vault.
 */
export const fetchVaultV2Data = async (
  client: Client,
  vault: Address,
  { chainId, blockNumber }: { chainId: number; blockNumber: bigint }
): Promise<VaultV2Data> => {
  // Accrue to the pinned block's timestamp, not wall clock, so the snapshot is coherent and
  // reproducible against the pinned reads.
  const [{ timestamp }, vaultV2] = await Promise.all([
    getBlock(client, { blockNumber }),
    fetchAccrualVaultV2(vault, client, { chainId, blockNumber })
  ])

  const marketAdapters = vaultV2.accrualAdapters.filter(
    (adapter): adapter is MarketAdapter =>
      adapter instanceof AccrualVaultV2MorphoMarketV1Adapter ||
      adapter instanceof AccrualVaultV2MorphoMarketV1AdapterV2
  )
  if (vaultV2.adapters.length !== 1 || marketAdapters.length !== 1) {
    throw new InvalidVaultError(
      `vault ${vault} must have exactly one Morpho Blue market adapter; found ` +
        `${vaultV2.adapters.length} adapter(s) of which ${marketAdapters.length} qualify`
    )
  }
  const adapter = marketAdapters[0]!
  const adapterAddress = getAddress(adapter.address)

  const adapterMarkets = normalizeAdapterMarkets(adapter, timestamp)
  const collateralTokens = [
    ...new Set(adapterMarkets.map(({ params }) => getAddress(params.collateralToken)))
  ]

  // Both adapter generations derive identical "this"/"collateralToken"/"this/marketParams" ids.
  const marketCapIds = adapterMarkets.map(({ params }) =>
    VaultV2MorphoMarketV1Adapter.marketParamsId(adapterAddress, params)
  )
  const caps = await readCaps(
    client,
    vault,
    [
      VaultV2MorphoMarketV1Adapter.adapterId(adapterAddress),
      ...collateralTokens.map(token => VaultV2MorphoMarketV1Adapter.collateralId(token)),
      ...marketCapIds
    ],
    blockNumber
  )
  const adapterCap = caps[0]!
  const collateralCaps = Object.fromEntries(
    collateralTokens.map((token, i) => [token, caps[1 + i]!])
  )
  const marketCaps = caps.slice(1 + collateralTokens.length)

  const marketsData = adapterMarkets.map(
    ({ params, state, vaultAssets, rateAtTarget, isIdle }, i): VaultV2MarketData => ({
      id: params.id,
      capId: marketCapIds[i]!,
      params: {
        loanToken: params.loanToken,
        collateralToken: params.collateralToken,
        oracle: params.oracle,
        irm: params.irm,
        lltv: params.lltv
      },
      state: {
        totalSupplyAssets: state.totalSupplyAssets,
        totalBorrowAssets: state.totalBorrowAssets
      },
      cap: marketCaps[i]!,
      vaultAssets,
      rateAtTarget,
      isAdaptiveCurve: isAdaptiveCurveMarket(params.irm, rateAtTarget, chainId),
      isIdle
    })
  )

  return {
    vaultAddress: vault,
    adapterAddress,
    totalAssets: vaultV2.accrueInterest(timestamp).vault._totalAssets,
    idleAssets: vaultV2.assetBalance,
    adapterCap,
    collateralCaps,
    marketsData,
    nonAdaptiveCurveMarketIds: marketsData
      .filter(marketData => !marketData.isAdaptiveCurve && !marketData.isIdle)
      .map(marketData => marketData.id)
  }
}
