import { describe, expect, mock, test } from 'bun:test'

import type { BootstrapMakeService } from '../../../src/application/bootstrap/position-bootstrap.service'
import type { LadderMakeService } from '../../../src/application/ladder/ladder-market-maker.service'

import { serializeMarketMakingWrites } from '../../../src/application/market-making/market-making-mutation.utils'

const marketId = `0x${'11'.repeat(32)}` as const

const createServices = (events: string[]) => {
  const bootstrap: BootstrapMakeService = {
    reconcile: mock(async () => {
      events.push('bootstrap:reconcile')
    }),
    hardHalt: mock(async () => {
      events.push('bootstrap:halt')
    }),
    cleanup: mock(async () => {
      events.push('bootstrap:cleanup')
    })
  }
  const ladder: LadderMakeService = {
    readActive: mock(async () => {
      events.push('ladder:read')
      return undefined
    }),
    reconcile: mock(async () => {
      events.push('ladder:reconcile')
    }),
    hardHalt: mock(async () => {
      events.push('ladder:halt')
    }),
    cleanup: mock(async () => {
      events.push('ladder:cleanup')
    })
  }
  return { bootstrap, ladder }
}

describe('serializeMarketMakingWrites', () => {
  test('serializes bootstrap and ladder mutations through one queue', async () => {
    const events: string[] = []
    let releaseBootstrap: (() => void) | undefined
    const services = createServices(events)
    services.bootstrap.reconcile = mock(
      () =>
        new Promise<void>(resolve => {
          events.push('bootstrap:start')
          releaseBootstrap = resolve
        })
    )
    const serialized = serializeMarketMakingWrites(services)

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
    services.bootstrap.cleanup = mock(async () => {
      events.push('bootstrap:failed')
      throw new TypeError('publication failed')
    })
    const serialized = serializeMarketMakingWrites(services)

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
    services.bootstrap.hardHalt = mock(
      () =>
        new Promise<void>(resolve => {
          events.push('bootstrap:start')
          releaseBootstrap = resolve
        })
    )
    const serialized = serializeMarketMakingWrites(services)

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
    services.bootstrap.reconcile = mock(
      () =>
        new Promise<void>(resolve => {
          events.push('bootstrap:start')
          releaseBootstrap = resolve
        })
    )
    services.ladder.cleanupRemovedMarkets = mock(async () => {
      events.push('ladder:cleanup-removed')
    })
    const serialized = serializeMarketMakingWrites(services)

    const mutation = serialized.bootstrap.reconcile({ marketId, reason: 'publish' })
    const cleanup = serialized.ladder.cleanupRemovedMarkets?.()
    await Promise.resolve()

    expect(events).toEqual(['bootstrap:start'])
    releaseBootstrap?.()
    await Promise.all([mutation, cleanup])
    expect(events).toEqual(['bootstrap:start', 'ladder:cleanup-removed'])
  })
})
