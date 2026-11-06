import type { Address, Hex } from 'viem'

import { describe, expect, test, vi } from 'vitest'

import type { WorldOwnership, WorldValue } from '../../../src/application/engine/world'

import { bootstrapReading } from '../../../src/application/engine/bootstrap-state'
import { exposureSnapshot } from '../../../src/application/engine/exposure'
import { ladderReading } from '../../../src/application/engine/ladder-state'
import { derive } from '../../../src/application/engine/world'
import { ConfigService } from '../../../src/config/config.service'
import { BootstrapAdapterError, LadderAdapterError } from '../../../src/errors'
import { readWorld } from '../../../src/infrastructure/engine/quoter-sources'
import { createWorldReads } from '../../../src/infrastructure/engine/world-reads'

type Market = {
  maturity: bigint
  tickSpacing: number
  continuousFee: number
  lossFactor: bigint
  collateralParams?: { token: Address; lltv: bigint }[]
}
type Chain = {
  timestamp: bigint
  markets: Record<Hex, Market>
  positions: Record<Hex, { credit: bigint; debt: bigint; collateral?: bigint[] }>
  cash: bigint
  allowance: bigint
  consumed: Record<string, bigint>
  groups: unknown[]
  books: Record<Hex, { asks: unknown[]; bids: unknown[] } | 'malformed'>
}
let chain: Chain
/** The block every chain read asked for, by read. */
let pinned: { read: string; block: unknown }[] = []

const HEAD = 100n
const HEAD_HASH: Hex = `0x${'aa'.repeat(32)}`
const PINNED = { blockHash: HEAD_HASH, requireCanonical: true }

const midnightReader = {
  getPositionData: async (request: { marketId: Hex; parameters: { blockTag?: unknown } }) => {
    pinned.push({ read: 'position', block: request.parameters.blockTag })
    const market = chain.markets[request.marketId]!
    return {
      market: {
        params: {
          maturity: market.maturity,
          loanToken: environment.LOAN_ASSET_ADDRESS,
          collateralParams: market.collateralParams ?? []
        },
        tickSpacing: market.tickSpacing,
        continuousFee: market.continuousFee,
        lossFactor: market.lossFactor
      },
      accrueInterest: () => chain.positions[request.marketId]!
    }
  }
}

const fakeClient = {
  getBlock: async (request: { blockTag?: unknown }) => {
    pinned.push({ read: 'block', block: request.blockTag })
    return { number: HEAD, hash: HEAD_HASH, timestamp: chain.timestamp }
  },
  readContract: async (request: {
    functionName: string
    args: readonly unknown[]
    blockTag?: unknown
  }) => {
    pinned.push({ read: request.functionName, block: request.blockTag })
    if (request.functionName === 'balanceOf') return chain.cash
    if (request.functionName === 'allowance') return chain.allowance
    throw new Error(`unexpected read ${request.functionName}`)
  },
  multicall: async (request: {
    contracts: readonly { args: readonly unknown[] }[]
    blockTag?: unknown
  }) => {
    pinned.push({ read: 'consumed', block: request.blockTag })
    return request.contracts.map(contract => chain.consumed[contract.args[1] as string] ?? 0n)
  },
  extend: () => fakeClient,
  morpho: { midnight: () => midnightReader }
}

vi.mock('viem', async importOriginal => ({
  ...(await importOriginal<typeof import('viem')>()),
  createPublicClient: () => fakeClient
}))
vi.mock('@morpho-org/morpho-sdk', async importOriginal => ({
  ...(await importOriginal<typeof import('@morpho-org/morpho-sdk')>()),
  morphoViemExtension: () => 'extension'
}))
vi.mock('../../../src/infrastructure/provider/http-json.utils', () => ({
  requestJson: async (url: string) => {
    if (url.includes('/offer-groups?')) return { data: chain.groups, cursor: null }
    const match = /books\/(0x[0-9a-f]{64})\/(asks|bids)\//.exec(url)
    if (match) {
      const book = chain.books[match[1] as Hex]
      if (book === 'malformed') return { data: 'malformed' }
      return { data: book?.[match[2] as 'asks' | 'bids'] ?? [] }
    }
    throw new Error(`unexpected request ${url}`)
  }
}))

