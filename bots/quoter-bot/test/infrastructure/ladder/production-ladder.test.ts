import type { Address, Hex } from 'viem'

import { describe, expect, test } from 'vitest'

import type { LadderQuoteSet } from '../../../src/domain/ladder/ladder'

import { ConfigService } from '../../../src/config/config.service'
import { LadderAdapterError } from '../../../src/infrastructure/ladder/ladder-adapter.error'
import { MidnightLadderMakeService } from '../../../src/infrastructure/ladder/ladder-make.service'
import {
  calculateProductionLadderCapacities,
  cleanupRemovedLadderGroups,
  createProductionLadderAdapters,
  createRepeatableSingleFlight,
  ownBootstrapBuyTickCeiling,
  publishLadderPublication
} from '../../../src/infrastructure/ladder/production-ladder'

const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const foreignMaker: Address = '0x1111111111111111111111111111111111111111'
const midnight: Address = '0x2222222222222222222222222222222222222222'
const loanToken: Address = '0x3333333333333333333333333333333333333333'
const ratifier: Address = '0x4444444444444444444444444444444444444444'
const marketId: Hex = `0x${'55'.repeat(32)}`
const referenceMarketId: Hex = `0x${'66'.repeat(32)}`
const groupId: Hex = `0x${'77'.repeat(32)}`
const approvalHash: Hex = `0x${'88'.repeat(32)}`
const publicationHash: Hex = `0x${'99'.repeat(32)}`
const quote: LadderQuoteSet = {
  marketId,
  centerRateBps: 500n,
  groupMode: 'shared-rung',
  lower: [{ index: 0, rateBps: 450n, assets: 10n }],
  higher: [{ index: 0, rateBps: 550n, assets: 10n }]
}

const environment = {
  CHAIN_ID: '8453',
  RPC_URL: 'https://rpc.example',
  REFERENCE_RPC_URL: 'https://archive.example',
  MAKER_ADDRESS: maker,
  MIDNIGHT_ADDRESS: midnight,
  LOAN_ASSET_ADDRESS: loanToken,
  RATIFIER_ADDRESS: ratifier,
  MARKET_IDS: marketId,
  REFERENCE_MARKET_ID: referenceMarketId,
  NATIVE_RESERVE_WEI: '10',
  MAXIMUM_LEND_EXPOSURE_ASSETS: '100',
  MORPHO_API_BASE_URL: 'https://api.example',
  ROUTER_API_BASE_URL: 'https://router.example'
}

describe('calculateProductionLadderCapacities', () => {
  test('suppresses lower-rate credit sales when no conservative cost basis is available', () => {
    expect(
      calculateProductionLadderCapacities({
        marketId,
        balance: 100n,
        currentCredit: 90n,
        otherMarketCredit: 0n,
        targetMarketExposureAssets: 100n,
        maximumTotalExposureAssets: 1_000n,
        reservations: []
      })
    ).toEqual({
      lowerRateCapacityAssets: 0n,
      higherRateCapacityAssets: 10n,
      targetMarketCapacityAssets: 10n,
      maximumTotalCapacityAssets: 910n
    })
  })
})

describe('ownBootstrapBuyTickCeiling', () => {
  test('selects the highest durably marked bootstrap-buy tick of the quoted market', () => {
    expect(
      ownBootstrapBuyTickCeiling(
        [
          { marketId, buy: true, tick: 90n, overlapOwner: 'bootstrap-buy' },
          { marketId, buy: true, tick: 95n, overlapOwner: 'bootstrap-buy' },
          { marketId, buy: true, tick: 120n },
          { marketId: referenceMarketId, buy: true, tick: 130n, overlapOwner: 'bootstrap-buy' },
          { marketId, buy: false, tick: 140n, overlapOwner: 'ladder-sell' }
        ],
        marketId
      )
    ).toBe(95n)
  })

  test('reports no ceiling without a marked own bootstrap buy', () => {
    expect(
      ownBootstrapBuyTickCeiling([{ marketId, buy: true, tick: 120n }], marketId)
    ).toBeUndefined()
  })
})

describe('createRepeatableSingleFlight', () => {
  test('deduplicates concurrent cleanup but reruns after each settled attempt', async () => {
    let runs = 0
    let release: (() => void) | undefined
    const operation = createRepeatableSingleFlight(
      () =>
        new Promise<void>(resolve => {
          runs++
          release = resolve
        })
    )

    const first = operation()
    const concurrent = operation()
    expect(runs).toBe(1)
    release?.()
    await Promise.all([first, concurrent])

    const next = operation()
    expect(runs).toBe(2)
    release?.()
    await next
  })
})

describe('cleanupRemovedLadderGroups', () => {
  test('returns indexed removed groups that readiness must treat as canceled tombstones', async () => {
    const tombstones = await cleanupRemovedLadderGroups({
      removed: new Map([[groupId, 10n]]),
      indexedGroupIds: new Set([groupId]),
      readGroupConsumed: async () => 0n,
      invalidate: async () => {},
      forgetGroups: async () => {}
    })

    expect(tombstones).toEqual([groupId])
  })

  test('keeps a successfully canceled unindexed group as a temporary tombstone', async () => {
    const forgotten: Hex[] = []
    const tombstones = await cleanupRemovedLadderGroups({
      removed: new Map([[groupId, 10n]]),
      indexedGroupIds: new Set(),
      readGroupConsumed: async () => 0n,
      invalidate: async () => {},
      forgetGroups: async groupIds => {
        forgotten.push(...groupIds)
      }
    })

    expect(tombstones).toEqual([groupId])
    expect(forgotten).toEqual([])
  })

  test('returns an indexed tombstone when a removed group fills while cancellation confirms', async () => {
    const events: string[] = []
    let consumedReads = 0

    const tombstones = await cleanupRemovedLadderGroups({
      removed: new Map([[groupId, 10n]]),
      indexedGroupIds: new Set([groupId]),
      readGroupConsumed: async () => {
        consumedReads++
        return consumedReads === 1 ? 9n : 10n
      },
      invalidate: async () => {
        events.push('invalidate')
        throw new LadderAdapterError('transaction-reverted')
      },
      forgetGroups: async groupIds => {
        events.push(`forget:${groupIds.join(',')}`)
      }
    })

    expect(events).toEqual(['invalidate'])
    expect(tombstones).toEqual([groupId])
    expect(consumedReads).toBe(2)
  })
})

