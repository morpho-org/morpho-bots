import type { Address, Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import { BootstrapAdapterError } from '../../../src/infrastructure/bootstrap/bootstrap-adapter.error'
import {
  readBootstrapGroups,
  strategyBootstrapGroups
} from '../../../src/infrastructure/bootstrap/bootstrap-groups.utils'
import { signBootstrapRequirements } from '../../../src/infrastructure/bootstrap/bootstrap-requirements.utils'

const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const marketId: Hex = `0x${'ab'.repeat(32)}`
const groupId: Hex = `0x${'cd'.repeat(32)}`

const group = (overrides: Record<string, unknown> = {}) => ({
  id: groupId,
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

describe('readBootstrapGroups', () => {
  test('re-derives a previously published maker group for a configured market', async () => {
    const groups = await readBootstrapGroups(
      { maker, requestTimeoutMs: 1_000 },
      { request: async () => ({ data: [group()], cursor: null }) }
    )

    expect(strategyBootstrapGroups(groups, [marketId]).map(value => value.id)).toEqual([groupId])
  })

  test('fails closed when a pagination cursor repeats', async () => {
    const request = async () => ({ data: [group()], cursor: 'repeat' })

    const error = await readBootstrapGroups({ maker, requestTimeoutMs: 1_000 }, { request }).catch(
      value => value
    )

    expect(error).toBeInstanceOf(BootstrapAdapterError)
    expect(error).toMatchObject({ operation: 'offer-groups-repeated-cursor' })
  })

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
