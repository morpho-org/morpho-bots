import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP } from '@morpho-org/midnight-sdk'
import { base } from 'viem/chains'
import { describe, expect, test } from 'vitest'

import { LadderAdapterError } from '../../../src/errors'
import { readMakerOfferGroups } from '../../../src/infrastructure/provider/offer-groups.utils'

const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const otherMaker: Address = '0x1563915e194D8CfBA1943570603F7606A3115508'
const marketId: Hex = `0x${'ab'.repeat(32)}`
const groupId: Hex = `0x${'cd'.repeat(32)}`

const page = (
  offerMaker: Address,
  caps: Record<string, string> = { max_assets: '100', max_units: '0' }
) => ({
  data: [
    {
      id: groupId,
      chain_id: base.id,
      consumed: '0',
      ...caps,
      offers: [
        {
          market_id: marketId,
          maker: offerMaker,
          buy: true,
          tick: 100,
          continuous_fee_cap: '0',
          market: { maturity: 2_000 }
        }
      ]
    }
  ],
  cursor: null
})

/** One wire group of the configured maker, as the offer-groups API returns it. */
const group = (overrides: Record<string, unknown> = {}) => ({
  ...page(maker).data[0]!,
  ...overrides
})

const read = (response: unknown) =>
  readMakerOfferGroups(
    { adapterError: LadderAdapterError, chainId: base.id, maker, requestTimeoutMs: 1_000 },
    { request: async () => response }
  ).catch((error: unknown) => error)