const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const thirdParty: Address = '0x00000000000000000000000000000000000000AA'
const ratifier: Address = '0x800B5F12A61B8198a5a6EfD794Cac6699B294d63'
const marketId: Hex = `0x${'55'.repeat(32)}`
const otherMarketId: Hex = `0x${'66'.repeat(32)}`
const ladderLow: Hex = `0x${'a1'.repeat(32)}`
const ladderHigh: Hex = `0x${'a2'.repeat(32)}`
const v0Group: Hex = `0x${'b1'.repeat(32)}`
const foreignBuy: Hex = `0x${'c1'.repeat(32)}`
const pendingGroup: Hex = `0x${'d1'.repeat(32)}`
const intentless: Hex = `0x${'e1'.repeat(32)}`
const timestamp = 1_700_000_000n
const maturity = timestamp + 30n * 86_400n

const environment = {
  CHAIN_ID: '8453',
  RPC_URL: 'https://rpc.example',
  REFERENCE_RPC_URL: 'https://archive.example',
  MAKER_ADDRESS: maker,
  MIDNIGHT_ADDRESS: '0x2222222222222222222222222222222222222222',
  LOAN_ASSET_ADDRESS: '0x3333333333333333333333333333333333333333',
  RATIFIER_ADDRESS: ratifier,
  MARKET_IDS: `${marketId},${otherMarketId}`,
  REFERENCE_MARKET_ID: `0x${'77'.repeat(32)}`,
  V0_OFFER_GROUP_IDS: v0Group,
  NATIVE_RESERVE_WEI: '10',
  MAX_FEE_GWEI: '100',
  MAX_TRANSACTION_SPEND_WEI: '100000000000000000',
  MAX_CONTINUOUS_FEE_CAP: '0',
  KERNEL_ENROLLMENT: 'enrolling',
  MAX_PUBLICATION_GAS: '5000000',
  MAX_PUBLICATION_DATA_BYTES: '65536',
  MAX_CANCELLATION_GAS: '100000',
  MAX_BATCH_CANCELLATION_GAS: '1000000',
  MAX_BATCH_CANCELLATION_DATA_BYTES: '65536',
  MAX_RATIFICATION_GAS: '100000',
  MORPHO_API_BASE_URL: 'https://api.example',
  ROUTER_API_BASE_URL: 'https://router.example',
  LADDER_MARKETS: JSON.stringify([
    {
      marketId,
      quotePremiumBps: '0',
      spreadBps: '200',
      stepBps: '100',
      rungCount: '2',
      sizeSkewBps: '0',
      lowerRateBudgetAssets: '1000',
      higherRateBudgetAssets: '1000',
      targetMarketExposureAssets: '5000',
      maximumTotalExposureAssets: '8000',
      minimumOfferAssets: '1',
      groupMode: 'shared-rung',
      loopIntervalSeconds: '60',
      movementToleranceBps: '10',
      minimumRateBps: '100',
      maximumRateBps: '2000'
    }
  ]),
  BOOTSTRAP_MARKETS: JSON.stringify([
    {
      marketId,
      creditTarget: '3000',
      acceptanceAssets: '0',
      offerSize: '100',
      premiumBps: '0',
      maximumMarketExposure: '6000',
      maximumTotalExposure: '9000',
      minimumRateBps: '300',
      maximumRateBps: '2000',
      autoRefill: false
    }
  ])
}

const rawOffer = (buy: boolean, tick: number, market: Hex = marketId) => ({
  maker,
  buy,
  tick,
  market_id: market,
  continuous_fee_cap: '0',
  market: { maturity: Number(maturity) }
})
const rawGroup = (
  id: Hex,
  consumed: bigint,
  maxUnits: bigint,
  offers: unknown[],
  maxAssets = 0n
) => ({
  chain_id: 8453,
  id,
  consumed: String(consumed),
  max_assets: String(maxAssets),
  max_units: String(maxUnits),
  offers
})
const bookRow = (buy: boolean, tick: number, group: Hex, owner: Address, units: bigint) => ({
  market_id: marketId,
  units: String(units),
  offer: { tick, buy, group, maker: owner, ratifier }
})

