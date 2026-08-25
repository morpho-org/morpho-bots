import type { InputMarketParams } from '@morpho-org/blue-sdk'
import type { BatchLensTransportType } from '@repo/utils'
import type { Address, Client, Hex, Transport } from 'viem'

import { getChainAddresses } from '@morpho-org/blue-sdk'
import { getAddress, isAddressEqual, zeroAddress } from 'viem'

import type { LensVaultOut } from './state/lens.sol'

import { InvalidVaultError } from './invalid-vault.error'
import { KIND_UNKNOWN, readVaultV2Lens } from './state/lens.sol'

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
  /**
   * Strict `isAllocator(eoa)` on the vault, read in the same call as the snapshot — deliberately
   * narrower than the V1 bot's allocator|curator|owner check, because VaultV2.allocate admits no
   * curator/owner fallback.
   */
  isAllocator: boolean
  /** The vault's total assets, accrued on-chain to the pinned block. */
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

const toCapState = (caps: {
  absoluteCap: bigint
  relativeCap: bigint
  allocation: bigint
}): CapState => ({
  absolute: caps.absoluteCap,
  relative: caps.relativeCap,
  allocation: caps.allocation
})

/**
 * Shapes one decoded lens row into {@link VaultV2Data}. Throws {@link InvalidVaultError} when the
 * row is not a factory-made VaultV2 with exactly one factory-verified Morpho Blue market adapter
 * (either adapter-contract generation) — the signing policy authorizes the vault as a tx target and
 * pins its adapter, so any other shape must fail loud.
 */
export const toVaultV2Data = (vault: Address, row: LensVaultOut, chainId: number): VaultV2Data => {
  if (!row.isVaultV2) {
    throw new InvalidVaultError(`VAULT_WHITELIST entry ${vault} is not a factory-made VaultV2`)
  }
  const qualifying = row.adapters.filter(({ kind }) => kind !== KIND_UNKNOWN)
  if (row.adapters.length !== 1 || qualifying.length !== 1) {
    throw new InvalidVaultError(
      `vault ${vault} must have exactly one Morpho Blue market adapter; found ` +
        `${row.adapters.length} adapter(s) of which ${qualifying.length} qualify`
    )
  }
  const adapterAddress = getAddress(qualifying[0]!.adapter)

  const marketsData = row.markets.map(
    (market): VaultV2MarketData => ({
      id: market.id,
      capId: market.capId,
      params: market.params,
      state: {
        totalSupplyAssets: market.totalSupplyAssets,
        totalBorrowAssets: market.totalBorrowAssets
      },
      cap: toCapState(market.cap),
      vaultAssets: market.vaultAssets,
      rateAtTarget: market.rateAtTarget,
      isAdaptiveCurve: isAdaptiveCurveMarket(market.params.irm, market.rateAtTarget, chainId),
      isIdle: isAddressEqual(market.params.collateralToken, zeroAddress)
    })
  )

  // Markets sharing a collateral share one cap id; the lens reports the triple per market, so the
  // duplicates collapse to identical values here.
  const collateralCaps = Object.fromEntries(
    row.markets.map(market => [
      getAddress(market.params.collateralToken),
      toCapState(market.collateralCap)
    ])
  )

  return {
    vaultAddress: vault,
    adapterAddress,
    isAllocator: row.isAllocator,
    totalAssets: row.totalAssets,
    idleAssets: row.idleAssets,
    adapterCap: toCapState(row.adapterCap),
    collateralCaps,
    marketsData,
    nonAdaptiveCurveMarketIds: marketsData
      .filter(marketData => !marketData.isAdaptiveCurve && !marketData.isIdle)
      .map(marketData => marketData.id)
  }
}

/**
 * Reads one VaultV2's full reallocation input — factory identity, the EOA's allocator bit, idle
 * balance, adapter set, and per-market Blue state, position, `rateAtTarget`, and all three cap
 * levels — in a single deployless `eth_call` pinned to `blockNumber`, so the snapshot is coherent
 * across markets and reproducible. The lens accrues each market on-chain inside that call, so there
 * is no client-side accrual and no block-timestamp handling here.
 *
 * Throws {@link InvalidVaultError} on a non-VaultV2 address or an unsupported adapter shape (see
 * {@link toVaultV2Data}); a revert inside the lens propagates as-is. The tick catches per vault
 * either way.
 */
export const fetchVaultV2Data = async (
  client: Client<Transport<BatchLensTransportType>>,
  vault: Address,
  { chainId, blockNumber, eoa }: { chainId: number; blockNumber: bigint; eoa: Address }
): Promise<VaultV2Data> => {
  const {
    morpho,
    adaptiveCurveIrm,
    vaultV2Factory,
    morphoMarketV1AdapterFactory,
    morphoMarketV1AdapterV2Factory
  } = getChainAddresses(chainId)
  if (!vaultV2Factory) throw new InvalidVaultError(`chain ${chainId} has no VaultV2 factory`)
  const rows = await readVaultV2Lens(
    client,
    {
      morpho,
      adaptiveCurveIrm,
      vaultV2Factory,
      marketV1AdapterFactory: morphoMarketV1AdapterFactory ?? zeroAddress,
      marketV1AdapterV2Factory: morphoMarketV1AdapterV2Factory ?? zeroAddress
    },
    [{ vault, eoa }],
    blockNumber
  )
  // `readDeploylessBatchLens` already validates one output row per input, so the key is present.
  return toVaultV2Data(vault, rows.get(vault.toLowerCase())!, chainId)
}
