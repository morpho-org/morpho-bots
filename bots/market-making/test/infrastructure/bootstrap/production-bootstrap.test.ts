import type { Address, Hex } from 'viem'

import {
  MAX_OFFER_CAP,
  midnightAbi,
  Offer,
  Payload,
  SetterRatifierUtils,
  Tree,
  type IMarketParams,
  setterRatifierAbi
} from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFunctionData } from 'viem'

import { ConfigService } from '../../../src/config/config.service'
import { BootstrapAdapterError } from '../../../src/infrastructure/bootstrap/bootstrap-adapter.error'
import { bootstrapExposureMarketIds } from '../../../src/infrastructure/bootstrap/bootstrap-exposure.utils'
import { createBootstrapGroupOwnership } from '../../../src/infrastructure/bootstrap/bootstrap-group-ownership.utils'
import {
  bootstrapBookOffers,
  bootstrapReservedLoanAssets,
  readBootstrapGroups,
  strategyBootstrapGroups
} from '../../../src/infrastructure/bootstrap/bootstrap-groups.utils'
import { MidnightBootstrapMakeService } from '../../../src/infrastructure/bootstrap/bootstrap-make.service'
import {
  bootstrapContinuousFeeCap,
  createBootstrapOffer,
  legacyBootstrapOfferTickUpperBound,
  recoverLegacyBootstrapOfferTick
} from '../../../src/infrastructure/bootstrap/bootstrap-offer.utils'
import { prepareBootstrapRequirements } from '../../../src/infrastructure/bootstrap/bootstrap-requirements.utils'
import { assertBootstrapTransaction } from '../../../src/infrastructure/bootstrap/bootstrap-transaction.utils'
import {
  bootstrapMakeLendArguments,
  createProductionBootstrapAdapters,
  publishBootstrapPublication
} from '../../../src/infrastructure/bootstrap/production-bootstrap'
import { ReadOnlyBootstrapMakeService } from '../../../src/infrastructure/make/read-only-bootstrap-make.service'

const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const marketId: Hex = `0x${'ab'.repeat(32)}`
const secondMarketId: Hex = `0x${'12'.repeat(32)}`
const groupId: Hex = `0x${'cd'.repeat(32)}`
const collateral: Address = '0x1111111111111111111111111111111111111111'
const loanToken: Address = '0x2222222222222222222222222222222222222222'
const oracle: Address = '0x3333333333333333333333333333333333333333'
const ratifier: Address = '0x800B5F12A61B8198a5a6EfD794Cac6699B294d63'
const publicationMarket: IMarketParams = {
  chainId: 8453,
  midnight: maker,
  loanToken,
  collateralParams: [
    {
      token: collateral,
      lltv: 800_000_000_000_000_000n,
      liquidationCursor: 0n,
      oracle
    }
  ],
  maturity: 54_000n,
  rcfThreshold: 0n,
  enterGate: '0x0000000000000000000000000000000000000000',
  liquidatorGate: '0x0000000000000000000000000000000000000000'
}

const publicationOffer = (tick = 100n) =>
  Offer.create({
    market: publicationMarket,
    buy: true,
    maker,
    tick,
    expiry: 54_000n,
    ratifier,
    maxAssets: 100n
  })

const publicationPolicy = (offer: ReturnType<typeof publicationOffer>) => ({
  kind: 'publication' as const,
  target: maker,
  offer,
  ratifierType: 'setter' as const,
  chainId: 8453,
  root: Tree.create([offer]).root,
  maker
})

const group = (overrides: Record<string, unknown> = {}) => ({
  id: groupId,
  chain_id: 8453,
  consumed: '0',
  max_assets: '100',
  offers: [
    {
      market_id: marketId,
      maker,
      buy: true,
      tick: 100,
      continuous_fee_cap: '0',
      market: { maturity: 2_000 }
    }
  ],
  ...overrides
})

