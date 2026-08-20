/**
 * Reads the deployless reallocation lens against REAL chain state, exactly as the running bot does —
 * no anvil, no deploy: the viem-dlc `deployless` transport runs the lens inside one `eth_call`. Two
 * uses:
 *
 *   1. Operator sanity check — proves the whole read path works against production (the lens compiles,
 *      deploys deploylessly, the on-chain `accrueInterest` simulation doesn't revert, and the nested
 *      structs decode) and prints the decoded snapshot.
 *   2. Equivalence check — re-reads the SAME pinned block through the `fetchAccrualVaultV2` + cap
 *      multicall path the lens replaced and diffs it field by field, pairing markets by id. The two
 *      accrue differently by construction (the lens accrues on-chain at the block's timestamp; the
 *      SDK accrues client-side to a timestamp we pass in), so both are pinned to the same block and
 *      the SDK side is accrued to that block's timestamp. Tiny rounding deltas in accrued totals are
 *      explainable; a structural mismatch — params, caps, cap ids, adapter, isAllocator, market set,
 *      rateAtTarget — is a bug.
 *
 * Usage (needs an RPC for CHAIN_ID; no anvil required):
 *   RPC_URL=https://base-rpc.publicnode.com CHAIN_ID=8453 VAULT=0x… \
 *     pnpm --filter @morpho-org/vault-v2-reallocation run probe:lens
 */
import type { MarketParams } from '@morpho-org/blue-sdk'
import type { Hex } from 'viem'

import {
  AccrualVaultV2MorphoMarketV1Adapter,
  AccrualVaultV2MorphoMarketV1AdapterV2,
  SharesMath,
  VaultV2MorphoMarketV1Adapter
} from '@morpho-org/blue-sdk'
import { fetchAccrualVaultV2, vaultV2Abi } from '@morpho-org/blue-sdk-viem'
import { createDeploylessClient } from '@repo/bot-kit'
import { ensureError } from '@repo/utils'
import { getAddress } from 'viem'
import { getBlock, getBlockNumber, multicall, readContract } from 'viem/actions'
import { base, mainnet } from 'viem/chains'

import { fetchVaultV2Data } from '../src/vault-data'
import { InvalidProbeConfigError } from './invalid-probe-config.error'

const CHAINS = { [mainnet.id]: mainnet, [base.id]: base }
// A few blocks back: a public RPC's archive window always covers the recent past, and pinning off the
// exact head avoids a reorg racing the two reads.
const HEAD_LAG = 8n

const required = (name: string): string => {
  const value = process.env[name]
  if (!value?.trim()) throw new InvalidProbeConfigError(`Missing required env var: ${name}`)
  return value.trim()
}

