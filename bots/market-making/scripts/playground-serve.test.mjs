import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createReadStream, unlinkSync } from 'node:fs'
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { createPortableProcessRunner } from './playground-process.mjs'
import {
  cleanupOwnedResources,
  ensureFrozenDependencies,
  isSuccessfulSignalShutdown,
  parseServeOptions
} from './playground-serve-support.mjs'
import { prepareFreshDist, startStaticServer } from './playground-smoke-support.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const launcher = fileURLToPath(new URL('./playground-serve.mjs', import.meta.url))
const temporaryDirectories = []
const execFileAsync = promisify(execFile)

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

const assertProcessNotLive = async pid => {
  let state = 'missing'
  try {
    state = (await readFile(`/proc/${pid}/stat`, 'utf8')).split(' ')[2]
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  assert.ok(state === 'missing' || state === 'Z', `process ${pid} remains live in state ${state}`)
}

const rawHttpRequest = (server, method, path = '/malformed%') =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ host: server.host, port: server.port })
    let response = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', chunk => {
      response += chunk
    })
    socket.once('end', () => resolve(response))
    socket.once('connect', () => {
      socket.write(`${method} ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`)
    })
  })

const writeBlockingBun = async root => {
  const executable = join(root, 'blocking-bun')
  await writeFile(
    executable,
    `#!/bin/sh\ntrap '' TERM\nsh -c 'trap "" TERM; echo $$ > "$PID_FILE"; while :; do sleep 1; done' &\nwait\n`,
    { mode: 0o755 }
  )
  return executable
}

test.after(async () => {
  await Promise.all(temporaryDirectories.map(path => rm(path, { recursive: true, force: true })))
})

test('serve options accept only loopback hosts and normalize bracketed IPv6', () => {
  assert.deepEqual(parseServeOptions([], {}), { host: '127.0.0.1', port: 4173 })
  assert.deepEqual(parseServeOptions([], { HOST: 'localhost', PORT: '8123' }), {
    host: 'localhost',
    port: 8123
  })
  assert.deepEqual(parseServeOptions(['--host', '[::1]', '--port=0'], {}), {
    host: '::1',
    port: 0
  })
  assert.deepEqual(parseServeOptions(['--host=::1'], {}), { host: '::1', port: 4173 })
  assert.throws(() => parseServeOptions(['--host', '0.0.0.0'], {}), /loopback/)
  assert.throws(() => parseServeOptions(['--port', '4173;echo bad'], {}), /Invalid port/)
  assert.throws(() => parseServeOptions(['--host', '../socket'], {}), /Invalid host/)
  assert.throws(() => parseServeOptions(['--unknown'], {}), /Unknown option/)
})

