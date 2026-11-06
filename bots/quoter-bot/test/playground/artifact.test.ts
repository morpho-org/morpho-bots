import { execa } from 'execa'
import { readdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, test } from 'vitest'

const packageRoot = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)))
let temporaryDirectory = ''

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = ''
})

const productionBuild = async () => {
  const child = await execa(
    process.execPath,
    [join(packageRoot, 'scripts/playground-build.mjs'), '--temporary'],
    {
      cwd: packageRoot,
      reject: false
    }
  )
  expect(child.exitCode, `${child.stdout}\n${child.stderr}`).toBe(0)
  const { stdout } = child
  const record = stdout.split(/\r?\n/).flatMap(line => {
    try {
      const value = JSON.parse(line)
      return value.kind === 'quoter-bot-playground-build' ? [value] : []
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
})