describe('createProductionBootstrapAdapters', () => {
  test('constructs address-only readers and selects the configured hardcoded bootstrap rate', async () => {
    const config = ConfigService.from(
      {
        CHAIN_ID: '8453',
        RPC_URL: 'https://rpc.example',
        REFERENCE_RPC_URL: 'https://archive.example',
        MAKER_ADDRESS: maker,
        MIDNIGHT_ADDRESS: maker,
        LOAN_ASSET_ADDRESS: loanToken,
        RATIFIER_ADDRESS: ratifier,
        MARKET_IDS: marketId,
        REFERENCE_MARKET_ID: secondMarketId,
        NATIVE_RESERVE_WEI: '10',
        MAXIMUM_LEND_EXPOSURE_ASSETS: '100',
        MORPHO_API_BASE_URL: 'https://api.example',
        ROUTER_API_BASE_URL: 'https://router.example',
        BOOTSTRAP_MARKETS: JSON.stringify([
          {
            marketId,
            creditTarget: '10',
            acceptanceAssets: '1',
            offerSize: '2',
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' },
            premiumBps: '0',
            maximumMarketExposure: '20',
            maximumTotalExposure: '20',
            minimumRateBps: '200',
            maximumRateBps: '800',
            autoRefill: false
          }
        ])
      },
      { readOnly: true }
    )

    const adapters = createProductionBootstrapAdapters(config)

    expect(adapters.make).toBeInstanceOf(ReadOnlyBootstrapMakeService)
    expect(await adapters.rates.readRate(marketId)).toEqual({
      mode: 'static',
      rateBps: 400n,
      observationId: expect.stringMatching(/^static:400:hour:\d+$/)
    })
  })

  test('rejects a write configuration whose private key does not match the maker', () => {
    const config = ConfigService.from({
      CHAIN_ID: '8453',
      RPC_URL: 'https://rpc.example',
      REFERENCE_RPC_URL: 'https://archive.example',
      MAKER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
      MAKER_ADDRESS: collateral,
      MIDNIGHT_ADDRESS: maker,
      LOAN_ASSET_ADDRESS: loanToken,
      RATIFIER_ADDRESS: ratifier,
      MARKET_IDS: marketId,
      REFERENCE_MARKET_ID: secondMarketId,
      NATIVE_RESERVE_WEI: '10',
      MAXIMUM_LEND_EXPOSURE_ASSETS: '100',
      MORPHO_API_BASE_URL: 'https://api.example',
      ROUTER_API_BASE_URL: 'https://router.example'
    })

    let error: unknown
    try {
      createProductionBootstrapAdapters(config)
    } catch (value) {
      error = value
    }

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({ operation: 'maker-private-key-mismatch' })
  })
})

describe('Setter bootstrap publication sequencing', () => {
  test('orders reserve, cancel, approval confirmation, exact payload validation, publication, and ownership confirmation', async () => {
    const events: string[] = []
    const payload: Hex = '0x1234'
    const tracked = new Set<Hex>()
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [{ id: groupId, marketId, assets: 100n, rateBps: 400n }],
      listBookOffers: async () => [],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({
        groupId: secondMarketId,
        publish: async () =>
          publishBootstrapPublication({
            ratifierType: 'setter',
            payload,
            ratify: async () => {
              events.push('approve-submit', 'approve-confirmed')
              return [{ operation: 'ratify', txHash: groupId }]
            },
            validate: async (validatedPayload: Hex) => {
              events.push('validate')
              expect(validatedPayload).toBe(payload)
            },
            publish: async () => {
              events.push('publish-submit', 'publish-confirmed')
              return { operation: 'publish', txHash: secondMarketId }
            }
          })
      }),
      reserveGroup: async id => {
        tracked.add(id)
        events.push('reserve')
      },
      confirmPublishedGroup: async () => {
        events.push('ownership-confirm')
      },
      releaseGroupReservation: async id => {
        tracked.delete(id)
        events.push('release')
      },
      invalidate: async () => {
        events.push('cancel-submit', 'cancel-confirmed')
        return groupId
      }
    })

    await service.reconcile({
      marketId,
      desiredOffer: { marketId, assets: 100n, rateBps: 500n, referenceObservationId: 'test' },
      reason: 'replace'
    })

    expect(events).toEqual([
      'reserve',
      'cancel-submit',
      'cancel-confirmed',
      'approve-submit',
      'approve-confirmed',
      'validate',
      'publish-submit',
      'publish-confirmed',
      'ownership-confirm'
    ])
  })

  test('does not publish or release the approved reservation when final payload validation fails', async () => {
    const events: string[] = []
    const tracked = new Set<Hex>()
    const service = new MidnightBootstrapMakeService({
      listActiveGroups: async () => [],
      listOwnedGroupIds: async () => [...tracked],
      listBookOffers: async () => [],
      toProspectiveBookOffer: async () => ({ marketId, buy: true, tick: 100n }),
      preparePublication: async () => ({
        groupId,
        publish: async () =>
          publishBootstrapPublication({
            ratifierType: 'setter',
            payload: '0x1234',
            ratify: async () => {
              events.push('approve-submit', 'approve-confirmed')
              return [{ operation: 'ratify', txHash: groupId }]
            },
            validate: async () => {
              events.push('validate')
              throw new Error('rejected')
            },
            publish: async () => {
              events.push('publish')
              return { operation: 'publish', txHash: secondMarketId }
            }
          })
      }),
      reserveGroup: async id => {
        tracked.add(id)
        events.push('reserve')
      },
      confirmPublishedGroup: async () => {
        events.push('ownership-confirm')
      },
      releaseGroupReservation: async id => {
        tracked.delete(id)
        events.push('release')
      },
      invalidate: async id => {
        tracked.delete(id)
        events.push('cleanup-cancel')
      },
      forgetGroups: async ids => {
        for (const id of ids) tracked.delete(id)
      }
    })

    await expect(
      service.reconcile({
        marketId,
        desiredOffer: { marketId, assets: 100n, rateBps: 500n, referenceObservationId: 'test' },
        reason: 'publish'
      })
    ).rejects.toMatchObject({
      operation: 'mempool-validation-after-ratification',
      confirmedTransactions: [{ operation: 'ratify', txHash: groupId }]
    })
    expect(events).toEqual(['reserve', 'approve-submit', 'approve-confirmed', 'validate'])
    expect([...tracked]).toEqual([groupId])

    await service.cleanup()
    expect(events).toEqual([
      'reserve',
      'approve-submit',
      'approve-confirmed',
      'validate',
      'cleanup-cancel'
    ])
    expect([...tracked]).toEqual([])
  })

  test('does not repeat final Mempool validation for Ecrecover publication', async () => {
    let validations = 0
    expect(
      await publishBootstrapPublication({
        ratifierType: 'ecrecover',
        payload: '0x1234',
        ratify: async () => [],
        validate: async () => {
          validations += 1
        },
        publish: async () => ({ operation: 'publish', txHash: groupId })
      })
    ).toEqual([{ operation: 'publish', txHash: groupId }])
    expect(validations).toBe(0)
  })
})

