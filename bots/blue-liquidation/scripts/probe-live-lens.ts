/**
 * Reads the deployless lens against REAL Base state, exactly as the running bot does — no anvil, no
 * deploy: the viem-dlc `deployless` transport runs the lens inside one `eth_call`. Two uses:
 *
 *   1. Operator sanity check — proves the whole read path works against production (the lens compiles,
 *      deploys deploylessly, the IRM accrual sim + oracle reads don't revert, and the structs decode)
 *      and prints a health breakdown across a sample of real borrowers.
 *   2. Fork-fixture finder — if any sampled position is currently liquidatable, it prints the
 *      `ForkFixture` you can paste into `test/fork/liquidation.test.ts` to run the end-to-end suite.
 *
 * Usage (needs a Base RPC; no anvil required):
 *   RPC_URL=https://… bun run bots/blue-liquidation/scripts/probe-live-lens.ts
 */
import type { Address, Hex } from 'viem'

import { createDeploylessClient } from '@repo/bot-kit'
import { MorphoAbi } from '@repo/contracts'
import { ensureError } from '@repo/utils'
import { getAbiItem } from 'viem'
import { getBlockNumber, getLogs, readContract } from 'viem/actions'
import { base } from 'viem/chains'

import type { MarketParams } from '../src/market'
import type { LensInput, LensOut } from '../src/state/lens.sol'

import { marketId } from '../src/market'
import { isLiquidatable } from '../src/runner/eligibility'
import { plan } from '../src/sizing/plan'
import { lensKey, readBlueLiquidationLens } from '../src/state/lens.sol'

const MORPHO: Address = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb'
const LOGS_CHUNK = 4_000n
const LOGS_MAX_CHUNKS = 12
const TARGET_PAIRS = 256

function required(name: string): string {
  const value = Bun.env[name]
  if (!value?.trim()) throw new Error(`Missing required env var: ${name}`)
  return value.trim()
}

async function main() {
  const rpcUrl = required('RPC_URL')
  const baseClient = createDeploylessClient({ chain: base, rpcUrl, rpcUrlFallback: undefined })

  const borrowEvent = getAbiItem({ abi: MorphoAbi, name: 'Borrow' })
  const head = await getBlockNumber(baseClient)

  // Discover real (marketParams, borrower) pairs from recent Borrow logs (idToMarketParams → params).
  const pairs: LensInput[] = []
  const seen = new Set<string>()
  const paramsCache = new Map<Hex, MarketParams>()
  for (let chunk = 0; chunk < LOGS_MAX_CHUNKS && pairs.length < TARGET_PAIRS; chunk++) {
    const toBlock = head - LOGS_CHUNK * BigInt(chunk)
    const fromBlock = toBlock - LOGS_CHUNK + 1n
    const logs = await getLogs(baseClient, {
      address: MORPHO,
      event: borrowEvent,
      fromBlock,
      toBlock
    })
    for (const log of logs) {
      const id = log.args.id
      const borrower = log.args.onBehalf
      if (!id || !borrower) continue
      const key = `${id.toLowerCase()}:${borrower.toLowerCase()}`
      if (seen.has(key)) continue
      seen.add(key)
      let params = paramsCache.get(id)
      if (!params) {
        params = (await readContract(baseClient, {
          address: MORPHO,
          abi: MorphoAbi,
          functionName: 'idToMarketParams',
          args: [id]
        })) as MarketParams
        paramsCache.set(id, params)
      }
      pairs.push({ params, borrower })
      if (pairs.length >= TARGET_PAIRS) break
    }
  }
  console.log(`[probe] discovered ${pairs.length} distinct (market, borrower) pairs`)

  // Read the lens fresh for the whole batch — the exact production read path.
  const out = await readBlueLiquidationLens(baseClient, MORPHO, pairs)

  let valid = 0
  let hasDebt = 0
  let healthy = 0
  const liquidatable: { pair: LensInput; row: LensOut }[] = []
  for (const pair of pairs) {
    const row = out.get(lensKey(marketId(pair.params), pair.borrower))
    if (!row) continue
    if (row.valid) valid++
    if (row.hasDebt) hasDebt++
    if (row.valid && row.hasDebt && row.healthy) healthy++
    if (isLiquidatable(row)) liquidatable.push({ pair, row })
  }
  console.log(
    `[probe] returned ${out.size}/${pairs.length} · valid ${valid} · hasDebt ${hasDebt} · ` +
      `healthy(with debt) ${healthy} · liquidatable ${liquidatable.length}`
  )

  // Show one decoded sample so the accrual/oracle/decode path is eyeballable against real state.
  const sample = [...out.values()].find(r => r.valid && r.hasDebt)
  if (sample) {
    console.log('[probe] sample decoded row (valid + hasDebt):', {
      healthy: sample.healthy,
      borrowShares: sample.borrowShares,
      collateral: sample.collateral,
      accruedTotalBorrowAssets: sample.accruedTotalBorrowAssets,
      collateralPrice: sample.collateralPrice,
      lltv: sample.lltv
    })
  }

  if (liquidatable.length === 0) {
    console.log(
      '[probe] no live-liquidatable position in this sample — expected for a healthy market.'
    )
    console.log('[probe] the fork suite (test/fork/) stays skipped until a FIXTURE is supplied.')
    return
  }

  const { pair, row } = liquidatable[0]!
  const seizePlan = plan({
    hasDebt: row.hasDebt,
    healthy: row.healthy,
    borrowShares: row.borrowShares,
    collateral: row.collateral,
    accruedTotalBorrowAssets: row.accruedTotalBorrowAssets,
    totalBorrowShares: row.totalBorrowShares,
    collateralPrice: row.collateralPrice,
    lltv: row.lltv
  })
  console.log('[probe] LIQUIDATABLE — paste into test/fork/liquidation.test.ts FIXTURE:')
  console.log(
    JSON.stringify(
      {
        forkBlock: `${head} (pin at or just below)`,
        marketParams: pair.params,
        borrower: pair.borrower,
        poolFee: '<the collateral→loan Uniswap-V3 fee tier, e.g. 500/3000>',
        plannedSeizedAssets: seizePlan?.seizedAssets ?? null
      },
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
      2
    )
  )
}

main().catch(error => {
  console.error(`[probe] failed: ${ensureError(error).message}`)
  process.exitCode = 1
})