/** Ladder groups resting at 438 and 722 bps, a configured V0 bootstrap buy at 926 bps. */
const healthyChain = (): Chain => ({
  timestamp,
  markets: {
    [marketId]: { maturity, tickSpacing: 4, continuousFee: 0, lossFactor: 0n },
    [otherMarketId]: {
      maturity: maturity + 1_000n,
      tickSpacing: 4,
      continuousFee: 0,
      lossFactor: 0n
    }
  },
  positions: {
    [marketId]: { credit: 1_200n, debt: 0n },
    [otherMarketId]: { credit: 300n, debt: 0n }
  },
  cash: 4_000n,
  allowance: 3_500n,
  consumed: { [ladderLow]: 1n, [ladderHigh]: 0n, [v0Group]: 20n, [foreignBuy]: 5n },
  groups: [
    rawGroup(ladderLow, 1n, 400n, [rawOffer(false, 4500)]),
    rawGroup(ladderHigh, 0n, 400n, [rawOffer(true, 4400)]),
    rawGroup(v0Group, 20n, 100n, [rawOffer(true, 4350)]),
    rawGroup(foreignBuy, 5n, 50n, [rawOffer(true, 4300, otherMarketId)])
  ],
  books: {
    [marketId]: {
      asks: [
        bookRow(false, 4500, ladderLow, maker, 399n),
        bookRow(false, 4550, `0x${'f1'.repeat(32)}`, thirdParty, 500n)
      ],
      bids: [
        bookRow(true, 4400, ladderHigh, maker, 400n),
        bookRow(true, 4350, v0Group, maker, 80n),
        bookRow(true, 4200, `0x${'f2'.repeat(32)}`, thirdParty, 500n)
      ]
    }
  }
})

/** What the maker holds: this run's reserved ladder publication, and per setup a pending intent. */
const ownershipFor = (config: ConfigService, setup?: string): WorldOwnership => ({
  ladderPublications: [
    {
      marketId,
      status: 'reserved',
      quote: {
        marketId,
        centerRateBps: 500n,
        referenceObservationId: 'hour:1',
        groupMode: 'shared-rung',
        lower: [{ index: 0, rateBps: 400n, assets: 400n }],
        higher: [{ index: 0, rateBps: 600n, assets: 400n }]
      },
      groups: [
        { groupId: ladderLow, side: 'lower', rungIndexes: [0], ticks: [4500n] },
        { groupId: ladderHigh, side: 'higher', rungIndexes: [0], ticks: [4400n] }
      ]
    }
  ],
  bootstrapGroupIds: [
    ...config.v0OfferGroupIds,
    ...(setup === 'pending' ? [pendingGroup] : []),
    ...(setup === 'intentless' ? [intentless] : [])
  ],
  bootstrapOffers:
    setup === 'pending'
      ? [
          {
            groupId: pendingGroup,
            marketId,
            assets: 90n,
            rateBps: 450n,
            referenceObservationId: 'hour:2',
            tick: 4400n
          }
        ]
      : [],
  heldBuyGroups: [],
  retiredGroupIds: []
})
/** Polls the world once through the production reads and derives both strategies' readings. */
const derived = async (
  change: (chain: Chain) => void = () => {},
  setup?: string,
  borrowing = false
) => {
  chain = healthyChain()
  change(chain)
  pinned = []
  const config = ConfigService.from(
    borrowing
      ? {
          ...environment,
          LADDER_MARKETS: JSON.stringify(
            (JSON.parse(environment.LADDER_MARKETS) as Record<string, unknown>[]).map(item => ({
              ...item,
              debt: { maximumDebtUnits: '800', stopBorrowingBeforeMaturitySeconds: '0' }
            }))
          )
        }
      : environment,
    { readOnly: true }
  )
  const accounting = {
    maker: config.identity.maker,
    marketIds: config.setup.marketIds,
    v0OfferGroupIds: config.v0OfferGroupIds
  }
  const write = await readWorld({
    at: { number: Number(HEAD), hash: HEAD_HASH, timestamp: chain.timestamp },
    readAt: 0,
    ownership: ownershipFor(config, setup),
    views: {},
    reads: createWorldReads(config),
    markets: [
      { strategy: 'ladder', marketId },
      { strategy: 'bootstrap', marketId }
    ],
    accounting,
    expiry: 60_000
  })
  if (write.coverage !== 'complete') throw new TypeError('the world read failed')
  const worlds = Object.fromEntries(
    Object.entries(write.entries).map(([key, value]: [string, WorldValue]) => [
      key,
      { ...value, block: Number(HEAD), timestamp: chain.timestamp }
    ])
  )
  const ladderWorld = worlds[`ladder:${marketId}`]!
  const bootstrapWorld = worlds[`bootstrap:${marketId}`]!
  return {
    ladder: ladderReading({
      world: ladderWorld,
      exposure: derive(() => exposureSnapshot(ladderWorld, accounting, LadderAdapterError)),
      config: config.ladder[0]!,
      accounting
    }),
    bootstrap: bootstrapReading({
      world: bootstrapWorld,
      exposure: derive(() => exposureSnapshot(bootstrapWorld, accounting, BootstrapAdapterError)),
      config: config.bootstrap[0]!,
      accounting,
      initialTargetCompleted: false
    }).position
  }
}

