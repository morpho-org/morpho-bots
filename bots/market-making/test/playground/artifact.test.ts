import { afterEach, describe, expect, test } from 'bun:test'
import { build } from 'esbuild'
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const packageRoot = join(import.meta.dir, '../..')
let temporaryDirectory = ''

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = ''
})

const productionBuild = async () => {
  const child = Bun.spawn(
    [Bun.which('node')!, join(packageRoot, 'scripts/playground-build.mjs'), '--temporary'],
    {
      cwd: packageRoot,
      env: { ...Bun.env, BUN_EXE: Bun.which('bun')! },
      stdout: 'pipe',
      stderr: 'pipe'
    }
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  expect(code, `${stdout}\n${stderr}`).toBe(0)
  const record = stdout.split(/\r?\n/).flatMap(line => {
    try {
      const value = JSON.parse(line)
      return value.kind === 'market-making-playground-build' ? [value] : []
    } catch {
      return []
    }
  })[0]
  expect(record).toBeDefined()
  temporaryDirectory = record.path
  return temporaryDirectory
}

describe('playground browser artifact boundary', () => {
  test('builds a local-only CSP artifact with no removed runtime or secret surface', async () => {
    const directory = await productionBuild()
    const names = (await readdir(directory)).toSorted()
    expect(names).toContain('index.html')
    expect(names.some(name => name.endsWith('.js'))).toBe(true)
    expect(names.some(name => name.endsWith('.css'))).toBe(true)
    const contents = await Promise.all(names.map(name => readFile(join(directory, name))))
    const text = contents.map(value => value.toString('utf8')).join('\n')
    const gzipBytes = contents.reduce((total, value) => total + gzipSync(value).byteLength, 0)
    expect(gzipBytes).toBeLessThan(180 * 1024)
    expect(text).toContain("connect-src 'none'")
    expect(text).toContain('Bootstrap JSON string')
    expect(text).toContain('Ladder JSON string')
    for (const forbidden of [
      'MAKER_PRIVATE_KEY',
      'BETTERSTACK_SOURCE_TOKEN',
      'RPC_URL',
      'Runtime & setup',
      'Choose ladder JSON file',
      'Drop one ladder',
      'Shell-safe ENV'
    ])
      expect(text).not.toContain(forbidden)
  }, 60_000)

  test('metafile allowlist keeps the browser graph off runtime, providers, secrets, logging, and observability', async () => {
    const result = await build({
      entryPoints: [join(packageRoot, 'playground/app.tsx')],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      metafile: true,
      write: false,
      define: { 'process.env.NODE_ENV': '"production"' }
    })
    const inputs = Object.keys(result.metafile.inputs)
    const forbidden = inputs.filter(path =>
      /config\.utils|config\.service|config-source|viem\/accounts|packages\/(?:logging|monitoring|observability)|infrastructure|application\//.test(
        path
      )
    )
    expect(forbidden).toEqual([])
    const firstParty = inputs.filter(path => !path.includes('node_modules/'))
    expect(
      firstParty.every(path =>
        /playground\/(?:app|model)\.tsx?$|src\/config\/(?:market-collections|config-validation\.error)\.ts$|src\/domain\/(?:bootstrap|ladder)\/|src\/domain\/bytes32\.ts$|packages\/utils\//.test(
          path
        )
      ),
      firstParty.join('\n')
    ).toBe(true)
  })
})
