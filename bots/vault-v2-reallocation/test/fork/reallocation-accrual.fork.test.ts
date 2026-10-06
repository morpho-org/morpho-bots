import type { Abi, Address, Hex } from 'viem'

import { getChainAddresses } from '@morpho-org/blue-sdk'
import { createDeploylessClient } from '@repo/bot-kit'
import { advanceRateAtTarget } from '@repo/utils'
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseUnits,
  toHex
} from 'viem'
import { call, getStorageAt } from 'viem/actions'
import { base } from 'viem/chains'
import { describe, expect, it } from 'vitest'

import { VaultV2ReallocationLens } from '../../src/state/lens.sol'
import { VaultV2AccrualReferenceLens } from './reference-lens.sol'

// THE funds-at-risk gate for the read-only accrual rewrite, mirroring the v1 suite. The production
// lens no longer calls `Morpho.accrueInterest`; it projects the same arithmetic read-only so the
// deployless envelope's STATICCALL dispatch can reach it. This asserts the projection is EXACT by
// running both lenses at one pinned block and diffing every field reallocation sizing consumes.
//
// The fixture is pinned rather than taken from the environment, so CI runs this gate with the
// `RPC_URL_8453` secret it already sets and nothing more. Gauntlet USDC Prime (V2) on Base: ~$165M,
// and exactly one MorphoMarketV1 adapter, which is the only shape this bot supports.

const VAULT = getAddress('0x050cE30b927Da55177A4914EC73480238BAD56f0')
const FORK_BLOCK = 51_600_000n

const RPC_URL = process.env.RPC_URL_8453?.trim()
const EOA = getAddress(`0x${'11'.repeat(20)}`)

// Morpho's `mapping(Id => Market) public market` is storage slot 3; the struct packs `lastUpdate`
// (low 128) and `fee` (high 128) into its third word.
const MORPHO_MARKET_SLOT = 3n
const FORCED_FEE = parseUnits('0.25', 18)

const describeFork = RPC_URL ? describe : describe.skip

function marketFeeSlot(id: Hex): Hex {
  const base = BigInt(
    keccak256(
      encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, MORPHO_MARKET_SLOT])
    )
  )
  return toHex(base + 2n, { size: 32 })
}

describeFork('vault-v2 read-only accrual equals onchain accrual', () => {
  it('matches the reference lens on every sizing field', async () => {
    const { projected, reference } = await readBoth()

    expect(reference.markets.length).toBeGreaterThan(0)
    expect(projected.markets).toHaveLength(reference.markets.length)
    expect(projected.totalAssets).toBe(reference.totalAssets)
    expect(projected.idleAssets).toBe(reference.idleAssets)

    let accrued = 0
    reference.markets.forEach((want, i) => {
      const got = projected.markets[i]
      expect(got?.totalSupplyAssets, `market ${i} totalSupplyAssets`).toBe(want.totalSupplyAssets)
      expect(got?.totalSupplyShares, `market ${i} totalSupplyShares`).toBe(want.totalSupplyShares)
      expect(got?.totalBorrowAssets, `market ${i} totalBorrowAssets`).toBe(want.totalBorrowAssets)
      expect(got?.vaultAssets, `market ${i} vaultAssets`).toBe(want.vaultAssets)
      // The one value that moved offchain. The reference's `rateAtTarget` is what Blue's own
      // `borrowRate` advanced it to, so this checks `advanceRateAtTarget` against the chain rather
      // than against itself — without it the client-side advance is the only unverified step left.
      expect(got ? advanceRateAtTarget(got) : undefined, `market ${i} rateAtTarget`).toBe(
        want.rateAtTarget
      )
      if (want.elapsed > 0n && want.totalBorrowAssets > 0n) accrued += 1
    })
    // Guards the guard: with nothing accruing, every field matches trivially and this proves nothing.
    expect(accrued, 'fixture must include an accruing market').toBeGreaterThan(0)
  })

  it('dilutes totalSupplyShares exactly as Blue does, under a forced market fee', async () => {
    // Blue's per-market `fee` is 0 on every live Base market, so the diff above never reaches the
    // fee-share branch — the arithmetic with no other implementation in this repo. Forcing a fee by
    // state override closes that; the reference still has Blue itself mint the shares.
    const plain = await readBoth()
    const ids = plain.reference.markets.map(m => m.id)
    expect(ids.length).toBeGreaterThan(0)

    const { morpho } = getChainAddresses(base.id)
    const client = makeClient()
    const stateDiff = await Promise.all(
      ids.map(async id => {
        const slot = marketFeeSlot(id)
        const current = await getStorageAt(client, {
          address: morpho,
          slot,
          blockNumber: FORK_BLOCK
        })
        const lastUpdate = BigInt(current ?? '0x0') & ((1n << 128n) - 1n)
        return { slot, value: toHex((FORCED_FEE << 128n) | lastUpdate, { size: 32 }) }
      })
    )

    const { projected, reference } = await readBoth([{ address: morpho, stateDiff }])

    let diluted = 0
    reference.markets.forEach((want, i) => {
      const got = projected.markets[i]
      expect(got?.totalSupplyShares, `market ${i} totalSupplyShares`).toBe(want.totalSupplyShares)
      expect(got?.totalSupplyAssets, `market ${i} totalSupplyAssets`).toBe(want.totalSupplyAssets)
      expect(got?.vaultAssets, `market ${i} vaultAssets`).toBe(want.vaultAssets)
      // Shares actually higher than the unmodified read is the only proof the override landed. An
      // endpoint that silently ignored it would take the fee == 0 path in BOTH lenses and match
      // trivially, leaving the branch this whole case exists for unexecuted.
      const before = plain.reference.markets[i]
      if (before && want.totalSupplyShares > before.totalSupplyShares) diluted += 1
    })
    expect(diluted, 'fee override must actually mint fee shares').toBeGreaterThan(0)
  })
})