const healthyMarket = {
  lowerRateCapacityAssets: 1_200n,
  higherRateCapacityAssets: 3_375n,
  targetMarketCapacityAssets: 4_575n,
  maximumTotalCapacityAssets: 7_575n,
  cashBalanceAssets: 4_000n,
  creditAssets: 1_200n,
  otherMarketCreditAssets: 300n,
  reservedAssets: 125n,
  marketReservedAssets: 80n,
  bootstrapBuyRateBps: 926n,
  bookCrossing: {
    lower: { crossed: false, clearable: true },
    higher: { crossed: false, clearable: true }
  },
  maturityTimestamp: maturity,
  observedTimestamp: timestamp,
  minimumOfferUnits: 2n
}

const healthyPosition = {
  maturityTimestamp: maturity,
  observedTimestamp: timestamp,
  rateWindowEmpty: false,
  credit: 1_200n,
  debt: 0n,
  lossFactor: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true },
  cashBalance: 3_055n,
  marketExposure: 1_600n,
  totalExposure: 1_945n,
  activeOffer: {
    marketId,
    assets: 80n,
    rateBps: 926n,
    referenceObservationId: `group:${v0Group}`
  },
  requiresReconciliation: false
}

/**
 * Each fixture's expected readings are the ones the per-market readers this replaced produced for
 * the same chain and API state.
 */
