import type { Address } from 'viem'
import type { Abi, Hex } from 'viem'

import { getChainAddresses } from '@morpho-org/blue-sdk'
import { createDeploylessClient, createLogger, withLogging } from '@repo/bot-kit'
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
import { describe, expect, it, vi } from 'vitest'

import { readVaultV1Lens, VaultV1ReallocationLens } from '../../src/state/lens.sol'
import { VaultV1AccrualReferenceLens } from './reference-lens.sol'

// THE funds-at-risk gate for the read-only accrual rewrite.
//
// The production lens no longer calls `Morpho.accrueInterest`; it projects the same arithmetic
// read-only so the deployless envelope's STATICCALL dispatch can reach it. This asserts the
// projection is EXACT by running both lenses at one pinned block and diffing every field the
// reallocation sizing consumes. The reference lens does the accrual onchain, so it is an
// independent oracle — it shares no code with the projection, and deliberately does not use the
// vendored math.
//
// The fixture is pinned rather than taken from the environment, so CI runs this gate with the
// `RPC_URL_8453` secret it already sets for the midnight fork suite and nothing more. A fixture
// behind an unset variable is a gate that silently never runs.
//
// Gauntlet USDC Prime on Base: listed, ~$400M, an 8-market withdraw queue spanning several IRMs —
// verified onchain at this block. It is not Blue's fee recipient, so the fail-closed path is not
// what is under test here.

const VAULT = getAddress('0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61')
const FORK_BLOCK = 51_600_000n

const RPC_URL = process.env.RPC_URL_8453?.trim()

const EOA = getAddress(`0x${'11'.repeat(20)}`)

const describeFork = RPC_URL ? describe : describe.skip

describeFork('vault-v1 read-only accrual equals onchain accrual', () => {
  it('matches the reference lens on every sizing field', async () => {
    const rpcUrl = RPC_URL as string
    const vault = VAULT
    const blockNumber = FORK_BLOCK

    const client = createDeploylessClient({ chain: base, rpcUrl, rpcUrlFallback: undefined })
    const { morpho, adaptiveCurveIrm } = getChainAddresses(base.id)

    const projected = (
      await readVaultV1Lens(
        client,
        { morpho, adaptiveCurveIrm },
        [{ vault, eoa: EOA }],
        blockNumber
      )
    ).get(vault.toLowerCase())

    // The reference is `nonpayable`, so viem's `readContract` rejects it at the type level and the
    // envelope could never carry it. A plain deployless `call` has no `policy` sentinel, so
    // viem-dlc forwards it unchanged and Blue's own accrual runs inside the `eth_call`.
    const reference = await readReferenceLens(
      client,
      { morpho, adaptiveCurveIrm },
      vault,
      blockNumber
    )

    expect(projected).toBeDefined()
    expect(reference.markets.length).toBeGreaterThan(0)
    expect(projected?.markets).toHaveLength(reference.markets.length)

    expect(projected?.owner).toBe(reference.owner)
    expect(projected?.curator).toBe(reference.curator)
    expect(projected?.isAllocator).toBe(reference.isAllocator)

    let accruedMarkets = 0
    reference.markets.forEach((want, i) => {
      const got = projected?.markets[i]
      expect(got, `market ${i}`).toBeDefined()
      expect(got?.id, `market ${i} id`).toBe(want.id)
      // Every field reallocation sizing reads. `totalSupplyShares` is what fee dilution moves, and
      // `vaultAssets` is derived from both totals — a wrong fee share shows up here first.
      expect(got?.totalSupplyAssets, `market ${i} totalSupplyAssets`).toBe(want.totalSupplyAssets)
      expect(got?.totalSupplyShares, `market ${i} totalSupplyShares`).toBe(want.totalSupplyShares)
      expect(got?.totalBorrowAssets, `market ${i} totalBorrowAssets`).toBe(want.totalBorrowAssets)
      expect(got?.vaultAssets, `market ${i} vaultAssets`).toBe(want.vaultAssets)
      expect(got?.cap, `market ${i} cap`).toBe(want.cap)
      // The one value that moved offchain. The reference's `rateAtTarget` is what Blue's own
      // `borrowRate` advanced it to, so this checks `advanceRateAtTarget` against the chain rather
      // than against itself — without it the client-side advance is the only unverified step left.
      expect(got ? advanceRateAtTarget(got) : undefined, `market ${i} rateAtTarget`).toBe(
        want.rateAtTarget
      )
      if (want.elapsed > 0n && want.totalBorrowAssets > 0n) accruedMarkets += 1
    })

    // Guards the guard: if nothing had actually accrued at this block, every field above would
    // match trivially and the test would pass while proving nothing.
    expect(accruedMarkets, 'fixture must include an accruing market').toBeGreaterThan(0)
  })
})

