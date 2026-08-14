import type { Hex } from 'viem'

import { describe, expect, test, vi } from 'vitest'

import type { BootstrapOffer } from '../../../src/domain/bootstrap/position-bootstrap'
import type { BootstrapCrossBookOffer } from '../../../src/infrastructure/bootstrap/bootstrap-cross-book.utils'

import { BootstrapAdapterError } from '../../../src/infrastructure/bootstrap/bootstrap-adapter.error'
import { resolveBootstrapProspectiveOffer } from '../../../src/infrastructure/bootstrap/bootstrap-cross-book.utils'

const marketId: Hex = `0x${'11'.repeat(32)}`
const otherMarketId: Hex = `0x${'22'.repeat(32)}`
const groupId: Hex = `0x${'33'.repeat(32)}`
const desiredOffer: BootstrapOffer = {
  marketId,
  assets: 100n,
  rateBps: 500n,
  referenceObservationId: 'test'
}

const sell = (tick: bigint, market = marketId): BootstrapCrossBookOffer => ({
  groupId,
  marketId: market,
  buy: false,
  tick
})

type Projection = Omit<BootstrapCrossBookOffer, 'marketId' | 'buy'>

const projector = (byCall: readonly Projection[]) => {
  let call = 0
  return vi.fn(async (offer: BootstrapOffer): Promise<BootstrapCrossBookOffer> => {
    const projection = byCall[call]
    call += 1
    if (!projection) throw new Error(`unexpected projection for ${offer.rateBps}`)
    return { marketId: offer.marketId, buy: true, ...projection }
  })
}

