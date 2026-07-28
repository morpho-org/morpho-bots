import type { Address, Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import { MidnightBootstrapPositionService } from '../../../src/infrastructure/bootstrap/bootstrap-position.service'

const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const marketId: Hex = `0x${'11'.repeat(32)}`
const firstGroup: Hex = `0x${'22'.repeat(32)}`
const secondGroup: Hex = `0x${'33'.repeat(32)}`

describe('MidnightBootstrapPositionService', () => {
  test('forces reconciliation when duplicate active groups exist for one market', async () => {
    const service = new MidnightBootstrapPositionService(
      {
        readPositions: async () => [{ marketId, credit: 10n, debt: 0n }],
        readCashBalance: async () => 100n,
        readActiveGroups: async () => [
          { id: firstGroup, marketId, assets: 20n, rateBps: 500n },
          { id: secondGroup, marketId, assets: 20n, rateBps: 500n }
        ]
      },
      maker
    )

    const position = await service.readPosition(marketId)

    expect(position.activeOffer).toBeUndefined()
    expect(position.marketExposure).toBe(50n)
  })
})
