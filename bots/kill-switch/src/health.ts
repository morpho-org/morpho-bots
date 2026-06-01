export type HealthState = {
  ready: boolean
}

// Pure request router so the endpoints are testable without binding a port. Phase 1 ships stubs:
// /healthz = process is alive; /readyz = the bot has observed a block and is operating. The rich
// /status (and /status/near-misses) land in later phases (TIB Observability).
export function handleHealthRequest(request: Request, state: HealthState): Response {
  const { pathname } = new URL(request.url)
  if (pathname === '/healthz') {
    return Response.json({ status: 'ok' })
  }
  if (pathname === '/readyz') {
    if (!state.ready) return Response.json({ status: 'not_ready' }, { status: 503 })
    return Response.json({ status: 'ready' })
  }
  return Response.json({ status: 'not_found' }, { status: 404 })
}

type HealthServerParameters = {
  port: number
  getState: () => HealthState
}

// `getState` is a thunk so the server reflects live readiness (flipped once the loop sees a block).
export function startHealthServer({ port, getState }: HealthServerParameters) {
  return Bun.serve({ port, fetch: request => handleHealthRequest(request, getState()) })
}
