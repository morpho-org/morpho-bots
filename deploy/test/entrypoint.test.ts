import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  return { dir, log, signer, queued, cli }
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
        TICK_INTERVAL_S: '60'
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
        TICK_INTERVAL_S: '60'
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
})
