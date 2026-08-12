import type { Address, Hex } from 'viem'

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import type { LadderQuoteSet } from '../../../src/domain/ladder/ladder'

import { createLadderGroupOwnership } from '../../../src/infrastructure/ladder/ladder-group-ownership.utils'

const maker: Address = '0x1111111111111111111111111111111111111111'
const marketId: Hex = `0x${'22'.repeat(32)}`
const lowerGroup: Hex = `0x${'33'.repeat(32)}`
const higherGroup: Hex = `0x${'44'.repeat(32)}`
const quote: LadderQuoteSet = {
  marketId,
  centerRateBps: 500n,
  groupMode: 'shared-rung',
  lower: [{ index: 0, rateBps: 450n, assets: 10n }],
  higher: [{ index: 0, rateBps: 550n, assets: 20n }]
}

describe('createLadderGroupOwnership', () => {
  test('persists ownership keyed only by maker and ladder strategy markets', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'ladder-ownership-'))
    try {
      const ownership = createLadderGroupOwnership(
        { maker, strategyMarketIds: [marketId] },
        { stateDirectory }
      )
      await ownership.reserve({
        marketId,
        quote,
        groups: [
          { groupId: lowerGroup, side: 'lower', rungIndexes: [0] },
          { groupId: higherGroup, side: 'higher', rungIndexes: [0] }
        ]
      })

      expect(await ownership.readGroupIds()).toEqual([lowerGroup, higherGroup])
      expect(await ownership.read()).toMatchObject([{ marketId, status: 'reserved', quote }])

      await ownership.confirm([lowerGroup, higherGroup])
      expect(await ownership.read()).toMatchObject([{ status: 'confirmed' }])

      const ownershipAfterUnrelatedAllowlistEdit = createLadderGroupOwnership(
        { maker, strategyMarketIds: [marketId] },
        { stateDirectory }
      )
      expect(await ownershipAfterUnrelatedAllowlistEdit.readGroupIds()).toEqual([
        lowerGroup,
        higherGroup
      ])

      await ownership.forget([lowerGroup])
      expect(await ownership.readGroupIds()).toEqual([higherGroup])
      await ownership.forget([higherGroup])
      expect(await ownership.read()).toEqual([])
    } finally {
      await rm(stateDirectory, { recursive: true })
    }
  })
})
