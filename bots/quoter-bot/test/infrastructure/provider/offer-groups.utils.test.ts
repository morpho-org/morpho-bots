import type { Address, Hex } from 'viem'

import { MAX_OFFER_CAP } from '@morpho-org/midnight-sdk'
import { base } from 'viem/chains'
import { describe, expect, test } from 'vitest'

import { LadderAdapterError } from '../../../src/infrastructure/ladder/ladder-adapter.error'
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
})
