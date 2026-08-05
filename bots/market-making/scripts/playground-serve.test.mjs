import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createReadStream, unlinkSync } from 'node:fs'
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { ensureFrozenDependencies, parseServeOptions } from './playground-serve-support.mjs'
import { startStaticServer } from './playground-smoke-support.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const launcher = fileURLToPath(new URL('./playground-serve.mjs', import.meta.url))
const temporaryDirectories = []

const temporaryDirectory = async prefix => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

const writeResolvableDependencies = async (packageRoot, names = ['viem', '@repo/bot-kit']) => {
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), '{"type":"module"}')
  for (const name of names) {
    const dependencyRoot = join(packageRoot, 'node_modules', name)
    await mkdir(dependencyRoot, { recursive: true })
    await writeFile(
      join(dependencyRoot, 'package.json'),
      JSON.stringify({ name, main: 'index.js' })
    )
    await writeFile(join(dependencyRoot, 'index.js'), '')
  }
}

const waitFor = async operation => {
  let lastError
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  throw lastError
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map(path => rm(path, { recursive: true, force: true })))
})

test('serve options default to loopback:4173 and safely accept flags or environment', () => {
  assert.deepEqual(parseServeOptions([], {}), { host: '127.0.0.1', port: 4173 })
  assert.deepEqual(parseServeOptions([], { HOST: 'localhost', PORT: '8123' }), {
    host: 'localhost',
    port: 8123
  })
  assert.deepEqual(parseServeOptions(['--host', '0.0.0.0', '--port=0'], {}), {
    host: '0.0.0.0',
    port: 0
  })
  assert.throws(() => parseServeOptions(['--port', '4173;echo bad'], {}), /Invalid port/)
  assert.throws(() => parseServeOptions(['--host', '../socket'], {}), /Invalid host/)
  assert.throws(() => parseServeOptions(['--unknown'], {}), /Unknown option/)
})

test('missing workspace dependencies trigger a frozen install and resolve from the package', async () => {
  const repoRoot = await temporaryDirectory('playground-install-')
  const packageRoot = join(repoRoot, 'bots/market-making')
  const bin = join(repoRoot, 'bin')
  const log = join(repoRoot, 'install.json')
  await mkdir(packageRoot, { recursive: true })
  await mkdir(bin)
  await writeFile(join(packageRoot, 'package.json'), '{"type":"module"}')
  await writeFile(
    join(bin, 'bun'),
    `#!/usr/bin/env node\nconst { mkdirSync, writeFileSync } = require('node:fs')\nconst { join } = require('node:path')\nwriteFileSync(process.env.INSTALL_LOG, JSON.stringify(process.argv.slice(2)))\nfor (const name of ['viem', '@repo/bot-kit']) { const root = join(process.env.PACKAGE_ROOT, 'node_modules', name); mkdirSync(root, { recursive: true }); writeFileSync(join(root, 'package.json'), JSON.stringify({ name, main: 'index.js' })); writeFileSync(join(root, 'index.js'), '') }\n`,
    { mode: 0o755 }
  )

  await ensureFrozenDependencies({
    repoRoot,
    packageRoot,
    executable: join(bin, 'bun'),
    env: { ...process.env, INSTALL_LOG: log, PACKAGE_ROOT: packageRoot }
  })

  assert.deepEqual(JSON.parse(await readFile(log, 'utf8')), ['install', '--frozen-lockfile'])
})

test('installed package dependencies do not trigger a needless install', async () => {
  const repoRoot = await temporaryDirectory('playground-installed-')
  const packageRoot = join(repoRoot, 'bots/market-making')
  await writeResolvableDependencies(packageRoot)

  assert.equal(
    await ensureFrozenDependencies({
      repoRoot,
      packageRoot,
      executable: join(repoRoot, 'must-not-run')
    }),
    false
  )
})

test('frozen install failures report the exact command and exit code', async () => {
  const repoRoot = await temporaryDirectory('playground-install-failure-')
  const packageRoot = join(repoRoot, 'bots/market-making')
  const executable = join(repoRoot, 'bun-failure')
  await writeResolvableDependencies(packageRoot, [])
  await writeFile(executable, '#!/usr/bin/env node\nprocess.exit(23)\n', { mode: 0o755 })

  await assert.rejects(ensureFrozenDependencies({ repoRoot, packageRoot, executable }), error => {
    assert.match(error.message, /bun-failure install --frozen-lockfile failed with exit code 23/)
    return true
  })
})

test('successful install clearly lists dependencies that remain unresolved', async () => {
  const repoRoot = await temporaryDirectory('playground-unresolved-')
  const packageRoot = join(repoRoot, 'bots/market-making')
  const executable = join(repoRoot, 'bun-noop')
  await writeResolvableDependencies(packageRoot, [])
  await writeFile(executable, '#!/usr/bin/env node\n', { mode: 0o755 })

  await assert.rejects(ensureFrozenDependencies({ repoRoot, packageRoot, executable }), error => {
    assert.match(error.message, /Frozen install completed/)
    assert.match(error.message, new RegExp(packageRoot.replaceAll('\\', '\\\\')))
    assert.match(error.message, /viem, @repo\/bot-kit/)
    return true
  })
})