async function readReferenceLens(
  client: Parameters<typeof call>[0],
  addresses: { morpho: Address; adaptiveCurveIrm: Address },
  vault: Address,
  blockNumber: bigint
) {
  const compiled = VaultV1AccrualReferenceLens.with(addresses.morpho, addresses.adaptiveCurveIrm)
  const { data } = await call(client, {
    to: compiled.address,
    factory: compiled.factory,
    factoryData: compiled.factoryData,
    blockNumber,
    data: encodeFunctionData({
      abi: compiled.abi,
      functionName: 'lens',
      args: [[{ vault, eoa: EOA }]]
    })
  })
  if (!data) throw new Error('reference lens returned no data')
  const [row] = decodeFunctionResult({ abi: compiled.abi, functionName: 'lens', data })
  if (!row) throw new Error('reference lens returned no row')

  return {
    owner: row.owner,
    curator: row.curator,
    isAllocator: row.isAllocator,
    markets: row.markets
  }
}

// Blue's per-market `fee` is 0 on every live Base market today, so the diff above never reaches the
// fee-share branch — the arithmetic most easily got wrong, and the one with no other implementation
// in this repo. Forcing a fee by state override closes that: both lenses see the same overridden
// state, and the reference still has Blue itself mint the shares.
//
// Layout: Morpho's `mapping(Id => Market) public market` is storage slot 3; the struct packs
// `lastUpdate` (low 128) and `fee` (high 128) into its third word.
const MORPHO_MARKET_SLOT = 3n
const FORCED_FEE = parseUnits('0.25', 18) // 25%, within Blue's MAX_FEE of 25%

function marketFeeSlot(id: Hex): Hex {
  const base = BigInt(
    keccak256(
      encodeAbiParameters([{ type: 'bytes32' }, { type: 'uint256' }], [id, MORPHO_MARKET_SLOT])
    )
  )
  return toHex(base + 2n, { size: 32 })
}

describeFork('vault-v1 lens observability', () => {
  it('emits one viem-dlc wide event per request, labelled with the lens', async () => {
    const logger = createLogger('info', { env: {}, context: { bot: 'vault-v1-reallocation' } })
    const client = createDeploylessClient({
      chain: base,
      rpcUrl: RPC_URL as string,
      rpcUrlFallback: undefined
    })
    const { morpho, adaptiveCurveIrm } = getChainAddresses(base.id)

    const lines: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation(line => lines.push(String(line)))
    try {
      await withLogging(
        () =>
          readVaultV1Lens(
            client,
            { morpho, adaptiveCurveIrm },
            [{ vault: VAULT, eoa: EOA }],
            FORK_BLOCK
          ),
        { logger: logger.layer, lens: 'vault-v1-reallocation' }
      )
    } finally {
      spy.mockRestore()
    }

    const concluded = lines.map(l => JSON.parse(l)).filter(e => e.event === 'concluded')
    expect(concluded.length).toBeGreaterThan(0)
    const event = concluded[0]
    // `lens` is ours; `library` viem-dlc stamps itself and a caller cannot override it.
    expect(event.lens).toBe('vault-v1-reallocation')
    expect(event.library).toBe('viem-dlc')
    expect(event.status).toBe('ok')
    expect(typeof event.duration_ms).toBe('number')
    expect(event.chain_id).toBe(base.id)
    // The deployless facet's batching fields are what the dashboard's gas and batching charts read.
    expect(Object.keys(event).some(k => k.startsWith('viem-dlc-deployless.'))).toBe(true)
  })
})

