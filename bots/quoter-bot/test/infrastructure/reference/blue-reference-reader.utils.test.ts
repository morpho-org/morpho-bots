import { Market, MarketParams } from '@morpho-org/morpho-sdk/entities'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { BASE_CHAIN_ID } from '../../../src/config/supported-chains.utils'
import { createBlueReferenceReader } from '../../../src/infrastructure/reference/blue-reference-reader.utils'
import { ReferenceAdapterError } from '../../../src/infrastructure/reference/reference-adapter.error'

const fetchMarket = vi.hoisted(() => vi.fn())

vi.mock('@morpho-org/morpho-sdk/fetch', () => ({ fetchMarket }))

const marketId = '0x1111111111111111111111111111111111111111111111111111111111111111'
const WAD = 10n ** 18n
const SHARES_PER_ASSET = 10n ** 6n
/** The SDK rejects accrual before a market's `lastUpdate`, so block timestamps must follow it. */
const LAST_UPDATE = 1_700_000_000n

/** Zero-address IRM keeps `accrueInterest` deterministic, isolating the share-value assertions. */
const params = new MarketParams({
  loanToken: '0x2222222222222222222222222222222222222222',
  collateralToken: '0x3333333333333333333333333333333333333333',
  oracle: '0x4444444444444444444444444444444444444444',
  irm: '0x0000000000000000000000000000000000000000',
  lltv: 860_000_000_000_000_000n
})

const market = (overrides: Partial<ConstructorParameters<typeof Market>[0]> = {}) =>
  new Market({
    params,
    totalSupplyAssets: 0n,
    totalSupplyShares: 0n,
    totalBorrowAssets: 0n,
    totalBorrowShares: 0n,
    lastUpdate: 0n,
    fee: 0n,
    ...overrides
  })

const funded = (totalSupplyAssets: bigint) =>
  market({
    totalSupplyAssets,
    totalSupplyShares: 1_000_000_000n * SHARES_PER_ASSET,
    lastUpdate: LAST_UPDATE
  })

const head = { blockNumber: 1_000n, timestamp: LAST_UPDATE + 2_000n }

const client = (latest: bigint, timestampOf: (blockNumber: bigint) => bigint) => ({
  getBlock: async (parameters: { blockTag: 'latest' } | { blockNumber: bigint }) =>
    'blockTag' in parameters
      ? { number: latest, timestamp: timestampOf(latest) }
      : { number: parameters.blockNumber, timestamp: timestampOf(parameters.blockNumber) }
})

beforeEach(() => {
  fetchMarket.mockReset()
})

describe('createBlueReferenceReader', () => {
  test('prices zeroed state identically to a funded market that has not accrued', () => {
    // The hazard the guard exists for, asserted against the SDK rather than a restatement of its
    // share math: Blue's virtual assets/shares make a market that does not exist at a historical
    // block indistinguishable from one holding supply at par.
    expect(market().toSupplyAssets(WAD)).toBe(funded(1_000_000_000n).toSupplyAssets(WAD))
  })

  test('rejects a historical checkpoint whose block predates the reference market', async () => {
    fetchMarket.mockResolvedValue(market())
    const reader = createBlueReferenceReader(
      marketId,
      client(1_000n, block => block) as never,
      BASE_CHAIN_ID
    )

    const error: unknown = await reader
      .readAtOrBefore(500n, { blockNumber: 1_000n, timestamp: 1_000n })
      .catch(value => value)

    expect(error).toBeInstanceOf(ReferenceAdapterError)
    expect(error).toMatchObject({ operation: 'reference-uninitialized' })
  })

  test('rejects a market that exists but holds no supply shares', async () => {
    fetchMarket.mockResolvedValue(market({ lastUpdate: LAST_UPDATE }))
    const reader = createBlueReferenceReader(
      marketId,
      client(1_000n, block => block) as never,
      BASE_CHAIN_ID
    )

    await expect(reader.readLatest()).rejects.toMatchObject({
      operation: 'reference-uninitialized'
    })
  })

  test('accrues a funded market at its block timestamp and prices one WAD of shares', async () => {
    const accruing = funded(1_002_000_000n)
    const accrueInterest = vi.spyOn(accruing, 'accrueInterest')
    fetchMarket.mockResolvedValue(accruing)
    const reader = createBlueReferenceReader(
      marketId,
      client(1_000n, block => LAST_UPDATE + block * 2n) as never,
      BASE_CHAIN_ID
    )

    expect(await reader.readLatest()).toMatchObject({
      blockNumber: 1_000n,
      timestamp: LAST_UPDATE + 2_000n,
      supplyAssetsPerWadShares: accruing.toSupplyAssets(WAD)
    })
    expect(accrueInterest).toHaveBeenCalledWith(LAST_UPDATE + 2_000n)
    expect(fetchMarket).toHaveBeenCalledWith(marketId, expect.anything(), {
      blockNumber: 1_000n,
      deployless: false
    })
  })

  test('locates the block at or before the requested timestamp', async () => {
    fetchMarket.mockResolvedValue(funded(1_000_000_000n))
    const reader = createBlueReferenceReader(
      marketId,
      client(1_000n, block => LAST_UPDATE + block * 2n) as never,
      BASE_CHAIN_ID
    )

    // Blocks are two seconds apart, so a target one second past block 500 resolves back to it.
    expect(await reader.readAtOrBefore(LAST_UPDATE + 1_001n, head)).toMatchObject({
      blockNumber: 500n
    })
    expect(await reader.readAtOrBefore(LAST_UPDATE + 1_000n, head)).toMatchObject({
      blockNumber: 500n
    })
    expect(fetchMarket).toHaveBeenLastCalledWith(marketId, expect.anything(), {
      blockNumber: 500n,
      deployless: false
    })
  })

  test('searches from the given head without reading a newer latest block', async () => {
    fetchMarket.mockResolvedValue(funded(1_000_000_000n))
    const readers = client(2_000n, block => LAST_UPDATE + block * 2n)
    const getBlock = vi.spyOn(readers, 'getBlock')
    const reader = createBlueReferenceReader(marketId, readers as never, BASE_CHAIN_ID)

    expect(await reader.readAtOrBefore(LAST_UPDATE + 3_000n, head)).toMatchObject({
      blockNumber: 1_000n
    })
    expect(getBlock).not.toHaveBeenCalledWith({ blockTag: 'latest' })
  })

  test('rejects a target older than the chain instead of reading genesis state', async () => {
    fetchMarket.mockResolvedValue(funded(1_000_000_000n))
    const reader = createBlueReferenceReader(
      marketId,
      client(1_000n, block => LAST_UPDATE + block * 2n) as never,
      BASE_CHAIN_ID
    )

    await expect(reader.readAtOrBefore(LAST_UPDATE - 1n, head)).rejects.toMatchObject({
      operation: 'reference-history'
    })
    expect(fetchMarket).not.toHaveBeenCalled()
  })

  test('rejects a provider whose latest block carries no number', async () => {
    const reader = createBlueReferenceReader(
      marketId,
      { getBlock: async () => ({ number: null, timestamp: 0n }) } as never,
      BASE_CHAIN_ID
    )

    await expect(reader.readLatest()).rejects.toMatchObject({ operation: 'latest-block' })
  })
})
