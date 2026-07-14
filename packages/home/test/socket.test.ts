import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ConfigError } from '../src/config'
import { probeStaleSocket } from '../src/socket'

function tempSocket() {
  return join(mkdtempSync(join(tmpdir(), 'morpho-bots-test-')), 'daemon.sock')
}

// Covers the safety-critical REFUSE path: a live listener must block a second bind. The
// resolve/steal path (absent or stale socket → clear & rebind) rides on a socket `error` event,
// which the daemons exercise end-to-end in apps/queued/test/spawn.test.ts; asserting it here would
// only re-test the same behavior while tangling with bun:test's socket-error handling.
describe('probeStaleSocket', () => {
  let server: Server | undefined

  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    server = undefined
  })

  it('rejects with a labeled ConfigError when a daemon is already listening', async () => {
    const path = tempSocket()
    server = createServer()
    await new Promise<void>(resolve => server!.listen(path, resolve))

    const error = await probeStaleSocket(path, { label: 'a signer' }).catch(e => e)
    // The queue/signer startup maps ConfigError → exit 2, so the type matters, not just the message.
    expect(error).toBeInstanceOf(ConfigError)
    expect((error as ConfigError).message).toBe(`a signer is already listening on ${path}`)
  })
})
