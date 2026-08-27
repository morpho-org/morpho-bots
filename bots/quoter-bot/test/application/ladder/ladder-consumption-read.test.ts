import { describe, expect, test, vi } from 'vitest'

import type {
  LadderMakeService,
  LadderPositionService,
  LadderReferenceRateService
} from '../../../src/application/ladder/ladder-quoter.service'
import type { LadderConfig } from '../../../src/domain/ladder/ladder'

import { LadderQuoterService } from '../../../src/application/ladder/ladder-quoter.service'

const marketId = `0x${'11'.repeat(32)}` as const
const groupId = `0x${'22'.repeat(32)}` as const

const config = (): LadderConfig => ({
  marketId,
  quotePremiumBps: 0n,
  spreadBps: 100n,
  stepBps: 50n,
  rungCount: 1,
  sizeSkewBps: 0n,
  lowerRateBudgetAssets: 1_000n,
  higherRateBudgetAssets: 1_000n,
  targetMarketExposureAssets: 10_000n,
  maximumTotalExposureAssets: 10_000n,
  minimumOfferAssets: 100n,
  groupMode: 'shared-rung',
  loopIntervalSeconds: 1,
  movementToleranceBps: 0n,
  minimumRateBps: 100n,
  maximumRateBps: 5_000n
})

const consumption = [
  {
    groupId,
    marketId,
    side: 'higher' as const,
    groupRateBps: 550n,
    maxAssets: 1_000n,
    consumed: 40n,
    remainingAssets: 960n
  }
]

describe('ladder consumption sampling', () => {
  test('takes the quote and its consumption from one adapter read', async () => {
    const readActiveState = vi.fn(async () => ({ consumption }))
    const readActive = vi.fn(async () => undefined)
    const reconcile = vi.fn(async () => undefined)
    const positions: LadderPositionService = { readMarket: async () => ({}) }
    const rates: LadderReferenceRateService = { readRate: async () => 500n }
    const make = {
      readActive,
      readActiveState,
      reconcile,
      hardHalt: async () => undefined,
      cleanup: async () => undefined
    } as unknown as LadderMakeService

    const results = await new LadderQuoterService(positions, rates, make, [config()]).runOnce({
      verbose: true
    })

    // One combined read backs the pre-decision quote and its consumption; the only other call is
    // the post-check after-state read, which consumption never adds to.
    expect(readActiveState).toHaveBeenCalledTimes(1)
    expect(readActive).toHaveBeenCalledTimes(1)
    expect(results[0]?.verbose?.groupConsumption).toEqual(consumption)
  })

  test('samples consumption before reconciliation forgets a replaced group', async () => {
    const order: string[] = []
    const positions: LadderPositionService = { readMarket: async () => ({}) }
    const rates: LadderReferenceRateService = { readRate: async () => 500n }
    const make = {
      readActive: async () => undefined,
      readActiveState: async () => {
        order.push('sample')
        return { consumption }
      },
      reconcile: async () => {
        order.push('reconcile')
        return undefined
      },
      hardHalt: async () => undefined,
      cleanup: async () => undefined
    } as unknown as LadderMakeService

    await new LadderQuoterService(positions, rates, make, [config()]).runOnce({ verbose: true })

    expect(order).toEqual(['sample', 'reconcile'])
  })
})