describe('bootstrapExposureMarketIds', () => {
  test('includes allowlisted markets without bootstrap entries in aggregate exposure reads', () => {
    expect(
      bootstrapExposureMarketIds({
        setup: { marketIds: [marketId, secondMarketId] },
        bootstrap: [{ marketId }]
      })
    ).toEqual([marketId, secondMarketId])
  })
})

describe('assertBootstrapTransaction', () => {
  const cancellation = {
    to: maker,
    value: 0n,
    data: encodeFunctionData({
      abi: midnightAbi,
      functionName: 'setConsumed',
      args: [groupId, MAX_OFFER_CAP, maker]
    })
  }

  test('accepts the exact zero-value Midnight cancellation call', async () => {
    await expect(
      assertBootstrapTransaction(cancellation, {
        kind: 'cancel',
        target: maker,
        groupId,
        account: maker
      })
    ).resolves.toBeUndefined()
  })

  test('accepts only the exact Setter root approval', async () => {
    const transaction = {
      to: ratifier,
      value: 0n,
      data: encodeFunctionData({
        abi: setterRatifierAbi,
        functionName: 'setIsRootRatified',
        args: [maker, groupId, true]
      })
    }

    await expect(
      assertBootstrapTransaction(transaction, {
        kind: 'ratification',
        target: ratifier,
        root: groupId,
        account: maker
      })
    ).resolves.toBeUndefined()
    for (const rejected of [
      { ...transaction, to: maker },
      { ...transaction, value: 1n },
      { ...transaction, data: '0xdeadbeef' as Hex },
      { ...transaction, data: transaction.data.slice(0, -2) as Hex },
      { ...transaction, data: `0xdeadbeef${transaction.data.slice(10)}` as Hex },
      {
        ...transaction,
        data: encodeFunctionData({
          abi: setterRatifierAbi,
          functionName: 'setIsRootRatified',
          args: [collateral, groupId, true]
        })
      },
      {
        ...transaction,
        data: encodeFunctionData({
          abi: setterRatifierAbi,
          functionName: 'setIsRootRatified',
          args: [maker, secondMarketId, true]
        })
      },
      {
        ...transaction,
        data: encodeFunctionData({
          abi: setterRatifierAbi,
          functionName: 'setIsRootRatified',
          args: [maker, groupId, false]
        })
      }
    ]) {
      await expect(
        assertBootstrapTransaction(rejected, {
          kind: 'ratification',
          target: ratifier,
          root: groupId,
          account: maker
        })
      ).rejects.toMatchObject({ operation: 'transaction-policy' })
    }
  })

  test('rejects canonical Setter root approval calldata with trailing bytes', async () => {
    const data = encodeFunctionData({
      abi: setterRatifierAbi,
      functionName: 'setIsRootRatified',
      args: [maker, groupId, true]
    })

    await expect(
      assertBootstrapTransaction(
        { to: ratifier, value: 0n, data: `${data}deadbeef` },
        { kind: 'ratification', target: ratifier, root: groupId, account: maker }
      )
    ).rejects.toMatchObject({ operation: 'transaction-policy' })
  })

  test.each([
    [{ ...cancellation, to: '0x1111111111111111111111111111111111111111' as Address }],
    [{ ...cancellation, value: 1n }],
    [{ ...cancellation, data: '0xdeadbeef' as Hex }],
    [
      {
        ...cancellation,
        data: encodeFunctionData({
          abi: midnightAbi,
          functionName: 'setConsumed',
          args: [secondMarketId, MAX_OFFER_CAP, maker]
        })
      }
    ],
    [
      {
        ...cancellation,
        data: encodeFunctionData({
          abi: midnightAbi,
          functionName: 'setConsumed',
          args: [groupId, MAX_OFFER_CAP - 1n, maker]
        })
      }
    ]
  ])('rejects cancellation transactions outside the signer policy', async transaction => {
    await expect(
      assertBootstrapTransaction(transaction, {
        kind: 'cancel',
        target: maker,
        groupId,
        account: maker
      })
    ).rejects.toMatchObject({ operation: 'transaction-policy' })
  })

  test('rejects malformed Midnight mempool publication payloads', async () => {
    await expect(
      assertBootstrapTransaction(
        { to: maker, value: 0n, data: '0xdeadbeef' },
        publicationPolicy(publicationOffer())
      )
    ).rejects.toMatchObject({ operation: 'transaction-policy' })
  })

  test('accepts exactly one intended Midnight offer in a publication payload', async () => {
    const offer = publicationOffer()
    const tree = Tree.create([offer])
    const data = await Payload.encode(SetterRatifierUtils.ratify({ tree }))

    await expect(
      assertBootstrapTransaction({ to: maker, value: 0n, data }, publicationPolicy(offer))
    ).resolves.toBeUndefined()

    const altered = await Payload.encode([{ offer, ratifierData: '0x1234' }])
    await expect(
      assertBootstrapTransaction({ to: maker, value: 0n, data: altered }, publicationPolicy(offer))
    ).rejects.toMatchObject({ operation: 'transaction-policy' })
  })

  test('rejects a publication payload containing two offers', async () => {
    const offer = publicationOffer()
    const data = await Payload.encode([
      { offer, ratifierData: '0x' },
      { offer: publicationOffer(104n), ratifierData: '0x' }
    ])

    await expect(
      assertBootstrapTransaction({ to: maker, value: 0n, data }, publicationPolicy(offer))
    ).rejects.toMatchObject({ operation: 'transaction-policy' })
  })

  test('rejects a valid publication payload whose offer differs from the signed intent', async () => {
    const offer = publicationOffer()
    const data = await Payload.encode([{ offer: publicationOffer(104n), ratifierData: '0x' }])

    await expect(
      assertBootstrapTransaction({ to: maker, value: 0n, data }, publicationPolicy(offer))
    ).rejects.toMatchObject({ operation: 'transaction-policy' })
  })
})

