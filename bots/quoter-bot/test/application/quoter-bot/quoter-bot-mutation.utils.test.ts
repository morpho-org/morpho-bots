import { describe, expect, test, vi } from 'vitest'

import type { BootstrapMakeService } from '../../../src/application/bootstrap/position-bootstrap.service'
import type { LadderMakeService } from '../../../src/application/ladder/ladder-quoter.service'

import { serializeQuoterBotWrites } from '../../../src/application/quoter-bot/quoter-bot-mutation.utils'

const marketId = `0x${'11'.repeat(32)}` as const

const createServices = (events: string[]) => {
  const bootstrap: BootstrapMakeService = {
    reconcile: vi.fn(async () => {
      events.push('bootstrap:reconcile')
    }),
    hardHalt: vi.fn(async () => {
      events.push('bootstrap:halt')
    }),
    cleanup: vi.fn(async () => {
      events.push('bootstrap:cleanup')
    })
  }
  const ladder: LadderMakeService = {
    readActive: vi.fn(async () => {
      events.push('ladder:read')
      return undefined
    }),
    reconcile: vi.fn(async () => {
      events.push('ladder:reconcile')
    }),
    hardHalt: vi.fn(async () => {
      events.push('ladder:halt')
    }),
    cleanup: vi.fn(async () => {
      events.push('ladder:cleanup')
    })
  }
  return { bootstrap, ladder }
}

describe('serializeQuoterBotWrites', () => {
  test('serializes bootstrap previews with publication mutations', async () => {
    const events: string[] = []
    let releaseReconcile: (() => void) | undefined
    const services = createServices(events)
    const desiredOffer = {
      marketId,
      assets: 200n,
      rateBps: 450n,
      referenceObservationId: 'static:500'
    }
    services.bootstrap.reconcile = vi.fn(
      () =>
        new Promise<void>(resolve => {
          events.push('bootstrap:reconcile:start')
          releaseReconcile = resolve
        })
    )
    services.bootstrap.preview = vi.fn(async () => {
      events.push('bootstrap:preview')
      return desiredOffer
    })
    const serialized = serializeQuoterBotWrites(services)

    const reconcile = serialized.bootstrap.reconcile({ marketId, reason: 'publish' })
    const preview = serialized.bootstrap.preview?.({
      marketId,
      desiredOffer,
      minimumRateBps: 200n,
      maximumRateBps: 800n
    })
    await Promise.resolve()

    expect(events).toEqual(['bootstrap:reconcile:start'])
    releaseReconcile?.()
    await expect(preview).resolves.toEqual(desiredOffer)
    await reconcile
    expect(events).toEqual(['bootstrap:reconcile:start', 'bootstrap:preview'])
  })

  test('serializes bootstrap and ladder mutations through one queue', async () => {
    const events: string[] = []
    let releaseBootstrap: (() => void) | undefined
    const services = createServices(events)
    services.bootstrap.reconcile = vi.fn(
      () =>
        new Promise<void>(resolve => {
          events.push('bootstrap:start')
          releaseBootstrap = resolve
        })
    )
    const serialized = serializeQuoterBotWrites(services)

    const bootstrapWrite = serialized.bootstrap.reconcile({ marketId, reason: 'publish' })
    const ladderWrite = serialized.ladder.cleanup()
    await Promise.resolve()

    expect(events).toEqual(['bootstrap:start'])
    releaseBootstrap?.()
    await Promise.all([bootstrapWrite, ladderWrite])
    expect(events).toEqual(['bootstrap:start', 'ladder:cleanup'])
  })

  test('continues draining mutations after a preceding operation rejects', async () => {
    const events: string[] = []
    const services = createServices(events)
    services.bootstrap.cleanup = vi.fn(async () => {
      events.push('bootstrap:failed')
      throw new TypeError('publication failed')
    })
    const serialized = serializeQuoterBotWrites(services)

    const failed = serialized.bootstrap.cleanup().catch(error => error)
    const following = serialized.ladder.hardHalt({ reason: 'ladder-configuration-failed' })

    expect(await failed).toBeInstanceOf(TypeError)
    await following
    expect(events).toEqual(['bootstrap:failed', 'ladder:halt'])
  })

  test('keeps ladder active-state reads outside the mutation queue', async () => {
    const events: string[] = []
    let releaseBootstrap: (() => void) | undefined
    const services = createServices(events)
    services.bootstrap.hardHalt = vi.fn(
      () =>
        new Promise<void>(resolve => {
          events.push('bootstrap:start')
          releaseBootstrap = resolve
        })
    )
    const serialized = serializeQuoterBotWrites(services)

    const mutation = serialized.bootstrap.hardHalt({ reason: 'reference-read-failed' })
    await Promise.resolve()
    await serialized.ladder.readActive(marketId)

    expect(events).toEqual(['bootstrap:start', 'ladder:read'])
    releaseBootstrap?.()
    await mutation
  })

  test('forwards removed-market cleanup through the shared mutation queue', async () => {
    const events: string[] = []
    let releaseBootstrap: (() => void) | undefined
    const services = createServices(events)
    services.bootstrap.reconcile = vi.fn(
      () =>
        new Promise<void>(resolve => {
          events.push('bootstrap:start')
          releaseBootstrap = resolve
        })
    )
    services.ladder.cleanupRemovedMarkets = vi.fn(async () => {
      events.push('ladder:cleanup-removed')
    })
    const serialized = serializeQuoterBotWrites(services)

    const mutation = serialized.bootstrap.reconcile({ marketId, reason: 'publish' })
    const cleanup = serialized.ladder.cleanupRemovedMarkets?.()
    await Promise.resolve()

    expect(events).toEqual(['bootstrap:start'])
    releaseBootstrap?.()
    await Promise.all([mutation, cleanup])
    expect(events).toEqual(['bootstrap:start', 'ladder:cleanup-removed'])
  })
})