describe('createProductionLadderAdapters', () => {
  test('selects the configured hardcoded ladder target independently from bootstrap', async () => {
    const config = ConfigService.from(
      {
        ...environment,
        LADDER_MARKETS: JSON.stringify([
          {
            marketId,
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '475' },
            quotePremiumBps: '0',
            spreadBps: '200',
            stepBps: '100',
            rungCount: '1',
            sizeSkewBps: '0',
            lowerRateBudgetAssets: '10',
            higherRateBudgetAssets: '10',
            targetMarketExposureAssets: '20',
            maximumTotalExposureAssets: '20',
            minimumOfferAssets: '1',
            groupMode: 'shared-rung',
            loopIntervalSeconds: '60',
            movementToleranceBps: '10',
            minimumRateBps: '200',
            maximumRateBps: '800'
          }
        ])
      },
      { readOnly: true }
    )

    const adapters = await createProductionLadderAdapters(config)

    expect(await adapters.rates.readRate(marketId)).toBe(475n)
  })

  test('constructs read-only ports without loading a private key or starting provider reads', async () => {
    const config = ConfigService.from(environment, { readOnly: true })

    const adapters = await createProductionLadderAdapters(config)

    expect(Object.hasOwn(adapters.positions, 'readMarket')).toBe(true)
    expect(Object.hasOwn(adapters.rates, 'readRate')).toBe(true)
    expect(Object.hasOwn(adapters.make, 'readActive')).toBe(true)
  })

  test('rejects a write configuration whose key does not control the maker', async () => {
    const config = ConfigService.from({
      ...environment,
      MAKER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      MAKER_ADDRESS: foreignMaker
    })

    const error = await (async () => {
      try {
        await createProductionLadderAdapters(config)
      } catch (value) {
        return value
      }
      return undefined
    })()

    expect(error).toBeInstanceOf(LadderAdapterError)
    expect((error as LadderAdapterError).operation).toBe('maker-private-key-mismatch')
  })
})

describe('publishLadderPublication', () => {
  test('retains the durable Setter reservation when publication receipt confirmation times out', async () => {
    const retained = new Set<Hex>()
    const service = new MidnightLadderMakeService({
      readActive: async () => undefined,
      listOwnedGroups: async () => [],
      readGroupConsumed: async () => 0n,
      listActiveGroupIds: async () => [],
      listBookOffers: async () => [],
      preparePublication: async () => ({
        groupIds: [groupId],
        groups: [{ groupId, side: 'lower', rungIndexes: [0] }],
        prospective: [],
        publish: () =>
          publishLadderPublication({
            approve: async () => ({ operation: 'ratify', txHash: approvalHash }),
            validate: async () => {},
            sendPublication: async () => ({ operation: 'publish', txHash: publicationHash }),
            confirmPublication: async () => {
              throw new Error('receipt timeout')
            }
          })
      }),
      reservePublication: async publication => {
        for (const group of publication.groups) retained.add(group.groupId)
      },
      confirmPublication: async () => {},
      releasePublication: async groupIds => {
        for (const id of groupIds) retained.delete(id)
      },
      invalidate: async () => {},
      invalidateBatch: async () => {},
      forgetGroups: async () => {}
    })

    await expect(
      service.reconcile({ marketId, desired: quote, reason: 'recenter' })
    ).rejects.toMatchObject({
      operation: 'publication-after-ratification',
      confirmedTransactions: [{ operation: 'ratify', txHash: approvalHash }]
    })
    expect([...retained]).toEqual([groupId])
  })

  test('retains the durable Setter reservation when publication submission fails', async () => {
    const retained = new Set<Hex>()
    const service = new MidnightLadderMakeService({
      readActive: async () => undefined,
      listOwnedGroups: async () => [],
      readGroupConsumed: async () => 0n,
      listActiveGroupIds: async () => [],
      listBookOffers: async () => [],
      preparePublication: async () => ({
        groupIds: [groupId],
        groups: [{ groupId, side: 'lower', rungIndexes: [0] }],
        prospective: [],
        publish: () =>
          publishLadderPublication({
            approve: async () => ({ operation: 'ratify', txHash: approvalHash }),
            validate: async () => {},
            sendPublication: async () => {
              throw new Error('send failed')
            },
            confirmPublication: async () => {}
          })
      }),
      reservePublication: async publication => {
        for (const group of publication.groups) retained.add(group.groupId)
      },
      confirmPublication: async () => {},
      releasePublication: async groupIds => {
        for (const id of groupIds) retained.delete(id)
      },
      invalidate: async () => {},
      invalidateBatch: async () => {},
      forgetGroups: async () => {}
    })

    await expect(
      service.reconcile({ marketId, desired: quote, reason: 'recenter' })
    ).rejects.toMatchObject({
      operation: 'publication-after-ratification',
      confirmedTransactions: [{ operation: 'ratify', txHash: approvalHash }]
    })
    expect([...retained]).toEqual([groupId])
  })
})
