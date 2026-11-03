import type { Graph } from '@repo/engine'

import { layoutOf } from '@repo/engine/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { routeKeyOf } from '../../src/liquidation'
import { ROUTE_MAX_AGE_MS } from '../../src/routes'
import { collateralAt, LOAN } from './bot'

const built: Graph[] = []
vi.mock('@repo/engine', async importOriginal => {
  const actual = await importOriginal<typeof import('@repo/engine')>()
  return {
    ...actual,
    createRunner: (graph: Graph, options: never) => {
      built.push(graph)
      return actual.createRunner(graph, options)
    }
  }
})

const { startBot } = await import('./bot')

const bots: Awaited<ReturnType<typeof startBot>>[] = []
afterEach(async () => {
  for (const bot of bots.splice(0)) await bot.shutdown()
})

describe('route resolution', () => {
  it('applies only the resolution that answers its route’s outstanding request', async () => {
    bots.push(await startBot({ routeCostBps: () => 0 }))
    const fold = layoutOf(built.at(-1)!).operators.find(op => op.id === 'routes.resolving')!
    if (fold.kind !== 'fold') throw new Error('missing the routes.resolving fold')
    const route = routeKeyOf(collateralAt(0), LOAN)
    const pair = { collateral: collateralAt(0), loan: LOAN }
    const state = {
      inputs: {},
      outstanding: { [route]: { id: 5, at: 100 } },
      issued: 6,
      read: false
    }
    const resolve = (id: number) =>
      fold.applyInput(state, {
        from: 'resolution',
        value: { id, key: route, pair },
        stamp: { seq: 0, at: 200 }
      })

    const stale = resolve(4)
    expect(stale.state).toBe(state)
    expect(stale.emit ?? []).toStrictEqual([])

    const answered = resolve(5)
    expect(answered.state).toMatchObject({ outstanding: {} })
    expect(answered.emit?.map(emit => emit.value)).toStrictEqual([
      {
        coverage: 'carried',
        entries: { [route]: { pair, resolvedAt: 100 } },
        basis: { route },
        expiry: 100 + ROUTE_MAX_AGE_MS
      }
    ])
  })
})