test('static server returns correct content types, 404s, and an exact URL', async () => {
  const served = await temporaryDirectory('playground-http-')
  const outside = await temporaryDirectory('playground-http-outside-')
  await writeFile(
    join(served, 'index.html'),
    '<!doctype html><link rel="stylesheet" href="/app.css"><script src="/app.js"></script>'
  )
  await writeFile(join(served, 'app.js'), 'document.body.dataset.loaded = "yes"')
  await writeFile(join(served, 'app.css'), 'body { color: green }')
  await writeFile(join(served, '..valid.txt'), 'valid root file')
  await mkdir(join(served, 'assets'))
  await writeFile(join(served, 'assets', '..also-valid.txt'), 'valid nested file')
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await symlink(join(outside, 'secret.txt'), join(served, 'outside-link.txt'))
  const server = await startStaticServer(served, { host: '127.0.0.1', port: 0 })
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/)
    for (const [path, type] of [
      ['/', 'text/html; charset=utf-8'],
      ['/app.js', 'text/javascript; charset=utf-8'],
      ['/app.css', 'text/css; charset=utf-8']
    ]) {
      const response = await fetch(`${server.url}${path}`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), type)
    }
    assert.equal(await (await fetch(`${server.url}/..valid.txt`)).text(), 'valid root file')
    assert.equal(
      await (await fetch(`${server.url}/assets/..also-valid.txt`)).text(),
      'valid nested file'
    )
    assert.equal((await fetch(`${server.url}/missing`)).status, 404)
    for (const path of [
      '/../secret',
      '/%2e%2e%2fsecret',
      '/%2e%2e%2Fsecret',
      '/outside-link.txt'
    ]) {
      assert.equal((await fetch(`${server.url}${path}`)).status, 404, path)
    }
    assert.equal((await fetch(`${server.url}/malformed%`)).status, 404)
    assert.equal((await fetch(`${server.url}/`)).status, 200)
  } finally {
    await server.close()
  }
})

test('static server returns 404 when a file disappears between metadata and stream open', async () => {
  const served = await temporaryDirectory('playground-http-open-race-')
  const disappearing = join(served, 'disappearing.txt')
  await writeFile(join(served, 'index.html'), 'healthy')
  await writeFile(disappearing, 'must not be served')
  let deletionInjected = false
  const server = await startStaticServer(served, {
    createFileStream(path) {
      if (path === disappearing) {
        deletionInjected = true
        unlinkSync(path)
      }
      return createReadStream(path)
    }
  })
  try {
    const response = await fetch(`${server.url}/disappearing.txt`)
    assert.equal(deletionInjected, true)
    assert.equal(response.status, 404)
    assert.equal(await response.text(), 'Not found')
    assert.equal((await fetch(`${server.url}/`)).status, 200)
  } finally {
    await server.close()
  }
})

test('static server safely terminates a response on a stream error after open', async () => {
  const served = await temporaryDirectory('playground-http-stream-error-')
  await writeFile(join(served, 'index.html'), 'healthy')
  await writeFile(join(served, 'broken.txt'), 'metadata only')
  const server = await startStaticServer(served, {
    createFileStream(path) {
      if (!path.endsWith('broken.txt')) return createReadStream(path)
      const stream = new PassThrough()
      setImmediate(() => {
        stream.emit('open', 1)
        stream.write('partial')
        setImmediate(() => stream.destroy(new Error('injected read failure')))
      })
      return stream
    }
  })
  try {
    await assert.rejects(fetch(`${server.url}/broken.txt`).then(response => response.text()))
    assert.equal((await fetch(`${server.url}/`)).status, 200)
  } finally {
    await server.close()
  }
})

test('static server reports a clear port conflict instead of false success', async () => {
  const served = await temporaryDirectory('playground-conflict-')
  await writeFile(join(served, 'index.html'), 'ok')
  const blocker = createServer()
  await new Promise((resolve, reject) => {
    blocker.once('error', reject)
    blocker.listen(0, '127.0.0.1', resolve)
  })
  const address = blocker.address()
  assert.ok(address && typeof address !== 'string')
  try {
    await assert.rejects(
      startStaticServer(served, { host: '127.0.0.1', port: address.port }),
      new RegExp(`Cannot serve playground on 127\\.0\\.0\\.1:${address.port}.*already in use`)
    )
  } finally {
    await new Promise(resolve => blocker.close(resolve))
  }
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`launcher prints its URL, serves the app, and cleans up on ${signal}`, async () => {
    const child = spawn(process.execPath, [launcher, '--port', '0'], {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    try {
      const url = await waitFor(() => {
        const match = stdout.match(/Playground ready: (http:\/\/127\.0\.0\.1:\d+)/)
        assert.ok(match, `${stdout}\n${stderr}`)
        return match[1]
      })
      const response = await fetch(url)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type') ?? '', /^text\/html/)
      child.kill(signal)
      const result = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code, closeSignal) => resolve({ code, signal: closeSignal }))
      })
      assert.deepEqual(result, { code: 0, signal: null })
      await assert.rejects(fetch(url))
      await assert.rejects(access(join(root, 'playground/dist')), { code: 'ENOENT' })
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  })
}
