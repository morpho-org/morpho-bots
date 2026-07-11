import type { Subprocess } from 'bun'

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Full-process lifecycle: spawn `morpho-queued --dry-run` and assert socket bind, SIGTERM → exit 0 +
// unlink, second daemon → exit 2, dead-pid + stale-socket steal, and an outcomes.jsonl append. Dry-run
// keeps startup offline (no signer, no reconcile); a tiny local mock RPC answers only the ingest test.

const MAIN = join(import.meta.dir, '..', 'src', 'main.ts')
const CWD = join(import.meta.dir, '..')
const CHAIN = '8453'

// A minimal JSON-RPC mock so a dry-run ingest can re-simulate + read the head over real HTTP.
let rpc: ReturnType<typeof Bun.serve>
let rpcUrl: string
beforeAll(() => {
  rpc = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { id: number; method: string }
      const results: Record<string, unknown> = {
        eth_chainId: `0x${Number(CHAIN).toString(16)}`,
        eth_call: '0x',
        eth_getBlockByNumber: { number: '0x64', baseFeePerGas: '0x7' }
      }
      return Response.json({ jsonrpc: '2.0', id: body.id, result: results[body.method] ?? null })
    }
  })
  rpcUrl = `http://localhost:${rpc.port}`
})
afterAll(() => rpc.stop(true))

let home: string
let socketPath: string
const running: Subprocess[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'q-spawn-'))
  socketPath = join(home, `queued-${CHAIN}.sock`)
})
afterEach(async () => {
  for (const proc of running.splice(0)) {
    proc.kill('SIGKILL')
    await proc.exited.catch(() => undefined)
  }
  rmSync(home, { recursive: true, force: true })
})

function spawnDaemon(extraEnv: Record<string, string> = {}): Subprocess {
  const proc = Bun.spawn([process.execPath, MAIN, '--chain', CHAIN, '--dry-run'], {
    cwd: CWD,
    env: { ...process.env, MORPHO_BOTS_HOME: home, RPC_URL: rpcUrl, ...extraEnv },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  running.push(proc)
  return proc
}

// Poll until a `ping` over the socket returns `{ pong: true }`, or throw after `timeoutMs`.
async function waitForSocket(timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(socketPath)) {
      const ok = await ping().catch(() => false)
      if (ok) return
    }
    if (Date.now() > deadline) throw new Error(`socket ${socketPath} never came up`)
    await Bun.sleep(100)
  }
}

function ping(): Promise<boolean> {
  return request({ v: 1, id: 'ping', method: 'ping' }).then(
    res => (res.result as { pong?: boolean } | undefined)?.pong === true
  )
}

function request(req: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let buffer = ''
    socket.on('connect', () => socket.write(`${JSON.stringify(req)}\n`))
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      const idx = buffer.indexOf('\n')
      if (idx === -1) return
      socket.destroy()
      resolve(JSON.parse(buffer.slice(0, idx)))
    })
    socket.on('error', reject)
  })
}

describe('morpho-queued process lifecycle', () => {
  it('binds the socket, then SIGTERM → exit 0 and the socket is unlinked', async () => {
    const proc = spawnDaemon()
    await waitForSocket()
    expect(existsSync(socketPath)).toBe(true)
    proc.kill('SIGTERM')
    const code = await proc.exited
    expect(code).toBe(0)
    expect(existsSync(socketPath)).toBe(false)
  })

  it('refuses a second daemon on the same chain with exit 2', async () => {
    const first = spawnDaemon()
    await waitForSocket()
    const second = spawnDaemon()
    const code = await second.exited
    expect(code).toBe(2)
    first.kill('SIGTERM')
    await first.exited
  })

  it('steals a dead pid lock and a stale socket left by a SIGKILLed daemon, then binds', async () => {
    const first = spawnDaemon()
    await waitForSocket()
    // SIGKILL leaves both the lock file (dead pid) and the socket file (never unlinked).
    first.kill('SIGKILL')
    await first.exited.catch(() => undefined)
    expect(existsSync(socketPath)).toBe(true) // stale socket file survives the kill

    const second = spawnDaemon()
    await waitForSocket() // it must steal the lock + stale socket and bind
    expect(await ping()).toBe(true)
    second.kill('SIGTERM')
    expect(await second.exited).toBe(0)
  })

  it('appends a would_submit outcome to outcomes.jsonl on a dry-run ingest', async () => {
    const proc = spawnDaemon()
    await waitForSocket()
    const record = {
      v: 1,
      kind: 'tx',
      id: 'blue:liquidate:0xborrower',
      domain: 'blue',
      op: 'liquidate',
      chainId: Number(CHAIN),
      at: new Date().toISOString(),
      summary: 'blue liquidate',
      to: `0x${'22'.repeat(20)}`,
      data: '0x',
      simulated: { status: 'ok', block: 100 }
    }
    const res = await request({ v: 1, id: 'i1', method: 'ingest', params: { record } })
    expect((res.result as { outcome: { status: string } }).outcome.status).toBe('would_submit')

    const outcomes = readFileSync(join(home, 'queued', `outcomes-${CHAIN}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(outcomes.at(-1)).toMatchObject({ kind: 'outcome', status: 'would_submit' })

    proc.kill('SIGTERM')
    await proc.exited
  })

  it('exits 2 when no chain is configured (ConfigError)', async () => {
    const proc = Bun.spawn([process.execPath, MAIN, '--dry-run'], {
      cwd: CWD,
      env: { ...process.env, MORPHO_BOTS_HOME: home, RPC_URL: rpcUrl, CHAIN_ID: '' },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    running.push(proc)
    expect(await proc.exited).toBe(2)
  })
})