test('a frozen install runs unconditionally and resolves partial workspace dependencies', async () => {
  const repoRoot = await temporaryDirectory('playground-install-')
  const packageRoot = join(repoRoot, 'bots/market-making')
  const bin = join(repoRoot, 'bin')
  const log = join(repoRoot, 'install.json')
  await writeResolvableDependencies(packageRoot, ['viem'])
  await mkdir(bin)
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

test('installed package dependencies still run the fast frozen lockfile check', async () => {
  const repoRoot = await temporaryDirectory('playground-installed-')
  const packageRoot = join(repoRoot, 'bots/market-making')
  await writeResolvableDependencies(packageRoot)

  const calls = []
  await ensureFrozenDependencies({
    repoRoot,
    packageRoot,
    processRunner: async command => {
      calls.push(command)
      return { code: 0, signal: null, stdout: '', stderr: '' }
    }
  })
  assert.deepEqual(
    calls.map(call => call.args),
    [['install', '--frozen-lockfile']]
  )
})

test('declared market-making package bin retains its original tracked mode', async () => {
  const { stdout } = await execFileAsync('git', ['ls-files', '--stage', '--', 'src/index.ts'], {
    cwd: root
  })
  assert.match(stdout, /^100644 /)
})

for (const [platform, originalMode] of [
  ['linux', 0o644],
  ['darwin', 0o755]
]) {
  test(`frozen launcher install restores package bin mode ${originalMode.toString(8)} and content (${platform})`, async () => {
    const repoRoot = await temporaryDirectory(`playground-clean-install-${platform}-`)
    const packageRoot = join(repoRoot, 'bots/market-making')
    const entrypoint = join(packageRoot, 'src/index.ts')
    const executable = join(repoRoot, 'fake-bun')
    const source = 'console.log("package bin content must stay unchanged")\n'
    await writeResolvableDependencies(packageRoot)
    await mkdir(join(packageRoot, 'src'), { recursive: true })
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ type: 'module', bin: { mm: './src/index.ts' } })
    )
    await writeFile(entrypoint, source, { mode: originalMode })
    await writeFile(
      executable,
      '#!/usr/bin/env node\nrequire("node:fs").chmodSync(process.env.PACKAGE_BIN, 0o755)\n',
      { mode: 0o755 }
    )
    await execFileAsync('git', ['init', '--quiet'], { cwd: repoRoot })
    await execFileAsync('git', ['add', '.'], { cwd: repoRoot })
    await execFileAsync(
      'git',
      [
        '-c',
        'user.name=test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--quiet',
        '-m',
        'baseline'
      ],
      { cwd: repoRoot }
    )
    const status = async () =>
      (await execFileAsync('git', ['status', '--short'], { cwd: repoRoot })).stdout
    assert.equal(await status(), '')

    const processRunner = createPortableProcessRunner({ platform })
    for (let install = 0; install < 2; install++) {
      await ensureFrozenDependencies({
        repoRoot,
        packageRoot,
        executable,
        env: { ...process.env, PACKAGE_BIN: entrypoint },
        processRunner
      })
      assert.equal(await status(), '')
      assert.equal(await readFile(entrypoint, 'utf8'), source)
      assert.equal((await stat(entrypoint)).mode & 0o777, originalMode)
    }
  })
}

for (const outcome of ['failure', 'abort']) {
  test(`frozen install ${outcome} restores declared bin permissions and content`, async () => {
    const repoRoot = await temporaryDirectory(`playground-restore-${outcome}-`)
    const packageRoot = join(repoRoot, 'bots/market-making')
    const entrypoint = join(packageRoot, 'src/index.ts')
    const source = 'unchanged through failed install\n'
    await writeResolvableDependencies(packageRoot)
    await mkdir(join(packageRoot, 'src'), { recursive: true })
    await writeFile(join(repoRoot, 'package.json'), JSON.stringify({ workspaces: ['bots/*'] }))
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({ type: 'module', bin: './src/index.ts' })
    )
    await writeFile(entrypoint, source, { mode: 0o644 })
    const controller = new AbortController()
    await assert.rejects(
      ensureFrozenDependencies({
        repoRoot,
        packageRoot,
        signal: controller.signal,
        processRunner: async () => {
          await chmod(entrypoint, 0o755)
          if (outcome === 'abort') controller.abort(new Error('install interrupted'))
          return { code: outcome === 'failure' ? 23 : 0, signal: null }
        }
      }),
      outcome === 'failure' ? /exit code 23/ : /install interrupted/
    )
    assert.equal((await stat(entrypoint)).mode & 0o777, 0o644)
    assert.equal(await readFile(entrypoint, 'utf8'), source)
  })
}