type Row = {
  totalAssets: bigint
  idleAssets: bigint
  markets: readonly {
    id: Hex
    totalSupplyAssets: bigint
    totalSupplyShares: bigint
    totalBorrowAssets: bigint
    vaultAssets: bigint
    elapsed: bigint
    /** Present on the production lens; the reference reports the post-accrual `rateAtTarget`. */
    rateAtTargetStored: bigint
    utilizationBefore: bigint
    rateAtTarget: bigint
  }[]
}

function makeClient() {
  return createDeploylessClient({
    chain: base,
    rpcUrl: RPC_URL as string,
    rpcUrlFallback: undefined
  })
}

function lensArgs() {
  const a = getChainAddresses(base.id)
  const { vaultV2Factory, morphoMarketV1AdapterFactory, morphoMarketV1AdapterV2Factory } = a
  if (!vaultV2Factory || !morphoMarketV1AdapterFactory || !morphoMarketV1AdapterV2Factory) {
    throw new Error('chain is missing a VaultV2 factory address')
  }
  return [
    a.morpho,
    a.adaptiveCurveIrm,
    vaultV2Factory,
    morphoMarketV1AdapterFactory,
    morphoMarketV1AdapterV2Factory
  ] as const
}

async function readBoth(stateOverride?: Parameters<typeof call>[1]['stateOverride']) {
  const client = makeClient()
  const args = lensArgs()
  const [projected, reference] = await Promise.all([
    readLensViaCall(client, VaultV2ReallocationLens.with(...args), 'item', stateOverride),
    readLensViaCall(client, VaultV2AccrualReferenceLens.with(...args), 'array', stateOverride)
  ])
  return { projected, reference }
}

/** Reads either lens through low-level `call`, so a `nonpayable` reference and an override both work. */
async function readLensViaCall(
  client: Parameters<typeof call>[0],
  compiled: { abi: Abi; address: Address; factory: Address; factoryData: Hex },
  shape: 'item' | 'array',
  stateOverride: Parameters<typeof call>[1]['stateOverride']
): Promise<Row> {
  const { abi } = compiled
  const input = { vault: VAULT, eoa: EOA }
  const { data } = await call(client, {
    to: compiled.address,
    factory: compiled.factory,
    factoryData: compiled.factoryData,
    blockNumber: FORK_BLOCK,
    stateOverride,
    data: encodeFunctionData({
      abi,
      functionName: 'lens',
      args: shape === 'item' ? [input] : [[input]]
    })
  })
  if (!data) throw new Error('lens returned no data')
  const decoded = decodeFunctionResult({ abi, functionName: 'lens', data })
  const row = (shape === 'item' ? decoded : (decoded as readonly unknown[])[0]) as Row | undefined
  if (!row) throw new Error('lens returned no row')
  return row
}