describe('readMakerOfferGroups', () => {
  test('reports a malformed page as the calling workflow adapter error', async () => {
    const error = await read({ data: 'not-a-list', cursor: null })

    expect(error).toBeInstanceOf(LadderAdapterError)
    expect(error).toMatchObject({ name: 'LadderAdapterError', operation: 'offer-groups-response' })
  })

  test('keeps a nested classification instead of rewrapping it as a malformed response', async () => {
    const error = await read(page(otherMaker))

    expect(error).toBeInstanceOf(LadderAdapterError)
    expect(error).toMatchObject({ operation: 'offer-groups-maker' })
  })

  test.each([
    ['cash', { max_assets: '100', max_units: '0' }, { kind: 'assets', maximum: 100n }],
    ['credit units', { max_assets: '0', max_units: '100' }, { kind: 'units', maximum: 100n }]
  ])('reads a group capped in %s', async (_label, caps, cap) => {
    const groups = await read(page(maker, caps))

    expect(groups).toMatchObject([{ id: groupId, cap }])
  })

  test.each([
    ['both caps', { max_assets: '100', max_units: '100' }],
    ['neither cap', { max_assets: '0', max_units: '0' }],
    ['no max_units key', { max_assets: '100' }],
    ['no cap at all', {}],
    ['a cap above uint128', { max_assets: '0', max_units: String(MAX_OFFER_CAP + 1n) }]
  ])('fails closed on a group with %s', async (_label, caps) => {
    const error = await read(page(maker, caps))

    expect(error).toMatchObject({ name: 'LadderAdapterError', operation: 'offer-groups-response' })
  })

  test('reads a cancelled group as fully consumed rather than malformed', async () => {
    const response = page(maker, { max_assets: '0', max_units: '100' })
    response.data[0]!.consumed = String(MAX_OFFER_CAP)

    const groups = await read(response)

    expect(groups).toMatchObject([{ consumed: MAX_OFFER_CAP, cap: { kind: 'units' } }])
  })

  test('fails closed on consumption above a units cap that is not the cancellation sentinel', async () => {
    const response = page(maker, { max_assets: '0', max_units: '100' })
    response.data[0]!.consumed = '101'

    const error = await read(response)

    expect(error).toMatchObject({ operation: 'offer-groups-response' })
  })

  test('requests only Base offer groups', async () => {
    let requestedUrl = ''
    await readMakerOfferGroups(
      { adapterError: LadderAdapterError, chainId: base.id, maker, requestTimeoutMs: 1_000 },
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
    const groups = await readMakerOfferGroups(
      { adapterError: LadderAdapterError, chainId: base.id, maker, requestTimeoutMs: 1_000 },
      { request: async () => ({ data: [group({ chain_id: 1 }), group()], cursor: null }) }
    )

    expect(groups.map(value => value.id)).toEqual([groupId])
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
    for (const field of ['consumed', 'max_assets', 'max_units'] as const) {
      const error = await readMakerOfferGroups(
        { adapterError: LadderAdapterError, chainId: base.id, maker, requestTimeoutMs: 1_000 },
        { request: async () => ({ data: [group({ [field]: assets })], cursor: null }) }
      ).catch(value => value)

      expect(error).toBeInstanceOf(LadderAdapterError)
      expect(error).toMatchObject({ operation: 'offer-groups-response' })
    }
  })

  test('rejects consumed assets above maximum assets', async () => {
    const error = await readMakerOfferGroups(
      { adapterError: LadderAdapterError, chainId: base.id, maker, requestTimeoutMs: 1_000 },
      { request: async () => ({ data: [group({ consumed: '101' })], cursor: null }) }
    ).catch(value => value)

    expect(error).toBeInstanceOf(LadderAdapterError)
    expect(error).toMatchObject({ operation: 'offer-groups-response' })
  })

  test('fails closed when the pagination cursor is missing', async () => {
    const error = await readMakerOfferGroups(
      { adapterError: LadderAdapterError, chainId: base.id, maker, requestTimeoutMs: 1_000 },
      { request: async () => ({ data: [group()] }) }
    ).catch(value => value)

    expect(error).toBeInstanceOf(LadderAdapterError)
    expect(error).toMatchObject({ operation: 'offer-groups-cursor' })
  })

  test.each([null, true, 1, 'invalid'])(
    'classifies a malformed top-level response %p',
    async response => {
      const error = await readMakerOfferGroups(
        { adapterError: LadderAdapterError, chainId: base.id, maker, requestTimeoutMs: 1_000 },
        { request: async () => response }
      ).catch(value => value)

      expect(error).toBeInstanceOf(LadderAdapterError)
      expect(error).toMatchObject({ operation: 'offer-groups-response' })
    }
  )

  test('normalizes mixed-case bytes32 IDs and rejects malformed IDs', async () => {
    const mixedGroup = `0x${'aB'.repeat(32)}`
    const mixedMarket = `0x${'cD'.repeat(32)}`
    const valid = await readMakerOfferGroups(
      { adapterError: LadderAdapterError, chainId: base.id, maker, requestTimeoutMs: 1_000 },
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

    const error = await readMakerOfferGroups(
      { adapterError: LadderAdapterError, chainId: base.id, maker, requestTimeoutMs: 1_000 },
      { request: async () => ({ data: [group({ id: '0x1234' })], cursor: null }) }
    ).catch(value => value)
    expect(error).toBeInstanceOf(LadderAdapterError)
    expect(error).toMatchObject({ operation: 'offer-groups-response' })
  })

  describe('pagination bounds', () => {
    const traverse = (
      respond: (url: string) => unknown,
      options: { requestTimeoutMs?: number; now?: () => number } = {}
    ) => {
      const budgets: (number | undefined)[] = []
      const result = readMakerOfferGroups(
        {
          adapterError: LadderAdapterError,
          chainId: base.id,
          maker,
          requestTimeoutMs: options.requestTimeoutMs ?? 1_000
        },
        {
          request: async (url, _provider, timeoutMs) => {
            budgets.push(timeoutMs)
            return respond(url)
          },
          ...(options.now ? { now: options.now } : {})
        }
      ).catch((error: unknown) => error)
      return { result, budgets }
    }
    const empty = (cursor: unknown) => ({ cursor, data: [] })

    test('fails closed at one aggregate deadline while traversing delayed unique cursors', async () => {
      let now = 0
      let pages = 0
      const { result, budgets } = traverse(
        () => {
          now += 4
          pages += 1
          return empty(`unique-${pages}`)
        },
        { requestTimeoutMs: 10, now: () => now }
      )

      expect(await result).toMatchObject({ operation: 'offer-groups-timeout' })
      expect(pages).toBe(3)
      expect(budgets).toEqual([10, 6, 2])
    })

    test('does not start another cursor request at the exact aggregate deadline', async () => {
      let now = 5
      let pages = 0
      const { result, budgets } = traverse(
        () => {
          now = 15
          pages += 1
          return empty(`boundary-${pages}`)
        },
        { requestTimeoutMs: 10, now: () => now }
      )

      expect(await result).toMatchObject({ operation: 'offer-groups-timeout' })
      expect(pages).toBe(1)
      expect(budgets).toEqual([10])
    })

    test('fails closed when the API repeats a cursor', async () => {
      expect(await traverse(() => empty('loop')).result).toMatchObject({
        operation: 'offer-groups-repeated-cursor'
      })
    })

    test.each(['', '   ', 42])('rejects a malformed non-null cursor %p', async cursor => {
      expect(await traverse(() => empty(cursor)).result).toMatchObject({
        operation: 'offer-groups-cursor'
      })
    })

    test('fails closed past the page limit with unique cursors', async () => {
      let pages = 0
      const { result } = traverse(() => empty(`page-${(pages += 1)}`))
      expect(await result).toMatchObject({ operation: 'offer-groups-page-limit' })
      expect(pages).toBe(100)
    })

    test('fails closed when one page holds more groups than requested', async () => {
      const group = page(maker).data[0]!
      expect(
        await traverse(() => ({ cursor: null, data: Array.from({ length: 101 }, () => group) }))
          .result
      ).toMatchObject({ operation: 'offer-groups-page-size' })
    })

    test('fails closed past the item limit', async () => {
      const group = page(maker).data[0]!
      const offers = Array.from({ length: 100_001 }, () => group.offers[0])
      expect(
        await traverse(() => ({ cursor: null, data: [{ ...group, offers }] })).result
      ).toMatchObject({ operation: 'offer-groups-item-limit' })
    })
  })
})
