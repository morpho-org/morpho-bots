import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ENTRYPOINT = join(import.meta.dir, '..', 'docker-entrypoint.sh')
const processes: ReturnType<typeof Bun.spawn>[] = []
const dirs: string[] = []

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'entrypoint-'))
  dirs.push(dir)
  const log = join(dir, 'events.log')
  const signer = join(dir, 'signer.ts')
  const queued = join(dir, 'queued.ts')
  const cli = join(dir, 'cli.ts')
  writeFileSync(
    signer,
    `import { appendFileSync, unlinkSync } from 'node:fs'
const socket = process.env.SIGNER_SOCKET!; const log = process.env.EVENT_LOG!
const server = Bun.listen({ unix: socket, socket: { data() {} } })
appendFileSync(log, 'signer-ready\\n')
process.on('SIGTERM', () => { appendFileSync(log, 'signer-stop\\n'); server.stop(true); try { unlinkSync(socket) } catch {}; process.exit(0) })
await new Promise(() => {})
`
  )
  writeFileSync(
    queued,
    `import { appendFileSync, unlinkSync } from 'node:fs'
const [command] = Bun.argv.slice(2); const log = process.env.EVENT_LOG!
if (command === 'submit') { await Bun.stdin.text(); process.exit(0) }
if (!process.env.SIGNER_SOCKET) process.exit(9)
const socket = process.env.QUEUED_SOCKET!; const server = Bun.listen({ unix: socket, socket: { data() {} } })
appendFileSync(log, 'queued-ready\\n')
process.on('SIGTERM', () => { appendFileSync(log, 'queued-stop\\n'); server.stop(true); try { unlinkSync(socket) } catch {}; process.exit(0) })
await new Promise(() => {})
`
  )
  writeFileSync(
    cli,
    `import { appendFileSync } from 'node:fs'
const op = Bun.argv.at(-1); const log = process.env.EVENT_LOG!
if (op === 'unhealthy-positions') {
  appendFileSync(log, 'tick-ready\\n')
  process.on('SIGTERM', () => { appendFileSync(log, 'tick-stop\\n'); process.exit(0) })
  await new Promise(() => {})
} else {
  await Bun.stdin.text()
}
`
  )
  // Vector is invoked directly (a binary), not via `bun`, so the stub is an executable bash script.
  // It records whether it inherited SIGNER_PRIVATE_KEY (to a probe file, keeping EVENT_LOG clean) and
  // can be told to ignore SIGTERM (to exercise the bounded-SIGKILL shutdown path).
  const vector = join(dir, 'vector')
  writeFileSync(
    vector,
    `#!/usr/bin/env bash
echo "vector-ready" >> "$EVENT_LOG"
[[ -n "\${SIGNER_PRIVATE_KEY:-}" ]] && echo present >"\${VECTOR_KEY_PROBE:-/dev/null}" || echo absent >"\${VECTOR_KEY_PROBE:-/dev/null}"
if [[ -n "\${VECTOR_STUB_IGNORE_TERM:-}" ]]; then trap '' TERM; else trap 'echo "vector-stop" >> "$EVENT_LOG"; exit 0' TERM; fi
while true; do sleep 1; done
`
  )
  chmodSync(vector, 0o755)
  return { dir, log, signer, queued, cli, vector }
}

