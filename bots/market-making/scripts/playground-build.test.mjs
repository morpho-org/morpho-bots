import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CANONICAL_PUBLISH_TEMP_MARKER } from './playground-atomic-publish.mjs'
import {
  captureCanonicalPathIdentity,
  revalidateCanonicalPathIdentity
} from './playground-path-safety.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const buildScript = join(packageRoot, 'scripts/playground-build.mjs')
const canonical = join(packageRoot, 'playground', 'dist')
const staleCanonicalAsset = join(canonical, 'offline-clean-only.stale')
const owned = new Set()
const makeCanonicalChain = async () => {
  const container = await mkdtemp(join(tmpdir(), 'playground-path-chain-'))
  owned.add(container)
  const repoRoot = join(container, 'repo')
  const packageRoot = join(repoRoot, 'bots', 'market-making')
  const playground = join(packageRoot, 'playground')
  await mkdir(playground, { recursive: true })
  return { container, packageRoot, playground, repoRoot }
}
const makeFakeBun = async source => {
  const root = await mkdtemp(join(tmpdir(), 'market-making-fake-bun-'))
  owned.add(root)
  const executable = join(root, 'bun')
  await writeFile(executable, `#!/usr/bin/env node\n${source}`)
  await chmod(executable, 0o755)
  return executable
}
const runBuild = (args = [], environment = {}) =>
  new Promise(resolve => {
    const child = spawn(process.execPath, [buildScript, ...args], {
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
const outputRecord = stdout => {
  const records = stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  assert.equal(records.length, 1, `expected one structured output record in ${stdout}`)
  return records[0]
}
const publishDebris = async () =>
  (await readdir(join(packageRoot, 'playground'), { recursive: true })).filter(name =>
    name.includes(CANONICAL_PUBLISH_TEMP_MARKER)
  )

afterEach(async () => {
  await Promise.all([...owned].map(directory => rm(directory, { recursive: true, force: true })))
  await rm(staleCanonicalAsset, { force: true })
  owned.clear()
})

test('CLI exposes only canonical default and --temporary; arbitrary output flags are rejected', async () => {
  for (const args of [
    ['--outdir', join(tmpdir(), 'caller-owned')],
    ['--outdir'],
    ['--no-clean'],
    ['--temporary', '--temporary'],
    ['--temporary', 'caller-path'],
    ['unexpected']
  ]) {
    const result = await runBuild(args)
    assert.notEqual(result.code, 0, args.join(' '))
    assert.match(result.stderr, /Usage: playground-build\.mjs \[--temporary\]/)
  }
})

test('--temporary creates a private owned OS-temp directory, reports its exact path, and leaves cleanup to caller', async () => {
  const fakeBun = await makeFakeBun(`
const { writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, dirname } = require('node:path')
const outdir = process.argv[process.argv.indexOf('--outdir') + 1]
if (dirname(outdir) !== tmpdir()) throw new Error('not under OS temp')
if (!basename(outdir).startsWith('market-making-playground-dist-')) throw new Error('wrong prefix')
writeFileSync(outdir + '/index.html', '<script src="./index.js"></script>')
writeFileSync(outdir + '/index.js', 'globalThis.temporary = true')
`)
  const result = await runBuild(['--temporary'], { BUN_EXE: fakeBun })
  assert.equal(result.code, 0, result.stderr)
  const record = outputRecord(result.stdout)
  assert.deepEqual(Object.keys(record).sort(), ['kind', 'mode', 'path'])
  assert.equal(record.kind, 'market-making-playground-build')
  assert.equal(record.mode, 'temporary')
  assert.equal(dirname(record.path), tmpdir())
  assert.match(basename(record.path), /^market-making-playground-dist-/)
  assert.equal((await lstat(record.path)).isDirectory(), true)
  if (process.platform !== 'win32') assert.equal((await lstat(record.path)).mode & 0o777, 0o700)
  assert.match(await readFile(join(record.path, 'index.html'), 'utf8'), /index\.[0-9a-f]{12}\.js/)
  owned.add(record.path)
})

test('failed temporary build removes its internally-created partial output', async () => {
  const before = new Set(
    (await readdir(tmpdir())).filter(name => name.startsWith('market-making-playground-dist-'))
  )
  const fakeBun = await makeFakeBun(`
const { writeFileSync } = require('node:fs')
const outdir = process.argv[process.argv.indexOf('--outdir') + 1]
writeFileSync(outdir + '/partial.bin', 'partial')
process.exit(23)
`)
  const result = await runBuild(['--temporary'], { BUN_EXE: fakeBun })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /Production playground build failed with exit code 23/)
  const after = (await readdir(tmpdir())).filter(
    name => name.startsWith('market-making-playground-dist-') && !before.has(name)
  )
  assert.deepEqual(after, [])
})

test('canonical build stages in owned OS temp, publishes finalized files, and retains old assets', async () => {
  await mkdir(canonical, { recursive: true })
  await writeFile(staleCanonicalAsset, 'retained until an explicit offline clean')
  const fakeBun = await makeFakeBun(`
const { writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { basename, dirname } = require('node:path')
const outdir = process.argv[process.argv.indexOf('--outdir') + 1]
if (dirname(outdir) !== tmpdir()) throw new Error('canonical staging not in OS temp')
if (!basename(outdir).startsWith('market-making-playground-staging-')) throw new Error('wrong staging prefix')
writeFileSync(outdir + '/index.html', '<link rel="stylesheet" href="./index.css"><script src="./index.js"></script>')
writeFileSync(outdir + '/index.css', 'body { color: red }')
writeFileSync(outdir + '/index.js', 'globalThis.built = true')
`)
  const result = await runBuild([], { BUN_EXE: fakeBun })
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.stdout, '')
  const html = await readFile(join(canonical, 'index.html'), 'utf8')
  assert.match(html, /index\.[0-9a-f]{12}\.css/)
  assert.match(html, /index\.[0-9a-f]{12}\.js/)
  assert.equal(
    await readFile(staleCanonicalAsset, 'utf8'),
    'retained until an explicit offline clean'
  )
  assert.deepEqual(await publishDebris(), [])
})

test('failed canonical build preserves the prior index and removes OS-temp staging', async () => {
  await mkdir(canonical, { recursive: true })
  await writeFile(join(canonical, 'index.html'), '<p>prior artifact</p>')
  const beforeIndex = await readFile(join(canonical, 'index.html'))
  const beforeTemp = new Set(
    (await readdir(tmpdir())).filter(name => name.startsWith('market-making-playground-staging-'))
  )
  const fakeBun = await makeFakeBun(`
const { writeFileSync } = require('node:fs')
const outdir = process.argv[process.argv.indexOf('--outdir') + 1]
writeFileSync(outdir + '/partial', 'never publish me')
process.exit(29)
`)
  const result = await runBuild([], { BUN_EXE: fakeBun })
  assert.notEqual(result.code, 0)
  assert.match(result.stderr, /exit code 29/)
  assert.deepEqual(await readFile(join(canonical, 'index.html')), beforeIndex)
  assert.deepEqual(
    (await readdir(tmpdir())).filter(
      name => name.startsWith('market-making-playground-staging-') && !beforeTemp.has(name)
    ),
    []
  )
})

test('canonical path identity captures and revalidates the real repo/package/playground chain', async () => {
  const chain = await makeCanonicalChain()
  const identity = await captureCanonicalPathIdentity(chain)
  assert.equal(identity.playground.realpath, chain.playground)
  assert.equal(typeof identity.playground.dev, 'number')
  assert.equal(typeof identity.playground.ino, 'number')
  await revalidateCanonicalPathIdentity(identity)
})

test('canonical path identity rejects static symlinks in every repo descendant', async () => {
  for (const component of ['bots', 'market-making', 'playground']) {
    const chain = await makeCanonicalChain()
    const path =
      component === 'bots'
        ? join(chain.repoRoot, 'bots')
        : component === 'market-making'
          ? chain.packageRoot
          : chain.playground
    const displaced = `${path}-real`
    await rename(path, displaced)
    await symlink(displaced, path, 'dir')
    await assert.rejects(captureCanonicalPathIdentity(chain), /symlink/)
  }
})

test('canonical path identity rejects a symlink ancestor above the repository root', async () => {
  const chain = await makeCanonicalChain()
  const linkedContainer = `${chain.container}-linked`
  await symlink(chain.container, linkedContainer, 'dir')
  owned.add(linkedContainer)
  await assert.rejects(
    captureCanonicalPathIdentity({
      repoRoot: join(linkedContainer, 'repo'),
      packageRoot: join(linkedContainer, 'repo', 'bots', 'market-making'),
      playground: join(linkedContainer, 'repo', 'bots', 'market-making', 'playground')
    }),
    /symlink ancestor/
  )
})

test('canonical path revalidation rejects every path-chain identity replacement', async () => {
  for (const select of [
    chain => chain.repoRoot,
    chain => join(chain.repoRoot, 'bots'),
    chain => chain.packageRoot,
    chain => chain.playground
  ]) {
    const chain = await makeCanonicalChain()
    const identity = await captureCanonicalPathIdentity(chain)
    const path = select(chain)
    await rename(path, `${path}-displaced`)
    await mkdir(path, { recursive: true })
    await assert.rejects(revalidateCanonicalPathIdentity(identity), /replaced|identity/)
  }
})
