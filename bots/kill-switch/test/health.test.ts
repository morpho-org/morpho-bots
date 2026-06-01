import { afterAll, beforeAll, describe, expect, it } from 'bun:test'

import type { HealthState } from '../src/health'

import { handleHealthRequest, startHealthServer } from '../src/health'

const route = (path: string, ready: boolean) =>
  handleHealthRequest(new Request(`http://localhost${path}`), { ready })

describe('handleHealthRequest', () => {
  it('returns 200 ok for /healthz regardless of readiness', async () => {
    const res = route('/healthz', false)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('returns 200 ready for /readyz when ready', async () => {
    const res = route('/readyz', true)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ready' })
  })

  it('returns 503 not_ready for /readyz when not ready', async () => {
    const res = route('/readyz', false)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'not_ready' })
  })

  it('returns 404 for an unknown route', () => {
    expect(route('/nope', true).status).toBe(404)
  })
})

describe('startHealthServer', () => {
  const state: HealthState = { ready: false }
  let server: ReturnType<typeof startHealthServer>

  beforeAll(() => {
    server = startHealthServer({ port: 0, getState: () => state })
  })
  afterAll(() => server.stop())

  it('serves over HTTP and reflects live readiness on /readyz', async () => {
    const base = `http://localhost:${server.port}`
    expect((await fetch(`${base}/healthz`)).status).toBe(200)
    expect((await fetch(`${base}/readyz`)).status).toBe(503)
    state.ready = true
    expect((await fetch(`${base}/readyz`)).status).toBe(200)
  })
})