test('permission restoration aggregates every failure with the install error', async () => {
  const repoRoot = await temporaryDirectory('playground-restore-errors-')
  const packageRoot = join(repoRoot, 'bots/market-making')
  await writeResolvableDependencies(packageRoot)
  await mkdir(join(packageRoot, 'src'), { recursive: true })
  await writeFile(join(repoRoot, 'package.json'), JSON.stringify({ workspaces: ['bots/*'] }))
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ bin: { first: 'src/one.js', second: 'src/two.js' } })
  )
  await writeFile(join(packageRoot, 'src/one.js'), '', { mode: 0o644 })
  await writeFile(join(packageRoot, 'src/two.js'), '', { mode: 0o755 })
  const restorationAttempts = []
  await assert.rejects(
    ensureFrozenDependencies({
      repoRoot,
      packageRoot,
      chmodFile: async path => {
        restorationAttempts.push(path)
        throw new Error(`refused ${path}`)
      },
      processRunner: async () => ({ code: 23, signal: null })
    }),
    error => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors.length, 3)
      assert.match(error.errors[0].message, /exit code 23/)
      assert.equal(
        error.errors.filter(item => /Could not restore permissions/.test(item.message)).length,
        2
      )
      return true
    }
  )
  assert.equal(restorationAttempts.length, 2)
})

test('bin mode protection is non-destructive on Windows', async () => {
  const repoRoot = await temporaryDirectory('playground-windows-modes-')
  const packageRoot = join(repoRoot, 'bots/market-making')
  await writeResolvableDependencies(packageRoot)
  await ensureFrozenDependencies({
    repoRoot,
    packageRoot,
    platform: 'win32',
    chmodFile: async () => {
      throw new Error('chmod must not run on Windows')
    },
    processRunner: async () => ({ code: 0, signal: null })
  })
})

