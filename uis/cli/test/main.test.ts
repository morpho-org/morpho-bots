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
    'exits 2 for an unknown command (usage error — wrappers must stop)',
    () => {
      expect(run(['bogus']).code).toBe(2)
    },
    SPAWN_TIMEOUT_MS
  )

  it(
    'exits 2 for a tick with no usable config, with a startup.error line',
    () => {
      const { code, stderr } = run(['blue', 'tick'])
      expect(code).toBe(2)
      expect(stderr).toContain('startup.error')
      expect(stderr).toContain('no chain configured')
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