describe('resolveBootstrapProspectiveOffer', () => {
  test('returns the desired offer unchanged when nothing crosses', async () => {
    const toProspectiveBookOffer = projector([])
    const prospective = { marketId, buy: true, tick: 105n }

    expect(
      await resolveBootstrapProspectiveOffer({
        desiredOffer,
        prospective,
        replacedGroupIds: new Set(),
        book: [sell(110n)],
        toProspectiveBookOffer,
        minimumRateBps: 400n,
        maximumRateBps: 600n
      })
    ).toEqual({ offer: desiredOffer, prospective })
    expect(toProspectiveBookOffer).not.toHaveBeenCalled()
  })

  test('reprices a crossing buy the clearance above the highest-rate sell', async () => {
    const toProspectiveBookOffer = projector([
      { tick: 100n, tickSpacing: 1n, effectiveRateBps: 450n },
      { tick: 99n, tickSpacing: 1n }
    ])

    const resolved = await resolveBootstrapProspectiveOffer({
      desiredOffer,
      prospective: { marketId, buy: true, tick: 105n },
      replacedGroupIds: new Set(),
      book: [sell(100n), { marketId, buy: false, tick: 110n }],
      toProspectiveBookOffer,
      minimumRateBps: 400n,
      maximumRateBps: 600n
    })

    expect(resolved).toEqual({
      offer: { ...desiredOffer, rateBps: 460n },
      prospective: { marketId, buy: true, tick: 99n, tickSpacing: 1n }
    })
    expect(toProspectiveBookOffer).toHaveBeenNthCalledWith(1, desiredOffer, 100n)
    expect(toProspectiveBookOffer).toHaveBeenNthCalledWith(2, { ...desiredOffer, rateBps: 460n })
  })

  test('clamps the cleared rate at the configured maximum', async () => {
    const toProspectiveBookOffer = projector([
      { tick: 100n, tickSpacing: 1n, effectiveRateBps: 595n },
      { tick: 99n, tickSpacing: 1n }
    ])

    const resolved = await resolveBootstrapProspectiveOffer({
      desiredOffer,
      prospective: { marketId, buy: true, tick: 105n },
      replacedGroupIds: new Set(),
      book: [sell(100n)],
      toProspectiveBookOffer,
      minimumRateBps: 400n,
      maximumRateBps: 600n
    })

    expect(resolved?.offer.rateBps).toBe(600n)
  })

  test('steps one spacing below the sell when rounding rebounds onto its tick', async () => {
    const toProspectiveBookOffer = projector([
      { tick: 100n, tickSpacing: 1n, effectiveRateBps: 450n },
      { tick: 100n, tickSpacing: 1n },
      { tick: 99n, tickSpacing: 1n, effectiveRateBps: 455n },
      { tick: 99n, tickSpacing: 1n, effectiveRateBps: 455n }
    ])

    const resolved = await resolveBootstrapProspectiveOffer({
      desiredOffer,
      prospective: { marketId, buy: true, tick: 100n },
      replacedGroupIds: new Set(),
      book: [sell(100n)],
      toProspectiveBookOffer,
      minimumRateBps: 400n,
      maximumRateBps: 600n
    })

    expect(resolved).toEqual({
      offer: { ...desiredOffer, rateBps: 455n },
      prospective: { marketId, buy: true, tick: 99n, tickSpacing: 1n, effectiveRateBps: 455n }
    })
    expect(toProspectiveBookOffer).toHaveBeenNthCalledWith(
      3,
      { ...desiredOffer, rateBps: 460n },
      99n
    )
    expect(toProspectiveBookOffer).toHaveBeenNthCalledWith(
      4,
      { ...desiredOffer, rateBps: 455n },
      99n
    )
  })

  test('publishes nothing when the final exact-tick rate drifts beyond the hard bounds', async () => {
    const toProspectiveBookOffer = projector([
      { tick: 100n, tickSpacing: 1n, effectiveRateBps: 450n },
      { tick: 100n, tickSpacing: 1n },
      { tick: 99n, tickSpacing: 1n, effectiveRateBps: 600n },
      { tick: 99n, tickSpacing: 1n, effectiveRateBps: 601n }
    ])

    expect(
      await resolveBootstrapProspectiveOffer({
        desiredOffer,
        prospective: { marketId, buy: true, tick: 100n },
        replacedGroupIds: new Set(),
        book: [sell(100n)],
        toProspectiveBookOffer,
        minimumRateBps: 400n,
        maximumRateBps: 600n
      })
    ).toBeUndefined()
    expect(toProspectiveBookOffer).toHaveBeenCalledTimes(4)
  })

  test('publishes nothing when the sell already rests at the lowest protocol tick', async () => {
    const toProspectiveBookOffer = projector([
      { tick: 0n, tickSpacing: 1n, effectiveRateBps: 450n },
      { tick: 0n, tickSpacing: 1n }
    ])

    expect(
      await resolveBootstrapProspectiveOffer({
        desiredOffer,
        prospective: { marketId, buy: true, tick: 0n },
        replacedGroupIds: new Set(),
        book: [sell(0n)],
        toProspectiveBookOffer,
        minimumRateBps: 400n,
        maximumRateBps: 600n
      })
    ).toBeUndefined()
  })

  test('publishes nothing when the only clearing tick leaves the hard range', async () => {
    const toProspectiveBookOffer = projector([
      { tick: 100n, tickSpacing: 1n, effectiveRateBps: 450n },
      { tick: 100n, tickSpacing: 1n },
      { tick: 99n, tickSpacing: 1n, effectiveRateBps: 700n }
    ])

    expect(
      await resolveBootstrapProspectiveOffer({
        desiredOffer,
        prospective: { marketId, buy: true, tick: 100n },
        replacedGroupIds: new Set(),
        book: [sell(100n)],
        toProspectiveBookOffer,
        minimumRateBps: 400n,
        maximumRateBps: 600n
      })
    ).toBeUndefined()
  })

  test('ignores an unrelated retained crossing when the prospective buy clears every sell', async () => {
    const prospective = { marketId, buy: true, tick: 99n }

    expect(
      await resolveBootstrapProspectiveOffer({
        desiredOffer,
        prospective,
        replacedGroupIds: new Set(),
        book: [sell(100n), { marketId, buy: true, tick: 100n }],
        toProspectiveBookOffer: projector([]),
        minimumRateBps: 400n,
        maximumRateBps: 600n
      })
    ).toEqual({ offer: desiredOffer, prospective })
  })

  test('rejects a prospective projection that is not a selected-market buy', async () => {
    await expect(
      resolveBootstrapProspectiveOffer({
        desiredOffer,
        prospective: { marketId, buy: false, tick: 99n },
        replacedGroupIds: new Set(),
        book: [sell(100n)],
        toProspectiveBookOffer: projector([]),
        minimumRateBps: 400n,
        maximumRateBps: 600n
      })
    ).rejects.toMatchObject({ operation: 'negative-spread' })
  })

  test('rejects a crossing without effective-rate or spacing evidence', async () => {
    const missingRate = resolveBootstrapProspectiveOffer({
      desiredOffer,
      prospective: { marketId, buy: true, tick: 105n },
      replacedGroupIds: new Set(),
      book: [sell(100n)],
      toProspectiveBookOffer: projector([{ tick: 100n, tickSpacing: 1n }]),
      minimumRateBps: 400n,
      maximumRateBps: 600n
    })
    await expect(missingRate).rejects.toBeInstanceOf(BootstrapAdapterError)
    await expect(missingRate).rejects.toMatchObject({ operation: 'cross-book-evidence-missing' })

    const missingSpacing = resolveBootstrapProspectiveOffer({
      desiredOffer,
      prospective: { marketId, buy: true, tick: 105n },
      replacedGroupIds: new Set(),
      book: [sell(100n)],
      toProspectiveBookOffer: projector([{ tick: 100n, effectiveRateBps: 450n }, { tick: 100n }]),
      minimumRateBps: 400n,
      maximumRateBps: 600n
    })
    await expect(missingSpacing).rejects.toMatchObject({
      operation: 'cross-book-evidence-missing'
    })
  })

  test('ignores replaced groups and other markets when selecting the crossed sell', async () => {
    const replacedGroupId: Hex = `0x${'44'.repeat(32)}`
    const prospective = { marketId, buy: true, tick: 105n }

    expect(
      await resolveBootstrapProspectiveOffer({
        desiredOffer,
        prospective,
        replacedGroupIds: new Set([replacedGroupId]),
        book: [
          { groupId: replacedGroupId, marketId, buy: false, tick: 100n },
          sell(90n, otherMarketId),
          sell(110n)
        ],
        toProspectiveBookOffer: projector([]),
        minimumRateBps: 400n,
        maximumRateBps: 600n
      })
    ).toEqual({ offer: desiredOffer, prospective })
  })
})
