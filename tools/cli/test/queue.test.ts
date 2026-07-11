import type { QueuedErrorCode } from '@repo/bot-kit'

import {
  errorResponse,
  ingestRecord,
  okResponse,
  parseRequestLine,
  QueuedProtocolError,
  serializeResponse
} from '@repo/bot-kit'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runQueueCommand } from '../src/commands/queue'

const CLI_DIR = join(import.meta.dir, '..')
const SPAWN_TIMEOUT_MS = 30_000

// A minimal in-process daemon speaking the shared `@repo/bot-kit` protocol (no `services/queued`
// import — the CLI side stands up its own stub). `ping` pongs, `status` reports the configured chain,
// `ingest` records the record and returns a `submitted` ack. It never signs or reaches a chain, so it
// is enough to exercise the thin client's handshake + relay + exit-code contract end-to-end.
type Stub = { socketPath: string; received: Record<string, unknown>[]; close: () => Promise<void> }

function makeOutcome(record: Record<string, unknown>): Record<string, unknown> {
  return {
    v: 1,
    kind: 'outcome',
    id: record.id,
    domain: record.domain,
    op: record.op ?? 'liquidate',
    chainId: record.chainId,
    at: new Date().toISOString(),
    summary: `${String(record.domain)} queue submitted`,
    status: 'submitted'
  }
}

function startStub(opts: {
  chainId: number
  // Error mode: when this returns a code for an ingested record, the stub answers with that
  // `errorResponse` instead of a `submitted` ack (the record never lands in `received`), letting a
  // test exercise the thin client's per-record warn+skip (`bad_request`) vs break-the-batch (`retry`).
  ingestError?: (
    record: Record<string, unknown>
  ) => { code: QueuedErrorCode; message: string } | undefined
}): Promise<Stub> {
  const received: Record<string, unknown>[] = []
  const dir = mkdtempSync(join(tmpdir(), 'q-stub-'))
  const socketPath = join(dir, 'q.sock')

  const handle = (line: string): string => {
    let id = ''
    try {
      const request = parseRequestLine(line)
      id = request.id
      if (request.method === 'ping') return serializeResponse(okResponse(id, { pong: true }))
      if (request.method === 'status') {
        return serializeResponse(
          okResponse(id, {
            chainId: opts.chainId,
            address: null,
            armed: false,
            pending: 0,
            wireVersion: 1
          })
        )
      }
      const record = ingestRecord(request.params, id) as Record<string, unknown>
      const forced = opts.ingestError?.(record)
      if (forced) return serializeResponse(errorResponse(id, forced.code, forced.message))
      received.push(record)
      return serializeResponse(okResponse(id, { outcome: makeOutcome(record) }))
    } catch (error) {
      if (error instanceof QueuedProtocolError) {
        return serializeResponse(errorResponse(error.id ?? id, error.code, error.message))
      }
      return serializeResponse(errorResponse(id, 'internal', 'stub error'))
    }
  }

  const server = createServer(socket => {
    let buffer = ''
    socket.on('error', () => {})
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      let idx = buffer.indexOf('\n')
      while (idx !== -1) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (line.trim() !== '') socket.write(handle(line))
        idx = buffer.indexOf('\n')
      }
    })
  })

  return new Promise<Stub>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () =>
      resolve({
        socketPath,
        received,
        close: () =>
          new Promise<void>(res =>
            server.close(() => {
              rmSync(dir, { recursive: true, force: true })
              res()
            })
          )
      })
    )
  })
}

const txRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  kind: 'tx',
  id: 'blue:liquidate:0xborrower',
  domain: 'blue',
  op: 'liquidate',
  chainId: 8453,
  at: new Date().toISOString(),
  summary: 'blue liquidate',
  to: `0x${'22'.repeat(20)}`,
  data: '0x',
  ...overrides
})

// Spawn the real CLI ASYNC (not spawnSync): the stub listens on THIS process's event loop, so a
// synchronous spawn would block it and the cross-process handshake would deadlock. stdin is piped so
// the thin client sees a non-TTY stream (the ingest path, not the ping path).
async function runCli(
  args: string[],
  input: string,
  env: Record<string, string>
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'src/main.ts', ...args], {
    cwd: CLI_DIR,
    env: { ...process.env, MORPHO_BOTS_HOME: mkdtempSync(join(tmpdir(), 'q-cli-')), ...env },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  void proc.stdin.write(input)
  await proc.stdin.end()
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ])
  return { code, stdout, stderr }
}