describe('bootstrapContinuousFeeCap', () => {
  test('uses the authoritative live market continuous fee', () => {
    expect(bootstrapContinuousFeeCap({ continuousFee: 17 })).toBe(17n)
  })

  test.each([undefined, Number.NaN, -1, 1.5, 0x1_0000_0000])(
    'fails closed when the live market continuous fee is unavailable or invalid: %p',
    continuousFee => {
      expect(() => bootstrapContinuousFeeCap({ continuousFee })).toThrow(
        expect.objectContaining({ operation: 'market-continuous-fee' })
      )
    }
  )
})

describe('createBootstrapOffer', () => {
  test('uses the current block time to prevent reuse of a consumed group', () => {
    const market = {
      params: publicationMarket,
      tickSpacing: 4,
      continuousFee: 0
    }
    const offer = {
      marketId,
      assets: 100n,
      rateBps: 500n,
      referenceObservationId: 'hour:1'
    }

    const first = createBootstrapOffer({ offer, market, maker, ratifier, now: 1_000n })
    const second = createBootstrapOffer({ offer, market, maker, ratifier, now: 1_001n })

    expect(first.tick).toBe(second.tick)
    expect(first.start).toBe(1_000n)
    expect(second.start).toBe(1_001n)
    expect(first.group).not.toBe(second.group)
  })
})

describe('recoverLegacyBootstrapOfferTick', () => {
  test('recovers the exact tick of an offer persisted before ticks were stored', () => {
    const market = {
      params: publicationMarket,
      tickSpacing: 2,
      continuousFee: 17
    }
    const legacyOffer = Offer.create({
      market: publicationMarket,
      buy: true,
      maker,
      tick: 410n,
      tickSpacing: 2n,
      expiry: publicationMarket.maturity,
      ratifier,
      maxAssets: 1_000n,
      continuousFeeCap: 17n
    })

    expect(
      recoverLegacyBootstrapOfferTick({
        groupId: legacyOffer.group,
        maximumAssets: legacyOffer.maxAssets,
        market,
        maker,
        ratifier
      })
    ).toBe(410n)
  })

  test('uses a persisted fee cap when the live market fee changed after publication', () => {
    const legacyOffer = Offer.create({
      market: publicationMarket,
      buy: true,
      maker,
      tick: 410n,
      tickSpacing: 2n,
      expiry: publicationMarket.maturity,
      ratifier,
      maxAssets: 1_000n,
      continuousFeeCap: 16n
    })

    expect(
      recoverLegacyBootstrapOfferTick({
        groupId: legacyOffer.group,
        maximumAssets: legacyOffer.maxAssets,
        market: { params: publicationMarket, tickSpacing: 2, continuousFee: 17 },
        maker,
        ratifier,
        continuousFeeCap: legacyOffer.continuousFeeCap
      })
    ).toBe(410n)
  })

  test('bounds a pre-v5 tick from its original observation when the fee cap is unavailable', () => {
    const market = { params: publicationMarket, tickSpacing: 2, continuousFee: 17 }
    const offer = {
      marketId,
      assets: 1_000n,
      rateBps: 500n,
      referenceObservationId: 'hour:1'
    }
    const firstPossible = createBootstrapOffer({ offer, market, maker, ratifier, now: 3_600n })
    const lastPossible = createBootstrapOffer({ offer, market, maker, ratifier, now: 7_500n })

    expect(legacyBootstrapOfferTickUpperBound({ offer, market })).toBe(
      firstPossible.tick > lastPossible.tick ? firstPossible.tick : lastPossible.tick
    )
  })

  test('rejects a reconstruction that does not match the persisted group identity', () => {
    expect(
      recoverLegacyBootstrapOfferTick({
        groupId,
        maximumAssets: 1_000n,
        market: { params: publicationMarket, tickSpacing: 4, continuousFee: 17 },
        maker,
        ratifier
      })
    ).toBeUndefined()
  })
})