describeFork('vault-v1 read-only accrual under a non-zero market fee', () => {
  it('dilutes totalSupplyShares exactly as Blue does', async () => {
    const rpcUrl = RPC_URL as string
    const client = createDeploylessClient({ chain: base, rpcUrl, rpcUrlFallback: undefined })
    const { morpho, adaptiveCurveIrm } = getChainAddresses(base.id)
    const addresses = { morpho, adaptiveCurveIrm }

    // Take the queue from an unmodified read, then force a fee onto every market in it.
    const plain = await readReferenceLens(client, addresses, VAULT, FORK_BLOCK)
    const ids = plain.markets.map(m => m.id)
    expect(ids.length).toBeGreaterThan(0)

    const slots = await Promise.all(
      ids.map(async id => {
        const slot = marketFeeSlot(id)
        const current = await getStorageAt(client, {
          address: morpho,
          slot,
          blockNumber: FORK_BLOCK
        })
        // Keep lastUpdate (low 128) exactly as it is; only write the fee into the high 128.
        const lastUpdate = BigInt(current ?? '0x0') & ((1n << 128n) - 1n)
        return { slot, value: toHex((FORCED_FEE << 128n) | lastUpdate, { size: 32 }) }
      })
    )
    const stateOverride = [{ address: morpho, stateDiff: slots }]

    const [projected, reference] = await Promise.all([
      readLensViaCall(
        client,
        VaultV1ReallocationLens.with(morpho, adaptiveCurveIrm),
        'item',
        stateOverride
      ),
      readLensViaCall(
        client,
        VaultV1AccrualReferenceLens.with(morpho, adaptiveCurveIrm),
        'array',
        stateOverride
      )
    ])

    let dilutedMarkets = 0
    reference.markets.forEach((want, i) => {
      const got = projected.markets[i]
      expect(got?.totalSupplyShares, `market ${i} totalSupplyShares`).toBe(want.totalSupplyShares)
      expect(got?.totalSupplyAssets, `market ${i} totalSupplyAssets`).toBe(want.totalSupplyAssets)
      expect(got?.vaultAssets, `market ${i} vaultAssets`).toBe(want.vaultAssets)
      // Shares actually higher than the unmodified read is the only proof the override landed. An
      // endpoint that silently ignored it would take the fee == 0 path in BOTH lenses and match
      // trivially, leaving the branch this whole case exists for unexecuted.
      const base = plain.markets[i]
      if (base && want.totalSupplyShares > base.totalSupplyShares) dilutedMarkets += 1
    })
    expect(dilutedMarkets, 'fee override must actually mint fee shares').toBeGreaterThan(0)
  })
})

/** Reads either lens through low-level `call`, so a `nonpayable` reference and a state override both work. */
async function readLensViaCall(
  client: Parameters<typeof call>[0],
  compiled: { abi: Abi; address: Address; factory: Address; factoryData: Hex },
  shape: 'item' | 'array',
  stateOverride: Parameters<typeof call>[1]['stateOverride']
): Promise<{ markets: readonly ProjectedMarket[] }> {
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
  const row = (shape === 'item' ? decoded : (decoded as readonly unknown[])[0]) as
    | { markets: readonly ProjectedMarket[] }
    | undefined
  if (!row) throw new Error('lens returned no row')
  return row
}

/** The subset of MarketOut both lenses share — enough to diff the projection. */
type ProjectedMarket = {
  totalSupplyAssets: bigint
  totalSupplyShares: bigint
  totalBorrowAssets: bigint
  vaultAssets: bigint
  elapsed: bigint
}

describeFork("vault-v1 fails closed when the vault is Blue's fee recipient", () => {
  it('reverts rather than reporting a vaultAssets it cannot compute', async () => {
    // Blue credits the fee recipient's own POSITION with the fee shares this projection only mints
    // into the market total, so for that one vault `vaultAssets` would read low. There is no
    // equivalent-value assertion to make here — the guard is that the read fails.
    //
    // This also proves the `require`s in the lens are enforced at all, which nothing else does: the
    // happy-path gates only ever take the passing branch.
    const client = makeV1Client()
    const { morpho } = getChainAddresses(base.id)

    // Morpho's `feeRecipient` is storage slot 1.
    const stateOverride = [
      {
        address: morpho,
        stateDiff: [{ slot: toHex(1n, { size: 32 }), value: toHex(BigInt(VAULT), { size: 32 }) }]
      }
    ]

    await expect(
      readLensViaCall(
        client,
        VaultV1ReallocationLens.with(morpho, getChainAddresses(base.id).adaptiveCurveIrm),
        'item',
        stateOverride
      )
    ).rejects.toThrow()
  })
})

function makeV1Client() {
  return createDeploylessClient({
    chain: base,
    rpcUrl: RPC_URL as string,
    rpcUrlFallback: undefined
  })
}
