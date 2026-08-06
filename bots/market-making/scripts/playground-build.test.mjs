import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CANONICAL_PUBLISH_TEMP_MARKER,
  CANONICAL_STAGING_MARKER
} from './playground-atomic-publish.mjs'
import { CUSTOM_OUTDIR_PREFIX } from './playground-outdir.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const buildScript = join(packageRoot, 'scripts/playground-build.mjs')
const canonical = join(packageRoot, 'playground', 'dist')
const staleCanonicalAsset = join(canonical, 'offline-clean-only.stale')
const owned = new Set()
const makeOutdir = async () => {
  const directory = await mkdtemp(join(tmpdir(), CUSTOM_OUTDIR_PREFIX))
  owned.add(directory)
  return directory
}
const makeFakeBun = async source => {
  const root = await mkdtemp(join(tmpdir(), 'market-making-fake-bun-'))
  owned.add(root)
  const executable = join(root, 'bun')
  await writeFile(executable, `#!/usr/bin/env node\n${source}`)
  await chmod(executable, 0o755)
  return executable
}
const runBuild = (outdir, environment = {}) =>
  new Promise(resolve => {
    const args = [buildScript]
    if (outdir) args.push('--outdir', outdir)
    const child = spawn(process.execPath, args, {
      cwd: packageRoot,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', chunk => {
      stderr += chunk
    })
    child.once('close', code => resolve({ code, stderr, stdout }))
  })
const publishDebris = async () =>
  (await readdir(join(packageRoot, 'playground'), { recursive: true })).filter(
    name => name.includes(CANONICAL_STAGING_MARKER) || name.includes(CANONICAL_PUBLISH_TEMP_MARKER)
  )

afterEach(async () => {
  await Promise.all([...owned].map(directory => rm(directory, { recursive: true, force: true })))
  await rm(staleCanonicalAsset, { force: true })
  owned.clear()
})

test('a failed custom build leaves partial output for caller-owned cleanup', async () => {
  const outdir = await makeOutdir()
  const fakeBun = await makeFakeBun(`
const { writeFileSync } = require('node:fs')
const outdir = process.argv[process.argv.indexOf('--outdir') + 1]
writeFileSync(outdir + '/partial.bin', Buffer.from([0, 255, 42]))
process.exit(23)
`)

  const result = await runBuild(outdir, { BUN_EXE: fakeBun })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /Production playground build failed with exit code 23/)
  assert.deepEqual(await readFile(join(outdir, 'partial.bin')), Buffer.from([0, 255, 42]))
})

test('canonical build compiles privately, publishes finalized files, and never cleans old assets', async () => {
  await mkdir(canonical, { recursive: true })
  await writeFile(staleCanonicalAsset, 'retained until an explicit offline clean')
  const fakeBun = await makeFakeBun(`
const { writeFileSync } = require('node:fs')
const outdir = process.argv[process.argv.indexOf('--outdir') + 1]
if (!/\\.dist\\.staging-/.test(outdir)) throw new Error('canonical build was not private')
writeFileSync(outdir + '/index.html', '<link rel="stylesheet" href="./index.css"><script src="./index.js"></script>')
writeFileSync(outdir + '/index.css', 'body { color: red }')
writeFileSync(outdir + '/index.js', 'globalThis.built = true')
`)

  const result = await runBuild(undefined, { BUN_EXE: fakeBun })
  assert.equal(result.code, 0, result.stderr)
  const html = await readFile(join(canonical, 'index.html'), 'utf8')
  assert.match(html, /index\.[0-9a-f]{12}\.css/)
  assert.match(html, /index\.[0-9a-f]{12}\.js/)
  assert.equal(
    await readFile(staleCanonicalAsset, 'utf8'),
    'retained until an explicit offline clean'
  )
  assert.deepEqual(await publishDebris(), [])
})

test('failed canonical build preserves the prior artifact and removes its private staging tree', async () => {
  await mkdir(canonical, { recursive: true })
  await writeFile(join(canonical, 'index.html'), '<p>prior artifact</p>')
  const before = await readFile(join(canonical, 'index.html'))
  const fakeBun = await makeFakeBun(`
const { writeFileSync } = require('node:fs')
const outdir = process.argv[process.argv.indexOf('--outdir') + 1]
writeFileSync(outdir + '/partial', 'never publish me')
process.exit(29)
`)

  const result = await runBuild(undefined, { BUN_EXE: fakeBun })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /exit code 29/)
  assert.deepEqual(await readFile(join(canonical, 'index.html')), before)
  assert.deepEqual(await publishDebris(), [])
})
