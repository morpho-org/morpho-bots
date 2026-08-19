/**
 * Reads the deployless reallocation lens against REAL chain state, exactly as the running bot does —
 * no anvil, no deploy: the viem-dlc `deployless` transport runs the lens inside one `eth_call`. Two
 * uses:
 *
 *   1. Operator sanity check — proves the whole read path works against production (the lens compiles,
 *      deploys deploylessly, the on-chain `accrueInterest` simulation doesn't revert, and the nested
 *      structs decode) and prints the decoded snapshot.
 *   2. Equivalence check — re-reads the SAME pinned block through the `fetchAccrualVault` path the
 *      lens replaced and diffs it field by field. The two accrue differently by construction (the
 *      lens accrues on-chain at the block's timestamp; the SDK accrues client-side to a timestamp we
 *      pass in), so both are pinned to the same block and the SDK side is accrued to that block's
 *      timestamp. Tiny rounding deltas in accrued totals are explainable; a structural mismatch —
 *      params, cap, owner/curator/isAllocator, market ordering, rateAtTarget — is a bug.
 *
 * Usage (needs an RPC for CHAIN_ID; no anvil required):
 *   RPC_URL=https://base-rpc.publicnode.com CHAIN_ID=8453 VAULT=0x… \
 *     pnpm --filter @morpho-org/vault-v1-reallocation run probe:lens
 */
import { getChainAddresses } from '@morpho-org/blue-sdk'
import { fetchAccrualVault, metaMorphoAbi } from '@morpho-org/blue-sdk-viem'
import { createDeploylessClient } from '@repo/bot-kit'
import { ensureError } from '@repo/utils'
import { getAddress } from 'viem'
import { getBlock, getBlockNumber, readContract } from 'viem/actions'
import { base, mainnet } from 'viem/chains'

import { fetchVaultData } from '../src/vault-data'

const CHAINS = { [mainnet.id]: mainnet, [base.id]: base }
// A few blocks back: a public RPC's archive window always covers the recent past, and pinning off the
// exact head avoids a reorg racing the two reads.
const HEAD_LAG = 8n

const required = (name: string): string => {
  const value = process.env[name]
  if (!value?.trim()) throw new Error(`Missing required env var: ${name}`)
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
  const row: Row = {
    field,
    lens: String(lens),
    sdk: String(sdk),
    match: same
  }
  if (!same && typeof lens === 'bigint' && typeof sdk === 'bigint') row.delta = String(lens - sdk)
  return row
}

async function main() {
  const rpcUrl = required('RPC_URL')
  const chainId = Number(process.env.CHAIN_ID?.trim() ?? base.id)
  const chain = CHAINS[chainId as keyof typeof CHAINS]
  if (!chain) throw new Error(`Unsupported CHAIN_ID ${chainId}`)
  const vault = getAddress(required('VAULT'))
  // Any address works — `isAllocator` is just another field to compare.
  const eoa = getAddress(process.env.EOA?.trim() ?? `0x${'11'.repeat(20)}`)

  const client = createDeploylessClient({ chain, rpcUrl, rpcUrlFallback: undefined })
  const blockNumber = (await getBlockNumber(client)) - HEAD_LAG
  const { morpho, adaptiveCurveIrm } = getChainAddresses(chainId)
  console.log(
    `[probe] chain ${chainId} · vault ${vault} · block ${blockNumber}\n` +
      `[probe] morpho ${morpho} · adaptiveCurveIrm ${adaptiveCurveIrm}`
  )

  // (1) The production read path: one deployless eth_call.
  const lensStart = Date.now()
  const lensData = await fetchVaultData(client, vault, { chainId, blockNumber, eoa })
  const lensMs = Date.now() - lensStart

  // (2) The path the lens replaced, pinned to the same block and accrued to its timestamp.
  const sdkStart = Date.now()
  const [block, accrualVault] = await Promise.all([
    getBlock(client, { blockNumber }),
    fetchAccrualVault(vault, client, { chainId, blockNumber })
  ])
  const accrued = accrualVault.accrueInterest(block.timestamp)
  const sdkMs = Date.now() - sdkStart

  console.log(
    `[probe] lens ${lensData.marketsData.length} markets in ${lensMs}ms (1 eth_call) · ` +
      `fetchAccrualVault in ${sdkMs}ms (fan-out)`
  )

  // `fetchAccrualVault` never read the allocator bit — folding it into the lens is the point — so it
  // is checked against a direct standalone read instead.
  const directIsAllocator = await readContract(client, {
    address: vault,
    abi: metaMorphoAbi,
    functionName: 'isAllocator',
    args: [eoa],
    blockNumber
  })

  const rows: Row[] = [
    compare('owner', lensData.owner, accrued.owner),
    compare('curator', lensData.curator, accrued.curator),
    compare('isAllocator', lensData.isAllocator, directIsAllocator),
    compare('marketCount', BigInt(lensData.marketsData.length), BigInt(accrued.allocations.size))
  ]

  const sdkMarkets = [...accrued.allocations.values()]
  for (const [index, lensMarket] of lensData.marketsData.entries()) {
    const allocation = sdkMarkets[index]
    if (!allocation) {
      rows.push(compare(`market[${index}]`, lensMarket.id, '<missing>'))
      continue
    }
    const market = allocation.position.market
    const at = (field: string) => `market[${index}].${field}`
    rows.push(
      compare(at('id'), lensMarket.id, market.id),
      compare(at('params.loanToken'), lensMarket.params.loanToken, market.params.loanToken),
      compare(
        at('params.collateralToken'),
        lensMarket.params.collateralToken,
        market.params.collateralToken
      ),
      compare(at('params.oracle'), lensMarket.params.oracle, market.params.oracle),
      compare(at('params.irm'), lensMarket.params.irm, market.params.irm),
      compare(at('params.lltv'), lensMarket.params.lltv, market.params.lltv),
      compare(
        at('state.totalSupplyAssets'),
        lensMarket.state.totalSupplyAssets,
        market.totalSupplyAssets
      ),
      compare(
        at('state.totalBorrowAssets'),
        lensMarket.state.totalBorrowAssets,
        market.totalBorrowAssets
      ),
      compare(at('cap'), lensMarket.cap, allocation.config.cap),
      compare(at('vaultAssets'), lensMarket.vaultAssets, allocation.position.supplyAssets),
      compare(at('rateAtTarget'), lensMarket.rateAtTarget, market.rateAtTarget ?? 0n),
      compare(at('isIdle'), lensMarket.isIdle, market.isIdle)
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
    `[probe] roles: owner=${lensData.owner} curator=${lensData.curator} ` +
      `isAllocator(${eoa})=${lensData.isAllocator}`
  )
  console.log(`[probe] nonAdaptiveCurveMarketIds: ${lensData.nonAdaptiveCurveMarketIds.length}`)
  if (mismatches.length > 0) process.exitCode = 1
}

main().catch(error => {
  console.error(`[probe] failed: ${ensureError(error).message}`)
  process.exitCode = 1
})
