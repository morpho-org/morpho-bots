import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP, midnightAbi, Offer, Payload } from '@morpho-org/midnight-sdk'
import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFunctionData } from 'viem'

import { BootstrapAdapterError } from '../../../src/infrastructure/bootstrap/bootstrap-adapter.error'
import { bootstrapExposureMarketIds } from '../../../src/infrastructure/bootstrap/bootstrap-exposure.utils'
import { createBootstrapGroupOwnership } from '../../../src/infrastructure/bootstrap/bootstrap-group-ownership.utils'
import {
  bootstrapReservedLoanAssets,
  readBootstrapGroups,
  strategyBootstrapGroups
} from '../../../src/infrastructure/bootstrap/bootstrap-groups.utils'
import { bootstrapContinuousFeeCap } from '../../../src/infrastructure/bootstrap/bootstrap-offer.utils'
import { signBootstrapRequirements } from '../../../src/infrastructure/bootstrap/bootstrap-requirements.utils'
import { assertBootstrapTransaction } from '../../../src/infrastructure/bootstrap/bootstrap-transaction.utils'

const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const marketId: Hex = `0x${'ab'.repeat(32)}`
const secondMarketId: Hex = `0x${'12'.repeat(32)}`
const groupId: Hex = `0x${'cd'.repeat(32)}`
const collateral: Address = '0x1111111111111111111111111111111111111111'
const loanToken: Address = '0x2222222222222222222222222222222222222222'
const oracle: Address = '0x3333333333333333333333333333333333333333'
const ratifier: Address = '0x4444444444444444444444444444444444444444'

const publicationOffer = (tick = 100n) =>
  Offer.create({
    market: {
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
    },
    buy: true,
    maker,
    tick,
    expiry: 54_000n,
    ratifier,
    maxAssets: 100n
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
      market: { maturity: 2_000 }
    }
  ],
  ...overrides
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
        { kind: 'publication', target: maker, offer: publicationOffer() }
      )
    ).rejects.toMatchObject({ operation: 'transaction-policy' })
  })

  test('accepts exactly one intended Midnight offer in a publication payload', async () => {
    const offer = publicationOffer()
    const data = await Payload.encode([{ offer, ratifierData: '0x' }])

    await expect(
      assertBootstrapTransaction(
        { to: maker, value: 0n, data },
        { kind: 'publication', target: maker, offer }
      )
    ).resolves.toBeUndefined()
  })

  test('rejects a valid publication payload whose offer differs from the signed intent', async () => {
    const offer = publicationOffer()
    const data = await Payload.encode([{ offer: publicationOffer(104n), ratifierData: '0x' }])

    await expect(
      assertBootstrapTransaction(
        { to: maker, value: 0n, data },
        { kind: 'publication', target: maker, offer }
      )
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

describe('readBootstrapGroups', () => {
  test('counts each owned group full reserve once across multi-market projections', async () => {
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

    expect(bootstrapReservedLoanAssets(groups, [groupId])).toBe(125n)
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
      expect.objectContaining({ id: groupId, marketId, tick: 100n, maturity: 2_000n }),
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
      referenceObservationId: 'blocks:100-200'
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
})

describe('signBootstrapRequirements', () => {
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

    const error = await signBootstrapRequirements([requirement], async () => {
      signed = true
      return {} as never
    }).catch(value => value)

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(signed).toBe(false)
  })
})
