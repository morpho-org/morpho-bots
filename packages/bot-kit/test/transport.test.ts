import { base } from 'viem/chains'
import { afterEach, describe, expect, it } from 'vitest'

import { createHttpTransport } from '../src/transport'

const PRIMARY = 'http://localhost:8545'
const FALLBACK = 'http://localhost:8546'

const realFetch = globalThis.fetch

/**
 * Replaces `fetch` with a JSON-RPC echo that answers both single and array bodies, and records every
 * request body — the only way batching is observable: viem keeps the `batch` option out of the
 * transport's `config`/`value`, so a construction-time assertion cannot see it.
 */
function captureFetch() {
  const bodies: string[] = []
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    bodies.push(init.body)
    const parsed: unknown = JSON.parse(init.body)
    const reply = (request: { id: number }) => ({ id: request.id, jsonrpc: '2.0', result: '0x1' })
    const payload = Array.isArray(parsed) ? parsed.map(reply) : reply(parsed as { id: number })
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      json: async () => payload,
      text: async () => JSON.stringify(payload)
    }
  }) as unknown as typeof fetch
  return bodies
}

const twoConcurrentReads = (transport: ReturnType<typeof createHttpTransport>) => {
  // Both branches of the return union expose `request`, but with incompatible signatures, so the
  // union is not callable without narrowing to the shared EIP-1193 shape.
  const { request } = transport({ chain: base }) as {
    request: (args: { method: string }) => Promise<unknown>
  }
  return Promise.all([request({ method: 'eth_blockNumber' }), request({ method: 'eth_chainId' })])
}

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('createHttpTransport', () => {
  it('sends one request per call by default', async () => {
    const bodies = captureFetch()
    await twoConcurrentReads(createHttpTransport(PRIMARY))
    expect(bodies).toHaveLength(2)
    expect(JSON.parse(bodies[0]!)).toMatchObject({ method: 'eth_blockNumber' })
  })

  it('coalesces concurrent calls into one request when batch is enabled', async () => {
    const bodies = captureFetch()
    await twoConcurrentReads(createHttpTransport(PRIMARY, undefined, { batch: true }))
    expect(bodies).toHaveLength(1)
    expect(JSON.parse(bodies[0]!)).toMatchObject([
      { method: 'eth_blockNumber' },
      { method: 'eth_chainId' }
    ])
  })

  it('batches through the failover pair too', async () => {
    const bodies = captureFetch()
    await twoConcurrentReads(createHttpTransport(PRIMARY, FALLBACK, { batch: true }))
    expect(bodies).toHaveLength(1)
  })

  it('leaves the failover pair unbatched when batch is not requested', async () => {
    const bodies = captureFetch()
    await twoConcurrentReads(createHttpTransport(PRIMARY, FALLBACK))
    expect(bodies).toHaveLength(2)
  })
})
