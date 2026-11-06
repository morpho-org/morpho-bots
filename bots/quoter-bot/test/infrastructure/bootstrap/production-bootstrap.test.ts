import type { Address, Hex } from 'viem'

import { TickLib, type IMarketParams } from '@morpho-org/midnight-sdk'
import { MathLib } from '@morpho-org/morpho-ts'
import { base } from 'viem/chains'
import { describe, expect, test } from 'vitest'

import { BootstrapAdapterError } from '../../../src/errors'
import {
  bootstrapBookOffers,
  bootstrapGroupRateBps,
  strategyBootstrapGroups
} from '../../../src/infrastructure/bootstrap/bootstrap-groups.utils'
import {
  bootstrapContinuousFeeCap,
  createBootstrapOffer
} from '../../../src/infrastructure/bootstrap/bootstrap-offer.utils'
import { bootstrapLoanAssets } from '../../../src/infrastructure/bootstrap/production-bootstrap'
import { readMakerOfferGroups } from '../../../src/infrastructure/provider/offer-groups.utils'

const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const marketId: Hex = `0x${'ab'.repeat(32)}`
const secondMarketId: Hex = `0x${'12'.repeat(32)}`
const groupId: Hex = `0x${'cd'.repeat(32)}`
const collateral: Address = '0x1111111111111111111111111111111111111111'
const loanToken: Address = '0x2222222222222222222222222222222222222222'
const oracle: Address = '0x3333333333333333333333333333333333333333'
const ratifier: Address = '0x800B5F12A61B8198a5a6EfD794Cac6699B294d63'
const publicationMarket: IMarketParams = {
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
}

const group = (overrides: Record<string, unknown> = {}) => ({
  id: groupId,
  chain_id: 8453,
  consumed: '0',
  max_assets: '100',
  max_units: '0',
  offers: [
    {
      market_id: marketId,
      maker,
      buy: true,
      tick: 100,
      continuous_fee_cap: '0',
      market: { maturity: 2_000 }
    }
  ],
  ...overrides
})

describe('bootstrapGroupRateBps', () => {
  test('annualizes the resting tick of a group whose market still has a remaining term', () => {
    expect(bootstrapGroupRateBps({ tick: 100n, maturity: 2_000n, observedTimestamp: 1_000n })).toBe(
      TickLib.tickToApr(100n, 1_000n) / (10n ** 18n / 10_000n)
    )
  })

  test.each([
    ['matured', 1_000n],
    ['maturing exactly at the observed block', 2_000n]
  ])('projects a %s indexed group without persisted intent as a zero rate', (_label, maturity) => {
    expect(() => TickLib.tickToApr(100n, maturity - 2_000n)).toThrow()
    expect(bootstrapGroupRateBps({ tick: 100n, maturity, observedTimestamp: 2_000n })).toBe(0n)
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

describe('createBootstrapOffer', () => {
  test('uses the current block time to prevent reuse of a consumed group', () => {
    const market = {
      params: publicationMarket,
      tickSpacing: 4,
      continuousFee: 0
    }
    const offer = {
      marketId,
      assets: 100n,
      rateBps: 500n,
      referenceObservationId: 'hour:1'
    }

    const first = createBootstrapOffer({ offer, market, maker, ratifier, now: 1_000n })
    const second = createBootstrapOffer({ offer, market, maker, ratifier, now: 1_001n })

    expect(first.tick).toBe(second.tick)
    expect(first.start).toBe(1_000n)
    expect(second.start).toBe(1_001n)
    expect(first.group).not.toBe(second.group)
  })
})

describe('bootstrap group projections', () => {
  test('excludes durably owned sell-only groups from the loan-token cash reserve', async () => {
    const secondGroupId: Hex = `0x${'ef'.repeat(32)}`
    const sellOnly = { ...group().offers[0], buy: false }
    const groups = await readMakerOfferGroups(
      { adapterError: BootstrapAdapterError, chainId: base.id, maker, requestTimeoutMs: 1_000 },
      {
        request: async () => ({
          data: [
            group({ max_assets: '125', offers: [] }),
            group({ id: secondGroupId, max_assets: '75', offers: [sellOnly] })
          ],
          cursor: null
        })
      }
    )

    expect(strategyBootstrapGroups(groups, [groupId, secondGroupId])).toEqual([])
  })

  test('reserves an offer by the cash its units can spend at its tick, never zero', () => {
    const tick = 5_000n
    const price = TickLib.tickToPrice(tick)

    expect(bootstrapLoanAssets(1_000_000n, tick)).toBe(
      MathLib.mulDiv(1_000_000n, price, MathLib.WAD, 'Up')
    )
    expect(bootstrapLoanAssets(1n, tick)).toBe(1n)
    expect(bootstrapLoanAssets(1_000_000n, 0n)).toBe(1n)
  })

  test('flattens multi-market group projections without quadratic offer expansion', async () => {
    const offers = Array.from({ length: 1_000 }, (_, index) => ({
      ...group().offers[0],
      market_id: `0x${index.toString(16).padStart(64, '0')}`,
      tick: index,
      market: { maturity: 3_000 + index }
    }))
    const groups = await readMakerOfferGroups(
      { adapterError: BootstrapAdapterError, chainId: base.id, maker, requestTimeoutMs: 1_000 },
      { request: async () => ({ data: [group({ offers })], cursor: null }) }
    )

    expect(groups).toHaveLength(1_000)
    expect(bootstrapBookOffers(groups)).toHaveLength(1_000)
  })

  test('excludes fully consumed groups from the spread-book projection', async () => {
    const activeGroupId: Hex = `0x${'ef'.repeat(32)}`
    const groups = await readMakerOfferGroups(
      { adapterError: BootstrapAdapterError, chainId: base.id, maker, requestTimeoutMs: 1_000 },
      {
        request: async () => ({
          data: [group({ consumed: '100' }), group({ id: activeGroupId, consumed: '99' })],
          cursor: null
        })
      }
    )

    expect(bootstrapBookOffers(groups).map(offer => offer.groupId)).toEqual([activeGroupId])
  })

  test('filters cleanup tombstones from the spread-book projection', async () => {
    const ignoredGroupId: Hex = `0x${'ef'.repeat(32)}`
    const groups = await readMakerOfferGroups(
      { adapterError: BootstrapAdapterError, chainId: base.id, maker, requestTimeoutMs: 1_000 },
      {
        request: async () => ({
          data: [group(), group({ id: ignoredGroupId })],
          cursor: null
        })
      }
    )

    expect(bootstrapBookOffers(groups, [ignoredGroupId]).map(offer => offer.groupId)).toEqual([
      groupId
    ])
  })

  test('derives ownership only from explicit durable group IDs', async () => {
    const unrelatedGroupId: Hex = `0x${'ef'.repeat(32)}`
    const groups = await readMakerOfferGroups(
      { adapterError: BootstrapAdapterError, chainId: base.id, maker, requestTimeoutMs: 1_000 },
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
    const groups = await readMakerOfferGroups(
      { adapterError: BootstrapAdapterError, chainId: base.id, maker, requestTimeoutMs: 1_000 },
      {
        request: async () => ({
          data: [group({ offers: [...group().offers, secondOffer] })],
          cursor: null
        })
      }
    )

    expect(strategyBootstrapGroups(groups, [groupId])).toEqual([
      expect.objectContaining({
        id: groupId,
        marketId,
        tick: 100n,
        maturity: 2_000n,
        continuousFeeCap: 0n
      }),
      expect.objectContaining({
        id: groupId,
        marketId: secondMarketId,
        tick: 200n,
        maturity: 3_000n
      })
    ])
  })
})
