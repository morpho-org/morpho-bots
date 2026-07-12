import { describe, expect, it } from 'bun:test'

import { botsHome, queuedLockFile, queuedSocketFile } from '../src/home'

describe('per-chain queue daemon paths', () => {
  const home = '/tmp/morpho-bots'

  it('namespaces the socket, lock, and outcomes journal by chain id only (never by bot)', () => {
    expect(queuedSocketFile(home, '8453')).toBe('/tmp/morpho-bots/queued-8453.sock')
    expect(queuedLockFile(home, '8453')).toBe('/tmp/morpho-bots/locks/queued-8453.lock')
  })

  it('keeps the socket directly under home so the sun_path stays short', () => {
    // The socket must sit at the home root (not a nested dir) — the OS caps sun_path at ~104 bytes.
    const socket = queuedSocketFile(botsHome({ MORPHO_BOTS_HOME: home }), '1')
    expect(socket).toBe('/tmp/morpho-bots/queued-1.sock')
  })
})