describe('morpho-bots queue thin client (pipeline)', () => {
  let stub: Stub | null = null
  afterEach(async () => {
    if (stub) await stub.close()
    stub = null
  })

  it(
    'relays this domain+chain records to the daemon, echoes acks, and warn-skips foreign records',
    async () => {
      stub = await startStub({ chainId: 8453 })
      const input = [
        JSON.stringify(txRecord()), // blue/8453 → relayed
        JSON.stringify(txRecord({ id: 'midnight:liquidate:0xx', domain: 'midnight' })), // foreign domain
        JSON.stringify(txRecord({ id: 'blue:liquidate:0xy', chainId: 1 })) // foreign chain
      ].join('\n')

      const { code, stdout, stderr } = await runCli(['blue', 'queue', '--chain', '8453'], input, {
        QUEUED_SOCKET: stub.socketPath
      })

      expect(code).toBe(0)
      // Only the blue/8453 record reached the daemon; the other two were pre-filtered client-side.
      expect(stub.received).toHaveLength(1)
      expect(stub.received[0]!.id).toBe('blue:liquidate:0xborrower')
      // Its ack outcome was echoed to stdout.
      const outLines = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
      expect(outLines).toHaveLength(1)
      expect(outLines[0]).toMatchObject({ kind: 'outcome', status: 'submitted' })
      // The foreign records were warn-skipped on stderr.
      expect(stderr).toContain('unaccepted')
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 1 when the daemon socket is dead (transient — the loop retries)',
    async () => {
      const dead = join(mkdtempSync(join(tmpdir(), 'q-dead-')), 'nope.sock')
      const { code } = await runCli(
        ['blue', 'queue', '--chain', '8453'],
        JSON.stringify(txRecord()),
        {
          QUEUED_SOCKET: dead
        }
      )
      expect(code).toBe(1)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 2 on a stdin wire-version skew (deploy skew, not perishable data)',
    async () => {
      const dead = join(mkdtempSync(join(tmpdir(), 'q-skew-')), 'nope.sock')
      const input = JSON.stringify(txRecord({ v: 999 }))
      // The skew is caught while parsing stdin, before any connect — the socket need not exist.
      const { code } = await runCli(['blue', 'queue', '--chain', '8453'], input, {
        QUEUED_SOCKET: dead
      })
      expect(code).toBe(2)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'warn-skips a bad_request record and still relays the rest (exit 0)',
    async () => {
      stub = await startStub({
        chainId: 8453,
        ingestError: record =>
          record.id === 'blue:liquidate:0xbad'
            ? { code: 'bad_request', message: 'daemon rejected this record' }
            : undefined
      })
      const input = [
        JSON.stringify(txRecord({ id: 'blue:liquidate:0xbad' })), // daemon NACKs bad_request
        JSON.stringify(txRecord({ id: 'blue:liquidate:0xgood' })) // relayed + acked
      ].join('\n')

      const { code, stdout, stderr } = await runCli(['blue', 'queue', '--chain', '8453'], input, {
        QUEUED_SOCKET: stub.socketPath
      })

      // A per-record bad_request is warn+skipped — the batch survives (still exit 0).
      expect(code).toBe(0)
      expect(stderr).toContain('bad_request')
      // Only the good record was acked and its outcome echoed.
      const outLines = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l))
      expect(outLines).toHaveLength(1)
      expect(outLines[0]).toMatchObject({ id: 'blue:liquidate:0xgood', kind: 'outcome' })
      expect(stub.received).toHaveLength(1)
      expect(stub.received[0]!.id).toBe('blue:liquidate:0xgood')
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 1 on a retry daemon error (transient — the loop breaks and retries)',
    async () => {
      stub = await startStub({
        chainId: 8453,
        ingestError: () => ({ code: 'retry', message: 'daemon busy' })
      })
      const { code, stderr } = await runCli(
        ['blue', 'queue', '--chain', '8453'],
        JSON.stringify(txRecord()),
        { QUEUED_SOCKET: stub.socketPath }
      )
      expect(code).toBe(1)
      expect(stderr).toContain('ingest_failed')
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 2 when the daemon serves a different chain (handshake mismatch)',
    async () => {
      stub = await startStub({ chainId: 1 }) // daemon on chain 1, client asks for 8453
      const { code, stderr } = await runCli(
        ['blue', 'queue', '--chain', '8453'],
        JSON.stringify(txRecord()),
        { QUEUED_SOCKET: stub.socketPath }
      )
      expect(code).toBe(2)
      expect(stderr).toContain('handshake_failed')
      // A mismatched daemon must never receive the work.
      expect(stub.received).toHaveLength(0)
    },
    SPAWN_TIMEOUT_MS
  )
})

// The TTY health-check path can't be driven through a spawned pipe (no pseudo-terminal), so exercise
// `runQueueCommand` in-process with `process.stdin.isTTY` faked and the stub on this event loop.
describe('morpho-bots queue thin client (TTY health-check)', () => {
  let stub: Stub | null = null
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  const savedEnv = { ...process.env }

  function setTTY(value: boolean): void {
    Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true })
  }

  afterEach(async () => {
    if (stub) await stub.close()
    stub = null
    if (originalIsTTY) Object.defineProperty(process.stdin, 'isTTY', originalIsTTY)
    else delete (process.stdin as { isTTY?: unknown }).isTTY
    for (const key of ['MORPHO_BOTS_HOME', 'QUEUED_SOCKET']) delete process.env[key]
    Object.assign(process.env, savedEnv)
  })

  it('pings the daemon and exits 0 on a pong', async () => {
    stub = await startStub({ chainId: 8453 })
    process.env.MORPHO_BOTS_HOME = mkdtempSync(join(tmpdir(), 'q-tty-'))
    process.env.QUEUED_SOCKET = stub.socketPath
    setTTY(true)
    expect(await runQueueCommand('blue', { chain: '8453' })).toBe(0)
  })

  it('exits 1 when the daemon socket is dead', async () => {
    process.env.MORPHO_BOTS_HOME = mkdtempSync(join(tmpdir(), 'q-tty-'))
    process.env.QUEUED_SOCKET = join(mkdtempSync(join(tmpdir(), 'q-tty-dead-')), 'nope.sock')
    setTTY(true)
    expect(await runQueueCommand('blue', { chain: '8453' })).toBe(1)
  })
})
