import type { Address, Hex } from 'viem'

import { base } from 'viem/chains'
import { describe, expect, test } from 'vitest'

import { readLadderGroups } from '../../../src/infrastructure/ladder/ladder-groups.utils'

const groupId: Hex = `0x${'11'.repeat(32)}`
const marketId: Hex = `0x${'22'.repeat(32)}`
const maker: Address = `0x${'33'.repeat(20)}`

describe('readLadderGroups', () => {
  test('reads and parses a successful Router group response', async () => {
    const urls: string[] = []
    const groups = await readLadderGroups({
      baseUrl: 'https://router.invalid',
      chainId: base.id,
      maker,
      timeoutMs: 1_000,
      request: async url => {
        urls.push(url)
        return {
          data: [
            {
              id: groupId,
              chain_id: 8453,
              consumed: '2',
              max_assets: '10',
              max_units: '0',
              offers: [
                {
                  market_id: marketId,
                  maker,
                  buy: true,
                  tick: 123,
                  market: { maturity: 456 }
                }
              ]
            }
          ],
          cursor: null
        }
      }
    })

    expect(groups).toEqual([
      {
        id: groupId,
        consumed: 2n,
        maxAssets: 10n,
        maxUnits: 0n,
        offers: [{ marketId, maker, buy: true, tick: 123n, maturity: 456n }]
      }
    ])
    expect(urls).toEqual([
      `https://router.invalid/v0/midnight/users/${maker}/offer-groups?chain_ids=8453&limit=100`
    ])
  })

  test('rejects a malformed Router group response', async () => {
    await expect(
      readLadderGroups({
        baseUrl: 'https://router.invalid',
        chainId: base.id,
        maker,
        timeoutMs: 1_000,
        request: async () => ({ data: [], cursor: '' })
      })
    ).rejects.toMatchObject({
      name: 'LadderAdapterError',
      operation: 'offer-groups-response'
    })
  })
})
