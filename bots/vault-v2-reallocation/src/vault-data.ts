import type { InputMarketParams } from '@morpho-org/blue-sdk'
import type { BatchLensTransportType } from '@repo/utils'
import type { Address, Client, Hex, Transport } from 'viem'

import { getChainAddresses } from '@morpho-org/blue-sdk'
import { advanceRateAtTarget } from '@repo/utils'
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
 * and the onchain `allocation(id)` the contract enforces both caps against.
 */
export type CapState = {
  absolute: bigint
  relative: bigint
  allocation: bigint
}

export type VaultV2MarketData = {
  /** The Blue Market id (what strategy-config overrides key on). */
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
  /** A zero-collateral Blue Market never borrows, so no rate strategy applies to it. */
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
  /** The vault's total assets, accrued onchain to the pinned block. */
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
 * row is not a factory-made VaultV2 with exactly one factory-verified Morpho Blue Market adapter
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
      `vault ${vault} must have exactly one Morpho Blue Market adapter; found ` +
        `${row.adapters.length} adapter(s) of which ${qualifying.length} qualify`
    )
  }
  const adapterAddress = getAddress(qualifying[0]!.adapter)

  const marketsData = row.markets.map((market): VaultV2MarketData => {
    const rateAtTarget = advanceRateAtTarget(market)
    return {
      id: market.id,
      capId: market.capId,
      params: market.params,
      state: {
        totalSupplyAssets: market.totalSupplyAssets,
        totalBorrowAssets: market.totalBorrowAssets
      },
      cap: toCapState(market.cap),
      vaultAssets: market.vaultAssets,
      rateAtTarget,
      isAdaptiveCurve: isAdaptiveCurveMarket(market.params.irm, rateAtTarget, chainId),
      isIdle: isAddressEqual(market.params.collateralToken, zeroAddress)
    }
  })

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
 * Reads EVERY given VaultV2's full reallocation input — factory identity, the EOA's allocator bit, idle
 * balance, adapter set, and per-market Blue state, position, `rateAtTarget`, and all three cap
 * levels — in a single deployless `eth_call` pinned to `blockNumber`, so the snapshot is coherent
 * across markets and reproducible. The lens accrues each market onchain inside that call, so there
 * is no client-side accrual and no block-timestamp handling here.
 *
 * Throws {@link InvalidVaultError} on a non-VaultV2 address or an unsupported adapter shape (see
 * {@link toVaultV2Data}); a revert inside the lens propagates as-is. The tick catches per vault
 * either way.
 */
export const fetchVaults = async (
  client: Client<Transport<BatchLensTransportType>>,
  vaults: readonly Address[],
  { chainId, blockNumber, eoa }: { chainId: number; blockNumber: bigint; eoa: Address }
): Promise<Map<string, VaultV2Result>> => {
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
    vaults.map(vault => ({ vault, eoa })),
    blockNumber
  )

  // Converted PER ROW, inside its own try: `toVaultV2Data` rejects a non-VaultV2 address and an
  // unsupported adapter shape, and one such vault in the whitelist must not reject the batch for
  // every other vault. The error is carried rather than thrown so the tick can attribute it.
  const out = new Map<string, VaultV2Result>()
  for (const vault of vaults) {
    const row = rows.get(vault.toLowerCase())
    if (!row) continue
    const { data, error } = tryCatchSync(() => toVaultV2Data(vault, row, chainId))
    out.set(vault.toLowerCase(), error ? { error } : { data })
  }
  return out
}

/** One vault's outcome: either its converted snapshot, or why this vault alone is unusable. */
export type VaultV2Result =
  | { data: VaultV2Data; error?: undefined }
  | { data?: undefined; error: Error }

function tryCatchSync<T>(
  fn: () => T
): { data: T; error?: undefined } | { data?: undefined; error: Error } {
  try {
    return { data: fn() }
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }
}