test('workspace bin discovery skips escaping and symlink targets', async () => {
  const repoRoot = await temporaryDirectory('playground-safe-bin-metadata-')
  const packageRoot = join(repoRoot, 'bots/market-making')
  const outside = join(repoRoot, 'outside.js')
  await writeResolvableDependencies(packageRoot)
  await writeFile(outside, 'outside\n', { mode: 0o644 })
  await symlink(outside, join(packageRoot, 'linked-bin.js'))
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({
      bin: { escaping: '../../outside.js', linked: 'linked-bin.js' },
      type: 'module'
    })
  )
  let restorationAttempted = false
  await ensureFrozenDependencies({
    repoRoot,
    packageRoot,
    chmodFile: async () => {
      restorationAttempted = true
    },
    processRunner: async () => ({ code: 0, signal: null })
  })
  assert.equal(restorationAttempted, false)
  assert.equal((await stat(outside)).mode & 0o777, 0o644)
  assert.equal(await readFile(outside, 'utf8'), 'outside\n')
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

test('frozen dependency install honors a pre-aborted signal without running', async () => {
  const repoRoot = await temporaryDirectory('playground-install-aborted-')
  const packageRoot = join(repoRoot, 'bots/market-making')
  await writeResolvableDependencies(packageRoot)
  const controller = new AbortController()
  controller.abort(new Error('pre-aborted install'))
  let ran = false
  await assert.rejects(
    ensureFrozenDependencies({
      repoRoot,
      packageRoot,
      signal: controller.signal,
      processRunner: async () => {
        ran = true
      }
    }),
    /pre-aborted install/
  )
  assert.equal(ran, false)
})

test('signal during frozen install kills its descendant tree', { timeout: 10_000 }, async () => {
  const repoRoot = await temporaryDirectory('playground-install-signal-')
  const packageRoot = join(repoRoot, 'bots/market-making')
  const pidFile = join(repoRoot, 'descendant.pid')
  await writeResolvableDependencies(packageRoot)
  const executable = await writeBlockingBun(repoRoot)
  const controller = new AbortController()
  const pending = ensureFrozenDependencies({
    repoRoot,
    packageRoot,
    executable,
    env: { ...process.env, PID_FILE: pidFile },
    processRunner: createPortableProcessRunner({ terminationGraceMs: 25, forceKillGraceMs: 250 }),
    signal: controller.signal
  })
  const descendantPid = await waitFor(async () => Number(await readFile(pidFile, 'utf8')))
  controller.abort(new Error('install interrupted'))
  await assert.rejects(pending, /install interrupted/)
  await assertProcessNotLive(descendantPid)
})

test('fresh build preserves canonical dist, uses only temporary output, and validates index', async () => {
  const packageRoot = await temporaryDirectory('playground-fresh-injected-')
  const stale = join(packageRoot, 'playground/dist')
  await mkdir(stale, { recursive: true })
  await writeFile(join(stale, 'stale.txt'), 'stale')
  const calls = []
  const prepared = await prepareFreshDist({
    root: packageRoot,
    processRunner: async command => {
      calls.push(command)
      assert.deepEqual(command.args, [
        join(packageRoot, 'scripts/playground-build.mjs'),
        '--temporary'
      ])
      const dist = await mkdtemp(join(tmpdir(), 'market-making-playground-dist-'))
      temporaryDirectories.push(dist)
      await writeFile(join(dist, 'index.html'), 'fresh')
      return {
        code: 0,
        signal: null,
        stderr: '',
        stdout: `${JSON.stringify({ kind: 'market-making-playground-build', mode: 'temporary', path: dist })}\n`
      }
    }
  })
  try {
    assert.equal(await readFile(join(stale, 'stale.txt'), 'utf8'), 'stale')
    assert.equal(calls.length, 1)
    assert.equal(await readFile(join(prepared.dist, 'index.html'), 'utf8'), 'fresh')
  } finally {
    await prepared.cleanup()
  }
})

test(
  'signal during fresh build kills descendants and removes its temporary dist',
  { timeout: 10_000 },
  async () => {
    const packageRoot = await temporaryDirectory('playground-build-signal-')
    const pidFile = join(packageRoot, 'descendant.pid')
    const executable = await writeBlockingBun(packageRoot)
    const controller = new AbortController()
    let reported = false
    const runner = createPortableProcessRunner({ terminationGraceMs: 25, forceKillGraceMs: 250 })
    const pending = prepareFreshDist({
      root: packageRoot,
      executable,
      onDistCreated: () => {
        reported = true
      },
      processRunner: command => runner({ ...command, env: { ...process.env, PID_FILE: pidFile } }),
      signal: controller.signal
    })
    const descendantPid = await waitFor(async () => Number(await readFile(pidFile, 'utf8')))
    controller.abort(new Error('build interrupted'))
    await assert.rejects(pending, /build interrupted/)
    await assertProcessNotLive(descendantPid)
    assert.equal(reported, false)
  }
)

test('cleanup is idempotent and aggregates server and temporary-dist failures', async () => {
  const failures = [new Error('server close failed'), new Error('dist remove failed')]
  let serverCalls = 0
  let distCalls = 0
  const cleanup = cleanupOwnedResources({
    server: {
      close: async () => {
        serverCalls++
        throw failures[0]
      }
    },
    prepared: {
      cleanup: async () => {
        distCalls++
        throw failures[1]
      }
    }
  })
  const first = cleanup()
  assert.equal(first, cleanup())
  await assert.rejects(first, error => {
    assert.ok(error instanceof AggregateError)
    assert.deepEqual(error.errors, failures)
    return true
  })
  assert.equal(serverCalls, 1)
  assert.equal(distCalls, 1)
})

test('signal exit succeeds only for the exact signal reason after completely successful cleanup', () => {
  const controller = new AbortController()
  const reason = new Error('stopped')
  controller.abort(reason)
  assert.equal(isSuccessfulSignalShutdown({ error: reason, signal: controller.signal }), true)
  assert.equal(
    isSuccessfulSignalShutdown({
      error: new AggregateError([reason, new Error('tree survived')]),
      signal: controller.signal
    }),
    false
  )
  assert.equal(
    isSuccessfulSignalShutdown({
      cleanupError: new Error('dist cleanup failed'),
      error: reason,
      signal: controller.signal
    }),
    false
  )
})

test('static server allows only GET and HEAD with matching representation headers', async () => {
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
      const get = await fetch(`${server.url}${path}`)
      const head = await fetch(`${server.url}${path}`, { method: 'HEAD' })
      assert.equal(get.status, 200)
      assert.equal(head.status, get.status)
      for (const header of ['content-type', 'cache-control', 'content-length']) {
        assert.equal(head.headers.get(header), get.headers.get(header), `${path} ${header}`)
      }
      assert.equal(get.headers.get('content-type'), type)
      assert.equal(await head.text(), '')
    }
    assert.equal(await (await fetch(`${server.url}/..valid.txt`)).text(), 'valid root file')
    assert.equal(
      await (await fetch(`${server.url}/assets/..also-valid.txt`)).text(),
      'valid nested file'
    )
    assert.equal((await fetch(`${server.url}/missing`)).status, 404)
    const missingHead = await fetch(`${server.url}/missing`, { method: 'HEAD' })
    assert.equal(missingHead.status, 404)
    assert.equal(await missingHead.text(), '')
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT']) {
      const response = await rawHttpRequest(server, method)
      const [headers, body] = response.split('\r\n\r\n')
      assert.match(headers, /^HTTP\/1\.1 405 Method Not Allowed\r\n/i, method)
      assert.match(headers, /^Allow: GET, HEAD$/im, method)
      assert.equal(body, '', method)
    }
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
    const rawResponse = await rawHttpRequest(server, 'GET', '/broken.txt')
    const [headers, body] = rawResponse.split('\r\n\r\n')
    assert.match(headers, /^HTTP\/1\.1 200 OK\r\n/i)
    assert.match(headers, /^Content-Length: 13$/im)
    assert.match(body, /^partial(?:\r\n)?$/)
    assert.ok(Buffer.byteLength(body) < 13)
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

test('static server brackets IPv6 URLs while listening on normalized ::1', async t => {
  const served = await temporaryDirectory('playground-ipv6-')
  await writeFile(join(served, 'index.html'), 'ipv6')
  let server
  try {
    server = await startStaticServer(served, { host: '::1', port: 0 })
  } catch (error) {
    if (/EAFNOSUPPORT/.test(error.message)) {
      t.skip('IPv6 loopback unavailable')
      return
    }
    throw error
  }
  try {
    assert.match(server.url, /^http:\/\/\[::1\]:\d+$/)
    assert.equal(await (await fetch(server.url)).text(), 'ipv6')
  } finally {
    await server.close()
  }
})

test('static server close is bounded even with a held keep-alive connection', async () => {
  const served = await temporaryDirectory('playground-held-connection-')
  await writeFile(join(served, 'index.html'), 'held')
  const server = await startStaticServer(served, { closeTimeoutMs: 25 })
  const socket = createConnection({ host: server.host, port: server.port })
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n')
  const socketClosed = new Promise(resolve => socket.once('close', resolve))
  const started = performance.now()
  await server.close()
  assert.ok(performance.now() - started < 500)
  await socketClosed
  assert.equal(socket.destroyed, true)
  const replacement = createServer()
  await new Promise((resolve, reject) => {
    replacement.once('error', reject)
    replacement.listen(server.port, server.host, resolve)
  })
  await new Promise(resolve => replacement.close(resolve))
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`launcher prints its URL, serves the app, and cleans up on ${signal}`, async () => {
    const canonicalPath = join(root, 'playground/dist')
    const canonicalBefore = await stat(canonicalPath).catch(error => {
      if (error?.code === 'ENOENT') return undefined
      throw error
    })
    const canonicalIndexBefore = canonicalBefore
      ? await readFile(join(canonicalPath, 'index.html'))
      : undefined
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
      if (canonicalBefore) {
        const canonicalAfter = await stat(canonicalPath)
        assert.equal(canonicalAfter.dev, canonicalBefore.dev)
        assert.equal(canonicalAfter.ino, canonicalBefore.ino)
        assert.deepEqual(await readFile(join(canonicalPath, 'index.html')), canonicalIndexBefore)
      } else {
        await assert.rejects(access(canonicalPath), { code: 'ENOENT' })
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  })
}