const bigintish = (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value

/** One reported field comparison. `delta` is set only for numeric mismatches. */
type Row = { field: string; lens: string; sdk: string; match: boolean; delta?: string }

const compare = (field: string, lens: unknown, sdk: unknown): Row => {
  const same =
    typeof lens === 'string' && typeof sdk === 'string' && lens.startsWith('0x')
      ? lens.toLowerCase() === sdk.toLowerCase()
      : lens === sdk
  const row: Row = { field, lens: String(lens), sdk: String(sdk), match: same }
  if (!same && typeof lens === 'bigint' && typeof sdk === 'bigint') row.delta = String(lens - sdk)
  return row
}

type SdkMarket = {
  id: Hex
  params: MarketParams
  totalSupplyAssets: bigint
  totalBorrowAssets: bigint
  vaultAssets: bigint
  rateAtTarget: bigint
  isIdle: boolean
}

type MarketAdapter = AccrualVaultV2MorphoMarketV1Adapter | AccrualVaultV2MorphoMarketV1AdapterV2

// The pre-lens normalization over both adapter generations, kept here as the reference the lens is
// diffed against (client-side accrual to the pinned block's timestamp).
const sdkMarkets = (adapter: MarketAdapter, timestamp: bigint): SdkMarket[] => {
  if (adapter instanceof AccrualVaultV2MorphoMarketV1Adapter) {
    return adapter.marketParamsList.map(params => {
      // The SDK constructs one position per params entry, so the lookup is total.
      const position = adapter.positions.find(candidate => candidate.marketId === params.id)!
      const accrued = position.accrueInterest(timestamp)
      return {
        id: params.id,
        params,
        totalSupplyAssets: accrued.market.totalSupplyAssets,
        totalBorrowAssets: accrued.market.totalBorrowAssets,
        vaultAssets: accrued.supplyAssets,
        rateAtTarget: accrued.market.rateAtTarget ?? 0n,
        isIdle: accrued.market.isIdle
      }
    })
  }
  return adapter.markets.map(market => {
    const accrued = market.accrueInterest(timestamp)
    return {
      id: accrued.id,
      params: accrued.params,
      totalSupplyAssets: accrued.totalSupplyAssets,
      totalBorrowAssets: accrued.totalBorrowAssets,
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

async function main() {
  const rpcUrl = required('RPC_URL')
  const chainId = Number(process.env.CHAIN_ID?.trim() ?? base.id)
  const chain = CHAINS[chainId as keyof typeof CHAINS]
  if (!chain) throw new InvalidProbeConfigError(`Unsupported CHAIN_ID ${chainId}`)
  const vault = getAddress(required('VAULT'))
  // Any address works — `isAllocator` is just another field to compare.
  const eoa = getAddress(process.env.EOA?.trim() ?? `0x${'11'.repeat(20)}`)

  const client = createDeploylessClient({ chain, rpcUrl, rpcUrlFallback: undefined })
  const blockNumber = (await getBlockNumber(client)) - HEAD_LAG
  console.log(`[probe] chain ${chainId} · vault ${vault} · block ${blockNumber}`)

  // (1) The production read path: one deployless eth_call.
  const lensStart = Date.now()
  const lensData = await fetchVaultV2Data(client, vault, { chainId, blockNumber, eoa })
  const lensMs = Date.now() - lensStart

  // (2) The path the lens replaced, pinned to the same block and accrued to its timestamp.
  const sdkStart = Date.now()
  const [block, vaultV2] = await Promise.all([
    getBlock(client, { blockNumber }),
    fetchAccrualVaultV2(vault, client, { chainId, blockNumber })
  ])
  const adapter = vaultV2.accrualAdapters.find(
    (candidate): candidate is MarketAdapter =>
      candidate instanceof AccrualVaultV2MorphoMarketV1Adapter ||
      candidate instanceof AccrualVaultV2MorphoMarketV1AdapterV2
  )
  if (!adapter) throw new InvalidProbeConfigError('SDK path found no Morpho Blue market adapter')
  const adapterAddress = getAddress(adapter.address)
  const markets = sdkMarkets(adapter, block.timestamp)

  const collateralTokens = [...new Set(markets.map(m => getAddress(m.params.collateralToken)))]
  const capIds = [
    VaultV2MorphoMarketV1Adapter.adapterId(adapterAddress),
    ...collateralTokens.map(token => VaultV2MorphoMarketV1Adapter.collateralId(token)),
    ...markets.map(m => VaultV2MorphoMarketV1Adapter.marketParamsId(adapterAddress, m.params))
  ]
  const capReads = await multicall(client, {
    allowFailure: false,
    blockNumber,
    contracts: capIds.flatMap(id =>
      (['absoluteCap', 'relativeCap', 'allocation'] as const).map(functionName => ({
        address: vault,
        abi: vaultV2Abi,
        functionName,
        args: [id] as const
      }))
    )
  })
  const capAt = (i: number) => ({
    absolute: capReads[i * 3] as bigint,
    relative: capReads[i * 3 + 1] as bigint,
    allocation: capReads[i * 3 + 2] as bigint
  })
  const sdkMs = Date.now() - sdkStart

  console.log(
    `[probe] lens ${lensData.marketsData.length} markets in ${lensMs}ms (1 eth_call) · ` +
      `fetchAccrualVaultV2 + cap multicall in ${sdkMs}ms (fan-out)`
  )

  // `fetchAccrualVaultV2` never read the allocator bit — folding it into the lens is the point — so
  // it is checked against a direct standalone read instead.
  const directIsAllocator = await readContract(client, {
    address: vault,
    abi: vaultV2Abi,
    functionName: 'isAllocator',
    args: [eoa],
    blockNumber
  })

  const rows: Row[] = [
    compare('adapterAddress', lensData.adapterAddress, adapterAddress),
    compare('isAllocator', lensData.isAllocator, directIsAllocator),
    compare(
      'totalAssets',
      lensData.totalAssets,
      vaultV2.accrueInterest(block.timestamp).vault._totalAssets
    ),
    compare('idleAssets', lensData.idleAssets, vaultV2.assetBalance),
    compare('marketCount', BigInt(lensData.marketsData.length), BigInt(markets.length))
  ]
  const sdkAdapterCap = capAt(0)
  rows.push(
    compare('adapterCap.absolute', lensData.adapterCap.absolute, sdkAdapterCap.absolute),
    compare('adapterCap.relative', lensData.adapterCap.relative, sdkAdapterCap.relative),
    compare('adapterCap.allocation', lensData.adapterCap.allocation, sdkAdapterCap.allocation)
  )
  for (const [index, token] of collateralTokens.entries()) {
    const lensCap = lensData.collateralCaps[token]
    const sdkCap = capAt(1 + index)
    const at = (field: string) => `collateralCap[${token}].${field}`
    rows.push(
      compare(at('absolute'), lensCap?.absolute, sdkCap.absolute),
      compare(at('relative'), lensCap?.relative, sdkCap.relative),
      compare(at('allocation'), lensCap?.allocation, sdkCap.allocation)
    )
  }

  // Pair by market id — enumeration order is an implementation detail of each path.
  const lensById = new Map(lensData.marketsData.map(market => [market.id.toLowerCase(), market]))
  for (const [index, sdk] of markets.entries()) {
    const lens = lensById.get(sdk.id.toLowerCase())
    const at = (field: string) => `market[${sdk.id}].${field}`
    if (!lens) {
      rows.push(compare(at('present'), '<missing>', sdk.id))
      continue
    }
    const sdkCap = capAt(1 + collateralTokens.length + index)
    rows.push(
      compare(
        at('capId'),
        lens.capId,
        VaultV2MorphoMarketV1Adapter.marketParamsId(adapterAddress, sdk.params)
      ),
      compare(at('params.loanToken'), lens.params.loanToken, sdk.params.loanToken),
      compare(
        at('params.collateralToken'),
        lens.params.collateralToken,
        sdk.params.collateralToken
      ),
      compare(at('params.oracle'), lens.params.oracle, sdk.params.oracle),
      compare(at('params.irm'), lens.params.irm, sdk.params.irm),
      compare(at('params.lltv'), lens.params.lltv, sdk.params.lltv),
      compare(at('state.totalSupplyAssets'), lens.state.totalSupplyAssets, sdk.totalSupplyAssets),
      compare(at('state.totalBorrowAssets'), lens.state.totalBorrowAssets, sdk.totalBorrowAssets),
      compare(at('cap.absolute'), lens.cap.absolute, sdkCap.absolute),
      compare(at('cap.relative'), lens.cap.relative, sdkCap.relative),
      compare(at('cap.allocation'), lens.cap.allocation, sdkCap.allocation),
      compare(at('vaultAssets'), lens.vaultAssets, sdk.vaultAssets),
      compare(at('rateAtTarget'), lens.rateAtTarget, sdk.rateAtTarget),
      compare(at('isIdle'), lens.isIdle, sdk.isIdle)
    )
  }

  const mismatches = rows.filter(row => !row.match)
  console.log(`\n[probe] compared ${rows.length} fields · ${mismatches.length} mismatch(es)`)
  if (mismatches.length > 0) {
    console.log('[probe] MISMATCHES:')
    for (const row of mismatches) {
      console.log(
        `  ${row.field}\n    lens = ${row.lens}\n    sdk  = ${row.sdk}` +
          (row.delta ? `\n    delta = ${row.delta}` : '')
      )
    }
  } else {
    console.log('[probe] EXACT MATCH on every compared field.')
  }

  console.log('\n[probe] lens snapshot (first market):')
  console.log(JSON.stringify(lensData.marketsData[0] ?? null, bigintish, 2))
  console.log(
    `[probe] totals: totalAssets=${lensData.totalAssets} idleAssets=${lensData.idleAssets} ` +
      `isAllocator(${eoa})=${lensData.isAllocator}`
  )
  console.log(`[probe] nonAdaptiveCurveMarketIds: ${lensData.nonAdaptiveCurveMarketIds.length}`)
  if (mismatches.length > 0) process.exitCode = 1
}

main().catch(error => {
  console.error(`[probe] failed: ${ensureError(error).message}`)
  process.exitCode = 1
})