describe('readBootstrapGroups', () => {
  test('counts each owned group unfilled reserve once across multi-market projections', async () => {
    const secondOffer = {
      ...group().offers[0],
      market_id: secondMarketId,
      tick: 200,
      market: { maturity: 3_000 }
    }
    const groups = await readBootstrapGroups(
      { maker, requestTimeoutMs: 1_000 },
      {
        request: async () => ({
          data: [
            group({
              max_assets: '125',
              consumed: '25',
              offers: [...group().offers, secondOffer]
            })
          ],
          cursor: null
        })
      }
    )

    expect(bootstrapReservedLoanAssets(groups, [groupId])).toBe(100n)
    expect(bootstrapReservedLoanAssets(groups, [groupId], new Set([groupId]))).toBe(0n)
  })

  test('excludes durably owned sell-only groups from the loan-token cash reserve', async () => {
    const secondGroupId: Hex = `0x${'ef'.repeat(32)}`
    const sellOnly = { ...group().offers[0], buy: false }
    const groups = await readBootstrapGroups(
      { maker, requestTimeoutMs: 1_000 },
      {
        request: async () => ({
          data: [
            group({ max_assets: '125', offers: [] }),
            group({ id: secondGroupId, max_assets: '75', offers: [sellOnly] })
          ],
          cursor: null
        })
      }
    )

    expect(strategyBootstrapGroups(groups, [groupId, secondGroupId])).toEqual([])
    expect(bootstrapReservedLoanAssets(groups, [groupId, secondGroupId])).toBe(0n)
  })

  test('passes the full distinct owned reserve in the actual makeLend argument shape', async () => {
    const secondGroupId: Hex = `0x${'ef'.repeat(32)}`
    const groups = await readBootstrapGroups(
      { maker, requestTimeoutMs: 1_000 },
      {
        request: async () => ({
          data: [group({ max_assets: '125' }), group({ id: secondGroupId, max_assets: '75' })],
          cursor: null
        })
      }
    )
    const offer = publicationOffer()
    const captured: unknown[] = []
    const makeLend = async (arguments_: unknown) => {
      captured.push(arguments_)
    }

    await makeLend(
      bootstrapMakeLendArguments({
        accountAddress: maker,
        offers: [offer],
        validation: { apiUrl: 'https://api.example/v0/midnight' },
        loanToken,
        loanAssets: 100n,
        reservedLoanAssets: bootstrapReservedLoanAssets(groups, [groupId, secondGroupId])
      })
    )

    expect(captured).toEqual([
      expect.objectContaining({ offers: [offer], loanAssets: 100n, reservedLoanAssets: 200n })
    ])
  })

  test('flattens multi-market group projections without quadratic offer expansion', async () => {
    const offers = Array.from({ length: 1_000 }, (_, index) => ({
      ...group().offers[0],
      market_id: `0x${index.toString(16).padStart(64, '0')}`,
      tick: index,
      market: { maturity: 3_000 + index }
    }))
    const groups = await readBootstrapGroups(
      { maker, requestTimeoutMs: 1_000 },
      { request: async () => ({ data: [group({ offers })], cursor: null }) }
    )

    expect(groups).toHaveLength(1_000)
    expect(bootstrapBookOffers(groups)).toHaveLength(1_000)
  })

  test('requests only Base offer groups', async () => {
    let requestedUrl = ''
    await readBootstrapGroups(
      { maker, requestTimeoutMs: 1_000 },
      {
        request: async url => {
          requestedUrl = url
          return { data: [], cursor: null }
        }
      }
    )

    expect(new URL(requestedUrl, 'https://morpho.test').searchParams.get('chain_ids')).toBe('8453')
  })

  test('ignores non-Base groups returned by the provider', async () => {
    const groups = await readBootstrapGroups(
      { maker, requestTimeoutMs: 1_000 },
      { request: async () => ({ data: [group({ chain_id: 1 }), group()], cursor: null }) }
    )

    expect(groups.map(value => value.id)).toEqual([groupId])
  })

  test('derives ownership only from explicit durable group IDs', async () => {
    const unrelatedGroupId: Hex = `0x${'ef'.repeat(32)}`
    const groups = await readBootstrapGroups(
      { maker, requestTimeoutMs: 1_000 },
      {
        request: async () => ({
          data: [group(), group({ id: unrelatedGroupId })],
          cursor: null
        })
      }
    )

    expect(strategyBootstrapGroups(groups, [groupId]).map(value => value.id)).toEqual([groupId])
  })

  test('projects an explicitly owned shared group into every buy-offer market', async () => {
    const secondOffer = {
      ...group().offers[0],
      market_id: secondMarketId,
      tick: 200,
      market: { maturity: 3_000 }
    }
    const groups = await readBootstrapGroups(
      { maker, requestTimeoutMs: 1_000 },
      {
        request: async () => ({
          data: [group({ offers: [...group().offers, secondOffer] })],
          cursor: null
        })
      }
    )

    expect(strategyBootstrapGroups(groups, [groupId])).toEqual([
      expect.objectContaining({
        id: groupId,
        marketId,
        tick: 100n,
        maturity: 2_000n,
        continuousFeeCap: 0n
      }),
      expect.objectContaining({
        id: groupId,
        marketId: secondMarketId,
        tick: 200n,
        maturity: 3_000n
      })
    ])
  })

  test.each([
    ['negative', '-1'],
    ['hexadecimal', '0x10'],
    ['explicitly signed', '+1'],
    ['decimal', '1.5'],
    ['exponent', '1e3'],
    ['whitespace padded', ' 1'],
    ['leading-zero', '01'],
    ['empty', ''],
    ['malformed', 'one']
  ])('rejects %s asset strings before bigint conversion', async (_label, assets) => {
    for (const field of ['consumed', 'max_assets'] as const) {
      const error = await readBootstrapGroups(
        { maker, requestTimeoutMs: 1_000 },
        { request: async () => ({ data: [group({ [field]: assets })], cursor: null }) }
      ).catch(value => value)

      expect(error).toBeInstanceOf(BootstrapAdapterError)
      expect(error).toMatchObject({ operation: 'offer-groups-response' })
    }
  })

  test('rejects consumed assets above maximum assets', async () => {
    const error = await readBootstrapGroups(
      { maker, requestTimeoutMs: 1_000 },
      { request: async () => ({ data: [group({ consumed: '101' })], cursor: null }) }
    ).catch(value => value)

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({ operation: 'offer-groups-response' })
  })

  test.each(['', '   '])('fails closed on an empty pagination cursor %p', async cursor => {
    const error = await readBootstrapGroups(
      { maker, requestTimeoutMs: 1_000 },
      { request: async () => ({ data: [], cursor }) }
    ).catch(value => value)

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({ operation: 'offer-groups-cursor' })
  })

  test('fails closed when the pagination cursor is missing', async () => {
    const error = await readBootstrapGroups(
      { maker, requestTimeoutMs: 1_000 },
      { request: async () => ({ data: [group()] }) }
    ).catch(value => value)

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({ operation: 'offer-groups-cursor' })
  })

  test('fails closed when a pagination cursor repeats', async () => {
    const request = async () => ({ data: [group()], cursor: 'repeat' })

    const error = await readBootstrapGroups({ maker, requestTimeoutMs: 1_000 }, { request }).catch(
      value => value
    )

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({ operation: 'offer-groups-repeated-cursor' })
  })

  test.each([null, true, 1, 'invalid'])(
    'classifies a malformed top-level response %p',
    async response => {
      const error = await readBootstrapGroups(
        { maker, requestTimeoutMs: 1_000 },
        { request: async () => response }
      ).catch(value => value)

      expect(error).toBeInstanceOf(BootstrapAdapterError)
      expect(error).toMatchObject({ operation: 'offer-groups-response' })
    }
  )

  test('fails closed when aggregate pagination exceeds its deadline', async () => {
    let time = 0
    const request = async () => {
      time = 2
      return { data: [group()], cursor: 'next' }
    }

    const error = await readBootstrapGroups(
      { maker, requestTimeoutMs: 1 },
      { request, now: () => time }
    ).catch(value => value)

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({ operation: 'offer-groups-timeout' })
  })

  test('fails closed when pagination exceeds the page cap', async () => {
    let page = 0
    const request = async () => ({ data: [], cursor: `page-${++page}` })

    const error = await readBootstrapGroups({ maker, requestTimeoutMs: 1_000 }, { request }).catch(
      value => value
    )

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({ operation: 'offer-groups-page-limit' })
  })

  test('fails closed when pagination exceeds the offer item cap', async () => {
    const offer = group().offers[0]
    const oversized = group({ offers: Array(100_001).fill(offer) })

    const error = await readBootstrapGroups(
      { maker, requestTimeoutMs: 1_000 },
      { request: async () => ({ data: [oversized], cursor: null }) }
    ).catch(value => value)

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({ operation: 'offer-groups-item-limit' })
  })

  test('normalizes mixed-case bytes32 IDs and rejects malformed IDs', async () => {
    const mixedGroup = `0x${'aB'.repeat(32)}`
    const mixedMarket = `0x${'cD'.repeat(32)}`
    const valid = await readBootstrapGroups(
      { maker, requestTimeoutMs: 1_000 },
      {
        request: async () => ({
          data: [
            group({ id: mixedGroup, offers: [{ ...group().offers[0], market_id: mixedMarket }] })
          ],
          cursor: null
        })
      }
    )

    expect(valid[0]).toMatchObject({
      id: mixedGroup.toLowerCase(),
      marketId: mixedMarket.toLowerCase()
    })

    const error = await readBootstrapGroups(
      { maker, requestTimeoutMs: 1_000 },
      { request: async () => ({ data: [group({ id: '0x1234' })], cursor: null }) }
    ).catch(value => value)
    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({ operation: 'offer-groups-response' })
  })
})

