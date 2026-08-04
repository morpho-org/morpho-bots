import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  chromiumAvailability,
  discoverChromium,
  inspectProcessGroup,
  prepareFreshDist,
  spawnOwnedProcess,
  startStaticServer,
  terminateOwnedProcessTree
} from './playground-smoke-support.mjs'

const temporaryDirectories = []
const smokeScript = fileURLToPath(new URL('./playground-smoke.mjs', import.meta.url))
const chromium = await chromiumAvailability()
const t = chromium.path ? test : test.skip
const n = name => (chromium.path ? name : `${name} — ${chromium.reason}`)
const temporaryDirectory = async prefix => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

test.after(async () => {
  await Promise.all(
    temporaryDirectories.map(directory => rm(directory, { recursive: true, force: true }))
  )
})

const waitFor = async (operation, attempts = 200) => {
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  throw lastError
}

const processExists = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

const processStatus = async pid => {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8')
    return {
      pid,
      ppid: Number(status.match(/^PPid:\s+(\d+)/m)?.[1]),
      state: status.match(/^State:\s+(\S+)/m)?.[1]
    }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined
    throw error
  }
}

const processGroupOf = async pid => {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
  const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
  return Number(fields[2])
}

const waitForProcessesGone = async pids =>
  waitFor(async () => {
    const remaining = (await Promise.all(pids.map(processStatus))).filter(Boolean)
    assert.deepEqual(remaining, [])
  })

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} at the temp creation boundary removes the created directory`, async () => {
    const isolatedTmp = await temporaryDirectory(
      `playground-temp-boundary-${signal.toLowerCase()}-`
    )
    const readyFile = join(isolatedTmp, 'temp-created')
    const releaseFile = join(isolatedTmp, 'release-temp-creation')
    const smoke = spawn(process.execPath, [smokeScript], {
      env: {
        ...process.env,
        CHROMIUM_PATH: process.execPath,
        PLAYGROUND_SMOKE_TEMP_BOUNDARY_READY_FILE: readyFile,
        PLAYGROUND_SMOKE_TEMP_BOUNDARY_RELEASE_FILE: releaseFile,
        TMPDIR: isolatedTmp
      },
      stdio: 'ignore'
    })
    try {
      const createdDirectory = await waitFor(async () => readFile(readyFile, 'utf8'))
      assert.match(createdDirectory, /market-making-playground-dist-/)
      smoke.kill(signal)
      const result = await new Promise((resolve, reject) => {
        smoke.once('error', reject)
        smoke.once('close', (code, closeSignal) => resolve({ code, signal: closeSignal }))
      })

      assert.deepEqual(result, { code: null, signal })
      assert.deepEqual(
        (await readdir(isolatedTmp)).filter(name =>
          name.startsWith('market-making-playground-dist-')
        ),
        []
      )
    } finally {
      if (smoke.exitCode === null && smoke.signalCode === null) smoke.kill('SIGKILL')
    }
  })
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} during a slow build lets the build parent reap its descendant`, async () => {
    const isolatedTmp = await temporaryDirectory(`playground-signal-${signal.toLowerCase()}-`)
    const bin = join(isolatedTmp, 'bin')
    const ready = join(isolatedTmp, 'build-ready')
    const pidFile = join(isolatedTmp, 'build-pid')
    const descendantPidFile = join(isolatedTmp, 'build-descendant-pid')
    const forwardingFile = join(isolatedTmp, 'build-forwarding')
    const prematureSignalFile = join(isolatedTmp, 'build-descendant-signalled-before-parent')
    await mkdir(bin)
    const fakeBun = join(bin, 'bun')
    await writeFile(
      fakeBun,
      `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const child = spawn(process.execPath, ['-e', \`
  const { existsSync, writeFileSync } = require('node:fs')
  writeFileSync(process.env.SMOKE_BUILD_DESCENDANT_PID_FILE, String(process.pid))
  process.on('SIGTERM', () => {
    if (!existsSync(process.env.SMOKE_BUILD_FORWARDING_FILE)) {
      writeFileSync(process.env.SMOKE_BUILD_PREMATURE_SIGNAL_FILE, 'signalled with process group')
    }
    setTimeout(() => process.exit(0), 50)
  })
  setInterval(() => {}, 1000)
\`], { stdio: 'ignore' })
writeFileSync(process.env.SMOKE_BUILD_PID_FILE, String(process.pid))
writeFileSync(process.env.SMOKE_BUILD_READY_FILE, 'ready')
process.on('SIGTERM', () => {
  writeFileSync(process.env.SMOKE_BUILD_FORWARDING_FILE, 'forwarding')
  child.kill('SIGTERM')
})
child.on('close', () => process.exit(0))
`
    )
    await chmod(fakeBun, 0o755)

    const smoke = spawn(process.execPath, [smokeScript], {
      env: {
        ...process.env,
        CHROMIUM_PATH: process.execPath,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        SMOKE_BUILD_PID_FILE: pidFile,
        SMOKE_BUILD_READY_FILE: ready,
        SMOKE_BUILD_DESCENDANT_PID_FILE: descendantPidFile,
        SMOKE_BUILD_FORWARDING_FILE: forwardingFile,
        SMOKE_BUILD_PREMATURE_SIGNAL_FILE: prematureSignalFile,
        TMPDIR: isolatedTmp
      },
      stdio: 'ignore'
    })
    let buildPid
    let descendantPid
    try {
      await waitFor(async () => {
        await readFile(ready)
        descendantPid = Number(await readFile(descendantPidFile, 'utf8'))
        const temporaryDists = (await readdir(isolatedTmp)).filter(name =>
          name.startsWith('market-making-playground-dist-')
        )
        assert.equal(temporaryDists.length, 1)
      })
      buildPid = Number(await readFile(pidFile, 'utf8'))
      smoke.kill(signal)
      const result = await new Promise((resolve, reject) => {
        smoke.once('error', reject)
        smoke.once('close', (code, closeSignal) => resolve({ code, signal: closeSignal }))
      })

      assert.deepEqual(result, { code: null, signal })
      assert.deepEqual(
        (await readdir(isolatedTmp)).filter(name =>
          name.startsWith('market-making-playground-dist-')
        ),
        []
      )
      await waitForProcessesGone([buildPid, descendantPid])
      await assert.rejects(readFile(prematureSignalFile), { code: 'ENOENT' })
    } finally {
      if (smoke.exitCode === null && smoke.signalCode === null) smoke.kill('SIGKILL')
      if (buildPid && processExists(buildPid)) process.kill(buildPid, 'SIGKILL')
      if (descendantPid && processExists(descendantPid)) process.kill(descendantPid, 'SIGKILL')
    }
  })
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} before Chromium readiness lets the browser parent reap its descendant`, async () => {
    const isolatedTmp = await temporaryDirectory(
      `playground-browser-startup-${signal.toLowerCase()}-`
    )
    const wrapper = join(isolatedTmp, 'chromium-starting-wrapper')
    const wrapperPidFile = join(isolatedTmp, 'chromium-starting-wrapper-pid')
    const childPidFile = join(isolatedTmp, 'chromium-starting-child-pid')
    const forwardingFile = join(isolatedTmp, 'chromium-starting-forwarding')
    const prematureSignalFile = join(isolatedTmp, 'chromium-starting-premature-signal')
    await writeFile(
      wrapper,
      `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const child = spawn(process.execPath, ['-e', \`
  const { existsSync, writeFileSync } = require('node:fs')
  writeFileSync(process.env.SMOKE_STARTING_CHILD_PID_FILE, String(process.pid))
  process.on('SIGTERM', () => {
    if (!existsSync(process.env.SMOKE_STARTING_FORWARDING_FILE)) {
      writeFileSync(process.env.SMOKE_STARTING_PREMATURE_SIGNAL_FILE, 'group-signalled')
    }
    setTimeout(() => process.exit(0), 50)
  })
  setInterval(() => {}, 1000)
\`], { stdio: 'ignore' })
writeFileSync(process.env.SMOKE_STARTING_WRAPPER_PID_FILE, String(process.pid))
process.on('SIGTERM', () => {
  writeFileSync(process.env.SMOKE_STARTING_FORWARDING_FILE, 'forwarding')
  child.kill('SIGTERM')
})
child.on('close', () => process.exit(0))
`
    )
    await chmod(wrapper, 0o755)
    const smoke = spawn(process.execPath, [smokeScript], {
      env: {
        ...process.env,
        CHROMIUM_PATH: wrapper,
        SMOKE_STARTING_WRAPPER_PID_FILE: wrapperPidFile,
        SMOKE_STARTING_CHILD_PID_FILE: childPidFile,
        SMOKE_STARTING_FORWARDING_FILE: forwardingFile,
        SMOKE_STARTING_PREMATURE_SIGNAL_FILE: prematureSignalFile,
        TMPDIR: isolatedTmp
      },
      stdio: 'ignore'
    })
    let recordedPids = []
    try {
      await waitFor(async () => {
        await Promise.all([readFile(wrapperPidFile), readFile(childPidFile)])
      })
      const wrapperPid = Number(await readFile(wrapperPidFile, 'utf8'))
      recordedPids = (await inspectProcessGroup(await processGroupOf(wrapperPid))).map(
        ({ pid }) => pid
      )
      smoke.kill(signal)
      const result = await new Promise((resolve, reject) => {
        smoke.once('error', reject)
        smoke.once('close', (code, closeSignal) => resolve({ code, signal: closeSignal }))
      })

      assert.deepEqual(result, { code: null, signal })
      await waitForProcessesGone(recordedPids)
      await assert.rejects(readFile(prematureSignalFile), { code: 'ENOENT' })
    } finally {
      if (smoke.exitCode === null && smoke.signalCode === null) smoke.kill('SIGKILL')
      for (const pid of recordedPids) {
        if (processExists(pid)) process.kill(pid, 'SIGKILL')
      }
    }
  })
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  const testName = `${signal} after Chromium readiness closes the browser gracefully and reaps its tree`
  t(n(testName), { timeout: 60_000 }, async () => {
    const isolatedTmp = await temporaryDirectory(`playground-browser-${signal.toLowerCase()}-`)
    const wrapper = join(isolatedTmp, 'chromium-wrapper')
    const wrapperPidFile = join(isolatedTmp, 'chromium-wrapper-pid')
    const directSignalFile = join(isolatedTmp, 'chromium-wrapper-direct-signal')
    const chromium = await discoverChromium()
    await writeFile(
      wrapper,
      `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const browser = spawn(${JSON.stringify(chromium)}, process.argv.slice(2), { stdio: 'inherit' })
writeFileSync(process.env.SMOKE_CHROMIUM_WRAPPER_PID_FILE, String(process.pid))
process.on('SIGTERM', () => {
  writeFileSync(process.env.SMOKE_CHROMIUM_DIRECT_SIGNAL_FILE, 'direct signal received')
  browser.kill('SIGTERM')
})
browser.on('close', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
`
    )
    await chmod(wrapper, 0o755)

    const smoke = spawn(process.execPath, [smokeScript], {
      env: {
        ...process.env,
        CHROMIUM_PATH: wrapper,
        SMOKE_CHROMIUM_WRAPPER_PID_FILE: wrapperPidFile,
        SMOKE_CHROMIUM_DIRECT_SIGNAL_FILE: directSignalFile,
        TMPDIR: isolatedTmp
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    smoke.stdout.setEncoding('utf8')
    smoke.stderr.setEncoding('utf8')
    let output = ''
    smoke.stdout.on('data', chunk => {
      output += chunk
    })
    smoke.stderr.on('data', chunk => {
      output += chunk
    })
    let recordedPids = []
    try {
      await waitFor(async () => {
        assert.match(output, /smoke environment:/)
      }, 3000)
      const wrapperPid = Number(await readFile(wrapperPidFile, 'utf8'))
      const processGroup = await processGroupOf(wrapperPid)
      recordedPids = (await inspectProcessGroup(processGroup)).map(({ pid }) => pid)
      assert.ok(recordedPids.length > 1, `expected a real Chromium tree, got ${recordedPids}`)

      smoke.kill(signal)
      const result = await new Promise((resolve, reject) => {
        smoke.once('error', reject)
        smoke.once('close', (code, closeSignal) => resolve({ code, signal: closeSignal }))
      })

      assert.deepEqual(result, { code: null, signal })
      await waitForProcessesGone(recordedPids)
      assert.equal(
        await readFile(directSignalFile).then(
          () => true,
          error => {
            if (error.code === 'ENOENT') return false
            throw error
          }
        ),
        false,
        output
      )
      assert.deepEqual(
        (await readdir(isolatedTmp)).filter(
          name =>
            name.startsWith('market-making-playground-dist-') ||
            name.startsWith('market-making-playground-')
        ),
        []
      )
    } finally {
      if (smoke.exitCode === null && smoke.signalCode === null) smoke.kill('SIGKILL')
      for (const pid of recordedPids) {
        if (processExists(pid)) process.kill(pid, 'SIGKILL')
      }
    }
  })
}

test(
  'bounded fallback terminates stubborn descendants deepest-first without zombies',
  { timeout: 30_000 },
  async () => {
    const isolatedTmp = await temporaryDirectory('playground-stubborn-tree-')
    const parentScript = join(isolatedTmp, 'stubborn-parent.mjs')
    const parentPidFile = join(isolatedTmp, 'parent-pid')
    const childPidFile = join(isolatedTmp, 'child-pid')
    await writeFile(
      parentScript,
      `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const child = spawn(process.execPath, ['-e', \`
  const { writeFileSync } = require('node:fs')
  writeFileSync(process.env.STUBBORN_CHILD_PID_FILE, String(process.pid))
  process.on('SIGTERM', () => {})
  setInterval(() => {}, 1000)
\`], { stdio: 'ignore' })
writeFileSync(process.env.STUBBORN_PARENT_PID_FILE, String(process.pid))
process.on('SIGTERM', () => {})
child.on('close', () => {})
setInterval(() => {}, 1000)
`
    )
    const owner = spawnOwnedProcess(process.execPath, [parentScript], {
      env: {
        ...process.env,
        STUBBORN_PARENT_PID_FILE: parentPidFile,
        STUBBORN_CHILD_PID_FILE: childPidFile
      },
      stdio: 'ignore'
    })
    let recordedPids = []
    try {
      await waitFor(async () => {
        await Promise.all([readFile(parentPidFile), readFile(childPidFile)])
      })
      recordedPids = (await inspectProcessGroup(owner.pid)).map(({ pid }) => pid)
      assert.ok(recordedPids.length >= 3, `expected owner+parent+child, got ${recordedPids}`)

      await terminateOwnedProcessTree(owner)
      await waitForProcessesGone(recordedPids)
    } finally {
      for (const pid of recordedPids) {
        if (processExists(pid)) process.kill(pid, 'SIGKILL')
      }
    }
  }
)

test('failed fresh build removes its temporary output and reports the child failure', async () => {
  const root = await temporaryDirectory('playground-failed-build-')
  const fakeBun = join(root, 'failing-bun')
  await writeFile(fakeBun, '#!/bin/sh\necho deliberate-build-failure >&2\nexit 23\n')
  await chmod(fakeBun, 0o755)

  await assert.rejects(
    prepareFreshDist({ root, executable: fakeBun }),
    /Fresh playground build failed with exit code 23[\s\S]*deliberate-build-failure/
  )
  assert.deepEqual(
    (await readdir(tmpdir())).filter(name => name.startsWith('market-making-playground-dist-')),
    []
  )
})

test('preparing the playground removes stale output and builds from an absent dist', async () => {
  const root = await temporaryDirectory('playground-build-test-')
  const dist = join(root, 'playground/dist')
  const bin = join(root, 'bin')
  await mkdir(dist, { recursive: true })
  await mkdir(bin)
  await writeFile(join(dist, 'stale-sentinel'), 'must be removed')
  const fakeBun = join(bin, 'bun')
  await writeFile(
    fakeBun,
    `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs')
const outdir = process.argv[process.argv.indexOf('--outdir') + 1]
if (!outdir) throw new Error('missing --outdir')
mkdirSync(outdir, { recursive: true })
writeFileSync(outdir + '/index.html', '<!doctype html><title>fresh</title>')
`
  )
  await chmod(fakeBun, 0o755)

  const prepared = await prepareFreshDist({ root, executable: fakeBun })

  assert.notEqual(prepared.dist, dist)
  assert.equal(
    await readFile(join(prepared.dist, 'index.html'), 'utf8'),
    '<!doctype html><title>fresh</title>'
  )
  await assert.rejects(readFile(join(dist, 'stale-sentinel')), { code: 'ENOENT' })
  await prepared.cleanup()
  await assert.rejects(readFile(join(prepared.dist, 'index.html')), { code: 'ENOENT' })
})

test('two static servers allocate distinct application ports and only serve their roots', async () => {
  const firstRoot = await temporaryDirectory('playground-server-one-')
  const secondRoot = await temporaryDirectory('playground-server-two-')
  await writeFile(join(firstRoot, 'index.html'), 'first')
  await writeFile(join(secondRoot, 'index.html'), 'second')

  const [first, second] = await Promise.all([
    startStaticServer(firstRoot),
    startStaticServer(secondRoot)
  ])
  try {
    assert.notEqual(first.port, second.port)
    assert.equal(await (await fetch(`http://127.0.0.1:${first.port}/`)).text(), 'first')
    assert.equal(await (await fetch(`http://127.0.0.1:${second.port}/`)).text(), 'second')
    assert.equal((await fetch(`http://127.0.0.1:${first.port}/%2e%2e%2fsecret`)).status, 404)
  } finally {
    await Promise.all([first.close(), second.close()])
  }
})

const concurrentSmokeTest =
  'two complete smoke runs use isolated builds and dynamic ports concurrently'
t(n(concurrentSmokeTest), { timeout: 30_000 }, async () => {
  const runs = Array.from({ length: 2 }, () => {
    const child = spawn(process.execPath, [smokeScript], { stdio: ['ignore', 'pipe', 'pipe'] })
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
    return new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
    })
  })

  const results = await Promise.all(runs)
  for (const result of results) {
    assert.deepEqual(
      { code: result.code, signal: result.signal },
      { code: 0, signal: null },
      `stdout (tail):\n${result.stdout.slice(-4000)}\nstderr (tail):\n${result.stderr.slice(-4000)}`
    )
    assert.equal(result.stdout.match(/browser CSP: PASS/g)?.length, 1)
    assert.equal(result.stdout.match(/browser smoke: PASS/g)?.length, 1)
  }
  const ports = results.map(({ stdout }) => Number(stdout.match(/appPort=(\d+)/)?.[1]))
  assert.equal(new Set(ports).size, 2)

  const evidence = results[0].stdout
    .split(/\r?\n/)
    .filter(line => line.startsWith('browser CSP: PASS') || line.startsWith('browser smoke: PASS'))
  process.stdout.write(`${evidence.join('\n')}\n`)
})