describe('world derivations', () => {
  test('a healthy market reads every input at the world block', async () => {
    const { ladder, bootstrap } = await derived()

    expect(ladder).toEqual({
      strategy: 'ladder',
      marketId,
      block: 100,
      guard: { ok: true, value: { lossFactor: 0n, acceptedLossFactor: 0n, defaulted: true } },
      active: {
        ok: true,
        value: {
          quote: {
            marketId,
            centerRateBps: 500n,
            referenceObservationId: 'hour:1',
            groupMode: 'shared-rung',
            lower: [{ index: 0, rateBps: 400n, assets: 399n }],
            higher: [{ index: 0, rateBps: 600n, assets: 400n }]
          },
          consumption: [
            {
              groupId: ladderLow,
              marketId,
              side: 'lower',
              groupRateBps: 400n,
              maxUnits: 400n,
              consumed: 1n,
              remainingUnits: 399n
            },
            {
              groupId: ladderHigh,
              marketId,
              side: 'higher',
              groupRateBps: 600n,
              maxUnits: 400n,
              consumed: 0n,
              remainingUnits: 400n
            }
          ]
        }
      },
      market: { ok: true, value: healthyMarket }
    })
    expect(bootstrap).toEqual({ ok: true, value: healthyPosition })
    expect(pinned.length).toBeGreaterThan(0)
    for (const read of pinned) expect(read.block).toEqual(PINNED)
  })

  test('a lend-halted market reads only its guard, from the same block', async () => {
    const { ladder, bootstrap } = await derived(chain => {
      chain.markets[marketId]!.lossFactor = 5n
    })

    expect(ladder).toEqual({
      strategy: 'ladder',
      marketId,
      block: 100,
      guard: { ok: true, value: { lossFactor: 5n, acceptedLossFactor: 0n, defaulted: true } }
    })
    expect(bootstrap).toEqual({
      ok: true,
      value: {
        ...healthyPosition,
        lossFactor: { lossFactor: 5n, acceptedLossFactor: 0n, defaulted: true }
      }
    })
  })

  test('a capped market has no cash capacity left', async () => {
    const { ladder, bootstrap } = await derived(chain => {
      chain.positions[marketId]!.credit = 6_000n
      chain.cash = 10n
    })

    expect(ladder.market).toEqual({
      ok: true,
      value: {
        ...healthyMarket,
        lowerRateCapacityAssets: 6_000n,
        higherRateCapacityAssets: 0n,
        targetMarketCapacityAssets: 6_000n,
        cashBalanceAssets: 10n,
        creditAssets: 6_000n
      }
    })
    expect(bootstrap).toEqual({
      ok: true,
      value: {
        ...healthyPosition,
        credit: 6_000n,
        cashBalance: 0n,
        marketExposure: 6_400n,
        totalExposure: 6_745n
      }
    })
  })

  test('a third-party bid through the resting sells crosses the lower side', async () => {
    const { ladder } = await derived(chain => {
      const book = chain.books[marketId] as { asks: unknown[]; bids: unknown[] }
      book.bids.push(bookRow(true, 4520, `0x${'f3'.repeat(32)}`, thirdParty, 900n))
    })

    expect(ladder.market).toEqual({
      ok: true,
      value: {
        ...healthyMarket,
        bookCrossing: {
          lower: { crossed: true, clearable: true },
          higher: { crossed: false, clearable: true }
        }
      }
    })
  })

  test('a third-party bid through own sells the API has not indexed crosses the lower side', async () => {
    const { ladder } = await derived(chain => {
      chain.groups = chain.groups.filter(group => (group as { id: Hex }).id !== ladderLow)
      const book = chain.books[marketId] as { asks: unknown[]; bids: unknown[] }
      book.asks = book.asks.filter(
        row => (row as { offer: { group: Hex } }).offer.group !== ladderLow
      )
      book.bids.push(bookRow(true, 4520, `0x${'f3'.repeat(32)}`, thirdParty, 900n))
    })

    expect(ladder.market).toMatchObject({
      ok: true,
      value: {
        bookCrossing: {
          lower: { crossed: true, clearable: true },
          higher: { crossed: false, clearable: true }
        }
      }
    })
  })

  test('a third-party bid through an own sell the chain shows filled crosses nothing', async () => {
    const { ladder } = await derived(chain => {
      chain.groups = chain.groups.filter(group => (group as { id: Hex }).id !== ladderLow)
      chain.consumed[ladderLow] = 400n
      const book = chain.books[marketId] as { asks: unknown[]; bids: unknown[] }
      book.asks = book.asks.filter(
        row => (row as { offer: { group: Hex } }).offer.group !== ladderLow
      )
      book.bids.push(bookRow(true, 4520, `0x${'f3'.repeat(32)}`, thirdParty, 900n))
    })

    expect(ladder.market).toMatchObject({
      ok: true,
      value: {
        bookCrossing: {
          lower: { crossed: false, clearable: true },
          higher: { crossed: false, clearable: true }
        }
      }
    })
  })

  test('an own indexed buy the takeable book omits bounds clearing, as preparation reads it', async () => {
    const { ladder } = await derived(chain => {
      chain.groups.push(rawGroup(`0x${'c3'.repeat(32)}`, 0n, 10n, [rawOffer(true, 4900)]))
      const book = chain.books[marketId] as { asks: unknown[]; bids: unknown[] }
      book.bids.push(bookRow(true, 4520, `0x${'f3'.repeat(32)}`, thirdParty, 900n))
    })

    expect(ladder.market).toMatchObject({
      ok: true,
      value: {
        bookCrossing: {
          lower: { crossed: true, clearable: false },
          higher: { crossed: false, clearable: true }
        }
      }
    })
  })

  test('a malformed book is no observation, not a failed market', async () => {
    const { ladder } = await derived(chain => {
      chain.books[marketId] = 'malformed'
    })

    const { bookCrossing: _, ...withoutCrossing } = healthyMarket
    expect(ladder.market).toEqual({ ok: true, value: withoutCrossing })
  })

  test('a pending bootstrap offer is reserved at its remaining size and bounds the ladder', async () => {
    const { ladder, bootstrap } = await derived(chain => {
      chain.consumed[pendingGroup] = 3n
    }, 'pending')

    expect(ladder.market).toEqual({
      ok: true,
      value: {
        ...healthyMarket,
        higherRateCapacityAssets: 3_288n,
        targetMarketCapacityAssets: 4_488n,
        maximumTotalCapacityAssets: 7_488n,
        reservedAssets: 212n,
        marketReservedAssets: 167n,
        bootstrapBuyRateBps: 450n
      }
    })
    expect(bootstrap).toEqual({
      ok: true,
      value: {
        ...healthyPosition,
        cashBalance: 2_968n,
        marketExposure: 1_687n,
        totalExposure: 2_032n,
        requiresReconciliation: true
      }
    })
  })

  test('a matured market reports its maturity and nothing it cannot price', async () => {
    const { ladder, bootstrap } = await derived(chain => {
      chain.timestamp = maturity + 10n
    })

    const {
      bookCrossing: _crossing,
      bootstrapBuyRateBps: _rate,
      minimumOfferUnits: _units,
      ...priceless
    } = healthyMarket
    expect(ladder.market).toEqual({
      ok: true,
      value: { ...priceless, observedTimestamp: maturity + 10n }
    })
    expect(bootstrap).toEqual({
      ok: true,
      value: {
        ...healthyPosition,
        observedTimestamp: maturity + 10n,
        activeOffer: { ...healthyPosition.activeOffer, rateBps: 0n }
      }
    })
  })

  test('an unindexed, uncancelled owned group without an intent fails both markets closed', async () => {
    const { ladder, bootstrap } = await derived(chain => {
      chain.consumed[intentless] = 0n
    }, 'intentless')

    expect(ladder.market).toEqual({
      ok: false,
      errorName: 'LadderAdapterError',
      adapterOperation: 'missing-owned-group-intent'
    })
    expect(bootstrap).toEqual({
      ok: false,
      errorName: 'BootstrapAdapterError',
      adapterOperation: 'missing-owned-group-intent'
    })
  })

  test('a live cash-capped buy fails both markets closed', async () => {
    const { ladder, bootstrap } = await derived(chain => {
      chain.groups.push(rawGroup(`0x${'c2'.repeat(32)}`, 0n, 0n, [rawOffer(true, 4250)], 70n))
    })

    expect(ladder.market).toEqual({
      ok: false,
      errorName: 'LadderAdapterError',
      adapterOperation: 'cash-capped-buy-group'
    })
    expect(bootstrap).toEqual({
      ok: false,
      errorName: 'BootstrapAdapterError',
      adapterOperation: 'cash-capped-buy-group'
    })
  })
})

