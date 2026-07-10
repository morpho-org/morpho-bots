import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The CLI's exit-code contract is what loop/cron wrappers script against, so exercise the real
// binary end-to-end: spawn `bun src/main.ts …` from the package dir (whose bunfig preloads the
// soltag lens plugins, mirroring how operators and the Docker image invoke it).
const CLI_DIR = join(import.meta.dir, '..')

// Cold bun spawns take ~3s on CI runners (and the init test spawns twice), so the 5s default flakes.
const SPAWN_TIMEOUT_MS = 30_000

// A config that passes the queue's config gate (chain/rpc/key) without a reachable chain — RPC is at
// an unreachable loopback port. The zero-work queue pass must never dial it (fast path); the
// lock-held pass exits before any chain read.
const VALID_QUEUE_ENV = {
  CHAIN_ID: '8453',
  RPC_URL: 'http://127.0.0.1:1',
  LIQUIDATOR_PRIVATE_KEY: `0x${'1'.repeat(64)}`
}

function run(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(['bun', 'src/main.ts', ...args], {
    cwd: CLI_DIR,
    env: {
      ...process.env,
      MORPHO_BOTS_HOME: mkdtempSync(join(tmpdir(), 'morpho-bots-test-')),
      ...env
    }
  })
  return {
    code: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString()
  }
}

describe('morpho-bots exit codes', () => {
  it(
    'exits 0 for --help',
    () => {
      expect(run(['--help']).code).toBe(0)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'lists the sense/act/queue pipeline in a domain’s --help',
    () => {
      const { code, stdout } = run(['blue', '--help'])
      expect(code).toBe(0)
      expect(stdout).toContain('sense')
      expect(stdout).toContain('act')
      expect(stdout).toContain('queue')
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 2 for an unknown command (usage error — wrappers must stop)',
    () => {
      expect(run(['bogus']).code).toBe(2)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 2 for the removed `tick` subcommand',
    () => {
      // `tick` was replaced by sense/act/queue, so it is now an unknown subcommand → usage error.
      expect(run(['blue', 'tick']).code).toBe(2)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 2 for sense with no usable config, with a startup.error line',
    () => {
      const { code, stderr } = run(['blue', 'sense'])
      expect(code).toBe(2)
      expect(stderr).toContain('startup.error')
      expect(stderr).toContain('no chain configured')
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 2 for act with no usable config',
    () => {
      expect(run(['blue', 'act']).code).toBe(2)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 2 for queue with no usable config',
    () => {
      expect(run(['blue', 'queue']).code).toBe(2)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 0 for a queue whose lock is already held by a live pid',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'morpho-bots-test-'))
      // Pre-place the lock held by THIS (live) process, mirroring an overlapping queue.
      mkdirSync(join(home, 'locks'), { recursive: true })
      writeFileSync(
        join(home, 'locks', 'blue-8453.lock'),
        JSON.stringify({ pid: process.pid, startedAt: Date.now() })
      )
      const { code, stdout } = run(['blue', 'queue'], {
        ...VALID_QUEUE_ENV,
        MORPHO_BOTS_HOME: home
      })
      expect(code).toBe(0)
      // The lock-held pass emits no wire records (it only drains stdin and skips).
      expect(stdout.trim()).toBe('')
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 0 for a queue with empty stdin and empty state (zero-work fast path, no RPC)',
    () => {
      // No lock held, nothing on stdin, no prior queue state → the fast path skips the head fetch
      // (and thus every RPC call), so the unreachable RPC is never dialed and the pass completes.
      const { code } = run(['blue', 'queue'], VALID_QUEUE_ENV)
      expect(code).toBe(0)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'init scaffolds the home dir and a second run keeps existing files',
    () => {
      const home = mkdtempSync(join(tmpdir(), 'morpho-bots-test-'))
      const first = run(['init'], { MORPHO_BOTS_HOME: home })
      expect(first.code).toBe(0)
      expect(first.stdout).toContain('created')
      const second = run(['init'], { MORPHO_BOTS_HOME: home })
      expect(second.code).toBe(0)
      expect(second.stdout).toContain('kept')
    },
    SPAWN_TIMEOUT_MS
  )
})
