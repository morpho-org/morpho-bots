import type { Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import type {
  LadderMakeService,
  LadderPositionService,
  LadderReferenceRateService
} from '../../src/application/ladder-market-maker.service'
import type { LadderConfig, LadderMarketState, LadderQuoteSet } from '../../src/domain/ladder'

import { LadderMarketMakerService } from '../../src/application/ladder-market-maker.service'

const marketId: Hex = `0x${'55'.repeat(32)}`
const secondMarketId: Hex = `0x${'66'.repeat(32)}`
const config = (id = marketId): LadderConfig => ({
  marketId: id,
  quotePremiumBps: 0n,
  spreadBps: 200n,
  stepBps: 100n,
  rungCount: 3,
  sizeSkewBps: 0n,
  lowerRateBudgetAssets: 10n,
  higherRateBudgetAssets: 10n,
  targetMarketExposureAssets: 20n,
  maximumTotalExposureAssets: 20n,
  groupMode: 'shared-rung',
  loopIntervalSeconds: 3600,
  movementToleranceBps: 10n,
  minimumRateBps: 0n,
  maximumRateBps: 1_000n
})

const state = (capacity = 20n): LadderMarketState => ({
  lowerRateCapacityAssets: capacity,
  higherRateCapacityAssets: capacity,
  targetMarketCapacityAssets: capacity,
  maximumTotalCapacityAssets: capacity
})

const harness = (configs: readonly LadderConfig[] = [config()]) => {
  let rate = 500n
  let marketState = state()
  let readFailure: Hex | undefined
  const reads: string[] = []
  const reconciliations: Array<{
    marketId: Hex
    desired?: LadderQuoteSet
    reason: string
  }> = []
  const halts: string[] = []
  const positions: LadderPositionService = {
    async readMarket(id) {
      reads.push(`market:${id}`)
      if (id === readFailure) throw new TypeError('private provider detail')
      return marketState
    }
  }
  const rates: LadderReferenceRateService = {
    async readRate(id) {
      reads.push(`rate:${id}`)
      return rate
    }
  }
  const make: LadderMakeService = {
    async reconcile(parameters) {
      reconciliations.push(parameters)
    },
    async hardHalt(parameters) {
      halts.push(parameters.reason)
    }
  }
  let service = new LadderMarketMakerService(positions, rates, make, configs)
  return {
    get service() {
      return service
    },
    set service(value) {
      service = value
    },
    reads,
    reconciliations,
    halts,
    setRate: (value: bigint) => (rate = value),
    setCapacity: (value: bigint) => (marketState = state(value)),
    failMarket: (id: Hex) => (readFailure = id)
  }
}

describe('LadderMarketMakerService', () => {
  test('preflights every config before reading and hard-halts invalid configuration', async () => {
    const invalid = { ...config(secondMarketId), spreadBps: 201n }
    const subject = harness([config(), invalid])
    const result = await subject.service.runOnce()
    expect(subject.reads).toEqual([])
    expect(subject.halts).toEqual(['ladder-configuration-failed'])
    expect(result.at(-1)).toMatchObject({ status: 'halted', stage: 'configuration' })
  })

  test('publishes, rests unchanged, recenters, and resizes inside tolerance', async () => {
    const subject = harness()
    expect(await subject.service.runOnce()).toMatchObject([{ action: 'publish' }])
    expect(await subject.service.runOnce()).toMatchObject([{ action: 'rest' }])

    subject.setRate(511n)
    expect(await subject.service.runOnce()).toMatchObject([
      { action: 'replace', reason: 'recenter' }
    ])

    subject.setRate(510n)
    subject.setCapacity(5n)
    expect(await subject.service.runOnce()).toMatchObject([{ action: 'replace', reason: 'resize' }])
    expect(subject.reconciliations).toHaveLength(3)
  })

  test('invalidates one failed market read and continues other markets', async () => {
    const subject = harness([config(), config(secondMarketId)])
    subject.failMarket(marketId)
    const result = await subject.service.runOnce()
    expect(result).toMatchObject([
      { marketId, status: 'failed', invalidated: true },
      { marketId: secondMarketId, action: 'publish' }
    ])
    expect(subject.reconciliations[0]).toMatchObject({
      marketId,
      desired: undefined,
      reason: 'market-read-failed'
    })
  })

  test.each([
    ['reference read', 'reference-read-failed'],
    ['runtime bounds', 'ladder-decision-failed']
  ])('hard-halts on %s', async (failure, reason) => {
    const subject = harness()
    if (failure === 'reference read') {
      subject.service = new LadderMarketMakerService(
        {
          async readMarket() {
            return state()
          }
        },
        {
          async readRate() {
            throw new RangeError('private')
          }
        },
        {
          async reconcile() {},
          async hardHalt(parameters) {
            subject.halts.push(parameters.reason)
          }
        },
        [config()]
      )
    } else subject.setRate(801n)
    const result = await subject.service.runOnce()
    expect(subject.halts).toEqual([reason])
    expect(result).toMatchObject([{ status: 'halted' }])
  })
})