test('projects the loan-token collateral slot from the same SDK position and pinned world block', async () => {
  const { ladder } = await derived(
    chain => {
      chain.markets[marketId]!.collateralParams = [
        { token: '0x1111111111111111111111111111111111111111', lltv: 500_000_000_000_000_000n },
        { token: environment.LOAN_ASSET_ADDRESS as Address, lltv: 900_000_000_000_000_000n }
      ]
      chain.positions[marketId] = { credit: 1_200n, debt: 100n, collateral: [99_999n, 700n] }
    },
    undefined,
    true
  )
  expect(ladder.market).toMatchObject({
    ok: true,
    value: { lowerRateCapacityAssets: 530n, debtAssets: 100n, debtCeilingAssets: 630n }
  })
  expect(pinned.filter(read => read.read === 'position').map(read => read.block)).toEqual([
    PINNED,
    PINNED
  ])
})

test('fails the world position closed when a listed collateral slot has no balance in the SDK reading', async () => {
  const { ladder } = await derived(
    chain => {
      chain.markets[marketId]!.collateralParams = [
        { token: environment.LOAN_ASSET_ADDRESS as Address, lltv: 1_000_000_000_000_000_000n }
      ]
      chain.positions[marketId] = { credit: 1_200n, debt: 100n, collateral: [] }
    },
    undefined,
    true
  )
  expect(ladder.market).toEqual({
    ok: false,
    errorName: 'LadderAdapterError',
    adapterOperation: 'position-unavailable'
  })
})