afterEach(async () => {
  for (const process of processes.splice(0)) {
    process.kill('SIGKILL')
    await process.exited.catch(() => undefined)
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('docker entrypoint lifecycle', () => {
  it('gates queue on signer readiness and shuts queue down before signer', async () => {
    const f = fixture()
    const process = Bun.spawn([ENTRYPOINT], {
      env: {
        ...Bun.env,
        BOT: 'midnight',
        CHAIN_ID: '8453',
        SIGNER_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
        MORPHO_BOTS_HOME: f.dir,
        SIGNER_BIN: f.signer,
        QUEUED_BIN: f.queued,
        CLI_BIN: f.cli,
        EVENT_LOG: f.log,
        TICK_INTERVAL_S: '60',
        // Keep hermetic: a developer with these exported must not activate the Vector path here.
        BETTERSTACK_SOURCE_TOKEN: undefined,
        BETTERSTACK_INGESTING_HOST: undefined
      },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    processes.push(process)

    for (let i = 0; i < 200; i += 1) {
      if (existsSync(f.log) && readFileSync(f.log, 'utf8').includes('tick-ready')) break
      await Bun.sleep(25)
    }
    expect(readFileSync(f.log, 'utf8').split('\n').filter(Boolean)).toEqual([
      'signer-ready',
      'queued-ready',
      'tick-ready'
    ])

    process.kill('SIGTERM')
    expect(await process.exited).toBe(0)
    expect(readFileSync(f.log, 'utf8').split('\n').filter(Boolean)).toEqual([
      'signer-ready',
      'queued-ready',
      'tick-ready',
      'tick-stop',
      'queued-stop',
      'signer-stop'
    ])
  })

  it('runs dry-run mode without starting a signer or requiring a key', async () => {
    const f = fixture()
    const process = Bun.spawn([ENTRYPOINT], {
      env: {
        ...Bun.env,
        BOT: 'midnight',
        CHAIN_ID: '8453',
        SIGNER_PRIVATE_KEY: undefined,
        QUEUED_DRY_RUN: 'true',
        MORPHO_BOTS_HOME: f.dir,
        SIGNER_BIN: f.signer,
        QUEUED_BIN: f.queued,
        CLI_BIN: f.cli,
        EVENT_LOG: f.log,
        TICK_INTERVAL_S: '60',
        // Keep hermetic: a developer with these exported must not activate the Vector path here.
        BETTERSTACK_SOURCE_TOKEN: undefined,
        BETTERSTACK_INGESTING_HOST: undefined
      },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    processes.push(process)

    for (let i = 0; i < 200; i += 1) {
      if (existsSync(f.log) && readFileSync(f.log, 'utf8').includes('tick-ready')) break
      await Bun.sleep(25)
    }
    expect(readFileSync(f.log, 'utf8').split('\n').filter(Boolean)).toEqual([
      'queued-ready',
      'tick-ready'
    ])

    process.kill('SIGTERM')
    expect(await process.exited).toBe(0)
    expect(readFileSync(f.log, 'utf8').split('\n').filter(Boolean)).toEqual([
      'queued-ready',
      'tick-ready',
      'tick-stop',
      'queued-stop'
    ])
  })

  it('starts the log forwarder and tears it down last when BetterStack is configured', async () => {
    const f = fixture()
    // A dedicated spool dir keeps Vector's data_dir clear of the stub binary path; capturing stderr
    // to a file (not a live pipe) both avoids a post-exit EOF race and mirrors how Railway captures
    // the stream.
    const spoolDir = join(f.dir, 'logspool')
    const stderrPath = join(f.dir, 'stderr.txt')
    const keyProbe = join(f.dir, 'vector-key-probe')
    const stderrFd = openSync(stderrPath, 'w')
    const process = Bun.spawn([ENTRYPOINT], {
      env: {
        ...Bun.env,
        BOT: 'midnight',
        CHAIN_ID: '8453',
        SIGNER_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
        MORPHO_BOTS_HOME: f.dir,
        SIGNER_BIN: f.signer,
        QUEUED_BIN: f.queued,
        CLI_BIN: f.cli,
        VECTOR_BIN: f.vector,
        EVENT_LOG: f.log,
        TICK_INTERVAL_S: '60',
        BETTERSTACK_SOURCE_TOKEN: 'test-token',
        BETTERSTACK_INGESTING_HOST: 'example.invalid',
        BOT_LOG_SPOOL_DIR: spoolDir,
        VECTOR_KEY_PROBE: keyProbe
      },
      stdout: 'ignore',
      stderr: stderrFd
    })
    processes.push(process)

    for (let i = 0; i < 200; i += 1) {
      const seen = existsSync(f.log) ? readFileSync(f.log, 'utf8') : ''
      if (seen.includes('tick-ready') && seen.includes('vector-ready')) break
      await Bun.sleep(25)
    }
    // The forwarder has no readiness gate, so vector-ready can interleave with the gated startup
    // events — assert the set, not the order.
    expect(readFileSync(f.log, 'utf8').split('\n').filter(Boolean).toSorted()).toEqual([
      'queued-ready',
      'signer-ready',
      'tick-ready',
      'vector-ready'
    ])
    // Single-key-reader invariant: the shipper must not inherit SIGNER_PRIVATE_KEY.
    expect(readFileSync(keyProbe, 'utf8').trim()).toBe('absent')

    process.kill('SIGTERM')
    expect(await process.exited).toBe(0)
    closeSync(stderrFd)

    // Teardown is sequential; the shipper stops LAST so it can flush the drain lines above it.
    const events = readFileSync(f.log, 'utf8').split('\n').filter(Boolean)
    expect(events.filter(event => event.endsWith('-stop'))).toEqual([
      'tick-stop',
      'queued-stop',
      'signer-stop',
      'vector-stop'
    ])

    // `loop.start` is duplicated by tee: it reaches BOTH the real stderr and the spool Vector tails.
    expect(readFileSync(stderrPath, 'utf8')).toContain('loop.start')
    expect(readFileSync(join(spoolDir, 'spool.log'), 'utf8')).toContain('loop.start')
  })

  it('fails loud and skips forwarding when the token is set but the host is missing', async () => {
    const f = fixture()
    const stderrPath = join(f.dir, 'stderr.txt')
    const stderrFd = openSync(stderrPath, 'w')
    const process = Bun.spawn([ENTRYPOINT], {
      env: {
        ...Bun.env,
        BOT: 'midnight',
        CHAIN_ID: '8453',
        SIGNER_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
        MORPHO_BOTS_HOME: f.dir,
        SIGNER_BIN: f.signer,
        QUEUED_BIN: f.queued,
        CLI_BIN: f.cli,
        VECTOR_BIN: f.vector,
        EVENT_LOG: f.log,
        TICK_INTERVAL_S: '60',
        BETTERSTACK_SOURCE_TOKEN: 'test-token',
        BETTERSTACK_INGESTING_HOST: undefined
      },
      stdout: 'ignore',
      stderr: stderrFd
    })
    processes.push(process)

    for (let i = 0; i < 200; i += 1) {
      if (existsSync(f.log) && readFileSync(f.log, 'utf8').includes('tick-ready')) break
      await Bun.sleep(25)
    }
    // The bot still runs normally; Vector never starts.
    const events = readFileSync(f.log, 'utf8').split('\n').filter(Boolean)
    expect(events).toEqual(['signer-ready', 'queued-ready', 'tick-ready'])

    process.kill('SIGTERM')
    expect(await process.exited).toBe(0)
    closeSync(stderrFd)
    expect(readFileSync(stderrPath, 'utf8')).toContain('logforward.misconfigured')
  })

  it('force-kills a shipper that ignores SIGTERM without blocking shutdown', async () => {
    const f = fixture()
    const stderrFd = openSync(join(f.dir, 'stderr.txt'), 'w')
    const process = Bun.spawn([ENTRYPOINT], {
      env: {
        ...Bun.env,
        BOT: 'midnight',
        CHAIN_ID: '8453',
        SIGNER_PRIVATE_KEY: `0x${'1'.repeat(64)}`,
        MORPHO_BOTS_HOME: f.dir,
        SIGNER_BIN: f.signer,
        QUEUED_BIN: f.queued,
        CLI_BIN: f.cli,
        VECTOR_BIN: f.vector,
        EVENT_LOG: f.log,
        TICK_INTERVAL_S: '60',
        BETTERSTACK_SOURCE_TOKEN: 'test-token',
        BETTERSTACK_INGESTING_HOST: 'example.invalid',
        BOT_LOG_SPOOL_DIR: join(f.dir, 'logspool'),
        VECTOR_STUB_IGNORE_TERM: '1',
        VECTOR_STOP_TIMEOUT_S: '1'
      },
      stdout: 'ignore',
      stderr: stderrFd
    })
    processes.push(process)

    for (let i = 0; i < 200; i += 1) {
      const seen = existsSync(f.log) ? readFileSync(f.log, 'utf8') : ''
      if (seen.includes('tick-ready') && seen.includes('vector-ready')) break
      await Bun.sleep(25)
    }

    process.kill('SIGTERM')
    // The entrypoint still exits cleanly (SIGKILL after the bounded wait), and drains the rest first.
    expect(await process.exited).toBe(0)
    closeSync(stderrFd)
    const events = readFileSync(f.log, 'utf8').split('\n').filter(Boolean)
    expect(events).toContain('signer-stop')
    // The shipper ignored SIGTERM, so it never logged a graceful stop — it was force-killed.
    expect(events).not.toContain('vector-stop')
  })
})