test('invalid CHROMIUM_PATH fails clearly', async () => {
  await assert.rejects(
    discoverChromium({ override: '/definitely/missing/chromium', path: '' }),
    /CHROMIUM_PATH.*not an executable file/
  )
})

test('Chromium availability reports a clear skip reason when no executable is discoverable', async () => {
  const availability = await chromiumAvailability({
    override: '/definitely/missing/chromium',
    path: ''
  })

  assert.deepEqual(availability, {
    path: undefined,
    reason:
      'Chromium-dependent test skipped: CHROMIUM_PATH is not an executable file: /definitely/missing/chromium'
  })
})

test('Chromium availability returns the discovered executable without invoking a shell', async () => {
  const bin = await temporaryDirectory('chromium-availability-test-')
  const chromium = join(bin, 'chromium')
  await writeFile(chromium, '#!/bin/sh\nexit 0\n')
  await chmod(chromium, 0o755)

  assert.deepEqual(await chromiumAvailability({ override: '', path: bin }), {
    path: chromium,
    reason: undefined
  })
})

test('Chromium discovery follows an executable PATH symlink and returns its canonical target', async () => {
  const root = await temporaryDirectory('chromium-symlink-discovery-test-')
  const realBin = join(root, 'real-bin')
  const pathBin = join(root, 'path-bin')
  await Promise.all([mkdir(realBin), mkdir(pathBin)])
  const executable = join(realBin, 'chromium-real')
  const linkedChromium = join(pathBin, 'chromium')
  await writeFile(executable, '#!/bin/sh\nexit 0\n')
  await chmod(executable, 0o755)
  await symlink(executable, linkedChromium)

  assert.equal(await discoverChromium({ override: '', path: pathBin }), executable)
  assert.equal(await discoverChromium({ override: linkedChromium, path: '' }), executable)

  const nonExecutable = join(realBin, 'chromium-non-executable')
  await writeFile(nonExecutable, '#!/bin/sh\nexit 0\n')
  await assert.rejects(
    discoverChromium({ override: nonExecutable, path: '' }),
    /CHROMIUM_PATH.*not an executable file/
  )

  const brokenLink = join(pathBin, 'broken-chromium')
  await symlink(join(realBin, 'missing-chromium'), brokenLink)
  await assert.rejects(
    discoverChromium({ override: brokenLink, path: '' }),
    /CHROMIUM_PATH.*not an executable file/
  )

  const firstLoop = join(pathBin, 'chromium-loop-a')
  const secondLoop = join(pathBin, 'chromium-loop-b')
  await symlink(secondLoop, firstLoop)
  await symlink(firstLoop, secondLoop)
  await assert.rejects(
    discoverChromium({ override: firstLoop, path: '' }),
    /CHROMIUM_PATH.*not an executable file/
  )

  const injectionMarker = join(root, 'shell-injection-marker')
  await assert.rejects(
    discoverChromium({ override: `./chromium; touch ${injectionMarker}`, path: '' }),
    /CHROMIUM_PATH must be an absolute executable path/
  )
  await assert.rejects(readFile(injectionMarker), { code: 'ENOENT' })
})
