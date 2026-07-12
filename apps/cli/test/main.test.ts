import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The CLI's exit-code contract is what loop/cron wrappers script against, so exercise the real
// binary end-to-end: spawn `bun src/main.ts …` from the package dir (whose bunfig preloads the
// soltag lens plugins, mirroring how operators and the Docker image invoke it).
const CLI_DIR = join(import.meta.dir, '..')

// Cold bun spawns take ~3s on CI runners (and the init test spawns twice), so the 5s default flakes.
const SPAWN_TIMEOUT_MS = 30_000

function run(args: string[], env: Record<string, string> = {}, stdin?: string) {
  const result = Bun.spawnSync(['bun', 'src/main.ts', ...args], {
    cwd: CLI_DIR,
    env: {
      ...process.env,
      MORPHO_BOTS_HOME: mkdtempSync(join(tmpdir(), 'morpho-bots-test-')),
      ...env
    },
    ...(stdin === undefined ? {} : { stdin: new Blob([stdin]) })
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
      const { code, stdout } = run(['--help'])
      expect(code).toBe(0)
      expect(stdout).toContain('morpho-bots')
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'documents runtime op dispatch in domain help',
    () => {
      const { code, stdout } = run(['blue', '--help'])
      expect(code).toBe(0)
      expect(stdout).toContain('<op>')
      expect(stdout).not.toContain('[ids...]')
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
    'exits 2 for an unknown op (usage error — wrappers must stop)',
    () => {
      // Only the manifest's op names are registered, so an unlisted one is an unknown subcommand.
      expect(run(['midnight', 'frobnicate']).code).toBe(2)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 2 for the removed `sense` verb (replaced by op commands)',
    () => {
      // `sense`/`act` verbs were replaced by op names, so `sense` is now an unknown subcommand.
      expect(run(['blue', 'sense']).code).toBe(2)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 2 for a source op with no usable config, with a startup.error line',
    () => {
      const { code, stderr } = run(['blue', 'unhealthy-positions'])
      expect(code).toBe(2)
      expect(stderr).toContain('startup.error')
      expect(stderr).toContain('no chain configured')
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 2 for a transform op with no usable config',
    () => {
      expect(run(['blue', 'liquidate']).code).toBe(2)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 2 after reporting malformed transform JSONL',
    () => {
      const { code, stderr } = run(
        ['blue', 'liquidate'],
        {
          CHAIN_ID: '8453',
          RPC_URL: 'http://127.0.0.1:1',
          LIQUIDATOR_ADDRESS: '0x1111111111111111111111111111111111111111'
        },
        '{malformed\n'
      )
      expect(code).toBe(2)
      expect(stderr).toContain('malformed_line')
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
