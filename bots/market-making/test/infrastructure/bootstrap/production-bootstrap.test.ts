import type { Address, Hex } from 'viem'

import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BootstrapAdapterError } from '../../../src/infrastructure/bootstrap/bootstrap-adapter.error'
import { createBootstrapGroupOwnership } from '../../../src/infrastructure/bootstrap/bootstrap-group-ownership.utils'
import {
  readBootstrapGroups,
  strategyBootstrapGroups
} from '../../../src/infrastructure/bootstrap/bootstrap-groups.utils'
import { bootstrapContinuousFeeCap } from '../../../src/infrastructure/bootstrap/bootstrap-offer.utils'
import { signBootstrapRequirements } from '../../../src/infrastructure/bootstrap/bootstrap-requirements.utils'

const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const marketId: Hex = `0x${'ab'.repeat(32)}`
const secondMarketId: Hex = `0x${'12'.repeat(32)}`
const groupId: Hex = `0x${'cd'.repeat(32)}`

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
