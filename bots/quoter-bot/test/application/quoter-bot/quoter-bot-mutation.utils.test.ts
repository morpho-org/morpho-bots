import { describe, expect, mock, test } from 'bun:test'

import type { BootstrapMakeService } from '../../../src/application/bootstrap/position-bootstrap.service'
import type { LadderMakeService } from '../../../src/application/ladder/ladder-market-maker.service'

import { serializeQuoterBotWrites } from '../../../src/application/quoter-bot/quoter-bot-mutation.utils'

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

describe('serializeQuoterBotWrites', () => {
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
    services.bootstrap.cleanup = mock(async () => {
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
    services.bootstrap.hardHalt = mock(
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
})