describe('createBootstrapGroupOwnership', () => {
  test('persists reservations across instances and removes unpublished IDs safely', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'market-making-reservation-'))
    const ownership = createBootstrapGroupOwnership(
      { maker, marketIds: [marketId], configuredGroupIds: [] },
      { stateDirectory: directory }
    )
    try {
      await ownership.reserve(groupId)

      const restarted = createBootstrapGroupOwnership(
        { maker, marketIds: [marketId], configuredGroupIds: [] },
        { stateDirectory: directory }
      )
      expect(await restarted.read()).toEqual([groupId])

      await restarted.release(groupId)
      expect(await ownership.read()).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('persists the intended offer metadata used to rehydrate a confirmed group', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'market-making-offer-metadata-'))
    const ownership = createBootstrapGroupOwnership(
      { maker, marketIds: [marketId], configuredGroupIds: [] },
      { stateDirectory: directory }
    )
    const offer = {
      marketId,
      assets: 100n,
      rateBps: 450n,
      referenceObservationId: 'blocks:100-200',
      tick: 123n,
      continuousFeeCap: 17n
    }
    try {
      await ownership.reserve(groupId, offer)
      await ownership.confirm(groupId)

      const restarted = createBootstrapGroupOwnership(
        { maker, marketIds: [marketId], configuredGroupIds: [] },
        { stateDirectory: directory }
      )
      expect(await restarted.readOffers()).toEqual([{ groupId, ...offer }])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('rejects a negative protocol tick before persisting offer ownership', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'market-making-invalid-tick-'))
    const ownership = createBootstrapGroupOwnership(
      { maker, marketIds: [marketId], configuredGroupIds: [] },
      { stateDirectory: directory }
    )
    try {
      const error = await ownership
        .reserve(groupId, {
          marketId,
          assets: 100n,
          rateBps: 450n,
          referenceObservationId: 'blocks:100-200',
          tick: -1n,
          continuousFeeCap: 17n
        })
        .catch(value => value)

      expect(error).toBeInstanceOf(BootstrapAdapterError)
      expect(error).toMatchObject({ operation: 'group-ownership-state' })
      expect(await ownership.read()).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('retains bot-issued IDs across instances without sharing them with another strategy', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'market-making-ownership-'))
    const ownership = createBootstrapGroupOwnership(
      { maker, marketIds: [marketId], configuredGroupIds: [] },
      { stateDirectory: directory }
    )
    try {
      await ownership.reserve(groupId)
      await ownership.confirm(groupId)

      const restarted = createBootstrapGroupOwnership(
        { maker, marketIds: [marketId], configuredGroupIds: [] },
        { stateDirectory: directory }
      )
      const otherStrategy = createBootstrapGroupOwnership(
        { maker, marketIds: [`0x${'12'.repeat(32)}`], configuredGroupIds: [] },
        { stateDirectory: directory }
      )

      expect(await restarted.read()).toEqual([groupId])
      expect(await otherStrategy.read()).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('forgets canceled persisted groups while retaining configured ownership', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'market-making-forget-'))
    const configuredGroupId: Hex = `0x${'34'.repeat(32)}`
    const ownership = createBootstrapGroupOwnership(
      { maker, marketIds: [marketId], configuredGroupIds: [configuredGroupId] },
      { stateDirectory: directory }
    )
    try {
      await ownership.reserve(groupId, {
        marketId,
        assets: 100n,
        rateBps: 450n,
        referenceObservationId: 'blocks:100-200'
      })
      await ownership.confirm(groupId)

      expect(await ownership.read()).toEqual([configuredGroupId, groupId])
      expect(await ownership.readPersistedGroupIds()).toEqual([groupId])

      await ownership.forget([groupId, configuredGroupId])

      expect(await ownership.read()).toEqual([configuredGroupId])
      expect(await ownership.readPersistedGroupIds()).toEqual([])
      expect(await ownership.readOffers()).toEqual([])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

describe('prepareBootstrapRequirements', () => {
  test('preserves Ecrecover root-signature requirements', async () => {
    const signature = {
      kind: 'signed'
    } as unknown as import('@morpho-org/morpho-sdk').MidnightOfferRootSignature
    const requirement = {
      action: {
        type: 'midnightOfferRootSignature',
        args: { root: groupId, ratifier, offers: 1 }
      },
      sign: async () => signature
    }

    expect(
      await prepareBootstrapRequirements(
        [requirement],
        async (_requirement, account) => {
          expect(account).toBe(maker)
          return signature
        },
        { kind: 'ecrecover', target: ratifier, root: groupId, account: maker, offers: 1 }
      )
    ).toEqual({
      signatures: [signature],
      transactions: []
    })
  })

  test('rejects altered Ecrecover semantics before signing', async () => {
    let signed = false
    const requirement = {
      action: {
        type: 'midnightOfferRootSignature',
        args: { root: secondMarketId, ratifier, offers: 1 }
      },
      sign: async () => ({})
    }

    await expect(
      prepareBootstrapRequirements(
        [requirement],
        async () => {
          signed = true
          return {} as never
        },
        { kind: 'ecrecover', target: ratifier, root: groupId, account: maker, offers: 1 }
      )
    ).rejects.toMatchObject({ operation: 'unexpected-requirement' })
    expect(signed).toBe(false)
  })

  test.each([
    ['missing', []],
    [
      'duplicate',
      [
        {
          action: {
            type: 'midnightOfferRootSignature',
            args: { root: groupId, ratifier, offers: 1 }
          },
          sign: async () => ({})
        },
        {
          action: {
            type: 'midnightOfferRootSignature',
            args: { root: groupId, ratifier, offers: 1 }
          },
          sign: async () => ({})
        }
      ]
    ]
  ])('rejects %s Ecrecover signature requirements before signing', async (_label, requirements) => {
    let signed = false

    await expect(
      prepareBootstrapRequirements(
        requirements,
        async () => {
          signed = true
          return {} as never
        },
        { kind: 'ecrecover', target: ratifier, root: groupId, account: maker, offers: 1 }
      )
    ).rejects.toMatchObject({ operation: 'unexpected-requirement' })
    expect(signed).toBe(false)
  })

  test('returns one validated Setter root-ratification requirement without trying to sign it', async () => {
    const requirement = {
      to: ratifier,
      data: encodeFunctionData({
        abi: setterRatifierAbi,
        functionName: 'setIsRootRatified',
        args: [maker, groupId, true]
      }),
      value: 0n,
      action: {
        type: 'setterRatifierRatifyRoot',
        args: { maker, root: groupId, isRootRatified: true }
      }
    } as const

    expect(
      await prepareBootstrapRequirements(
        [requirement],
        async () => {
          throw new Error('Setter requirement must not be signed')
        },
        { kind: 'setter', target: ratifier, root: groupId, account: maker }
      )
    ).toEqual({ signatures: [], transactions: [requirement] })

    await expect(
      prepareBootstrapRequirements(
        [{ ...requirement, data: '0x12345678' }],
        async () => {
          throw new Error('Setter requirement must not be signed')
        },
        { kind: 'setter', target: ratifier, root: groupId, account: maker }
      )
    ).rejects.toMatchObject({ operation: 'unexpected-requirement' })
  })

  test('rejects mixed ratifiers before signing', async () => {
    let signed = false
    const signatureRequirement = {
      action: { type: 'midnightOfferRootSignature' },
      sign: async () => ({})
    }
    const setterRequirement = {
      to: '0x800B5F12A61B8198a5a6EfD794Cac6699B294d63',
      data: '0x12345678',
      value: 0n,
      action: {
        type: 'setterRatifierRatifyRoot',
        args: { maker, root: groupId, isRootRatified: true }
      }
    } as const

    await expect(
      prepareBootstrapRequirements(
        [signatureRequirement, setterRequirement],
        async () => {
          signed = true
          return {} as never
        },
        { kind: 'ecrecover', target: ratifier, root: groupId, account: maker, offers: 1 }
      )
    ).rejects.toMatchObject({ operation: 'unexpected-requirement' })
    expect(signed).toBe(false)
  })

  test('rejects multiple Setter approval requirements before executing either one', async () => {
    const requirement = {
      to: '0x800B5F12A61B8198a5a6EfD794Cac6699B294d63',
      data: '0x12345678',
      value: 0n,
      action: {
        type: 'setterRatifierRatifyRoot',
        args: { maker, root: groupId, isRootRatified: true }
      }
    } as const

    await expect(
      prepareBootstrapRequirements(
        [requirement, requirement],
        async () => {
          throw new Error('Setter requirement must not be signed')
        },
        { kind: 'setter', target: ratifier, root: groupId, account: maker }
      )
    ).rejects.toMatchObject({ operation: 'unexpected-requirement' })
  })

  test('requires exactly one Setter approval requirement before signing', async () => {
    let signed = false

    await expect(
      prepareBootstrapRequirements(
        [],
        async () => {
          signed = true
          return {} as never
        },
        { kind: 'setter', target: ratifier, root: groupId, account: maker }
      )
    ).rejects.toMatchObject({ operation: 'unexpected-requirement' })
    expect(signed).toBe(false)
  })

  test.each([
    [
      'unknown target',
      { to: '0x1111111111111111111111111111111111111111', data: '0x12345678', value: 0n }
    ],
    ['unknown selector', { to: maker, data: '0xdeadbeef', value: 0n }],
    ['nonzero value', { to: maker, data: '0x12345678', value: 1n }],
    ['malformed calldata', { to: maker, data: '0x12', value: 0n }],
    ['unexpected type', { action: { type: 'authorization' }, sign: async () => ({}) }]
  ])('rejects %s requirements without executing them', async (_label, requirement) => {
    let signed = false

    const error = await prepareBootstrapRequirements(
      [requirement],
      async () => {
        signed = true
        return {} as never
      },
      { kind: 'ecrecover', target: ratifier, root: groupId, account: maker, offers: 1 }
    ).catch(value => value)

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(signed).toBe(false)
  })
})
