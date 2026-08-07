import assert from 'node:assert/strict'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  closeOwnedProcessTreeGracefully,
  discoverChromium,
  inspectProcessTree,
  smokeBudgets,
  spawnOwnedProcess,
  terminateOwnedProcessTree,
  terminateProcessSnapshot,
  waitForReadiness
} from './playground-smoke-support.mjs'

const temporaryDirectories = []
const harnessRuns = new Set()
const smokeScript = fileURLToPath(new URL('./playground-smoke.mjs', import.meta.url))
const chromiumPath = await discoverChromium()
const { cleanupTimeout, outerReadinessTimeout, browserTestTimeout } = smokeBudgets(process.env)
const temporaryDirectory = async prefix => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

test.after(async () => {
  await Promise.allSettled([...harnessRuns].map(run => cleanupHarnessRun(run)))
  await Promise.all(
    temporaryDirectories.map(directory => rm(directory, { recursive: true, force: true }))
  )
})

const processIdentity = async pid => {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')
    return {
      pid,
      state: fields[0],
      ppid: Number(fields[1]),
      processGroup: Number(fields[2]),
      startTime: fields[19]
    }
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return undefined
    throw error
  }
}

const sameIdentityExists = async expected => {
  const current = await processIdentity(expected.pid)
  return current?.startTime === expected.startTime
}

const waitForIdentitiesGoneWithin = async (identities, timeoutMs) =>
  waitForReadiness(
    async () => {
      const remaining = []
      for (const expected of identities) {
        if (await sameIdentityExists(expected)) remaining.push(await processIdentity(expected.pid))
      }
      assert.deepEqual(remaining, [])
    },
    {
      description: 'Chromium process identities to be reaped',
      timeoutMs,
      pollIntervalMs: 10
    }
  )
const waitForIdentitiesGone = identities => waitForIdentitiesGoneWithin(identities, 2_000)

const assertPortClosed = port =>
  new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`port ${port} did not reject a connection before the deadline`))
    }, 1_000)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      reject(new Error(`port ${port} still accepts connections`))
    })
    socket.once('error', error => {
      clearTimeout(timer)
      if (error.code === 'ECONNREFUSED') resolve()
      else reject(error)
    })
  })

const spawnSmoke = ({ env = process.env } = {}) => {
  const child = spawnOwnedProcess(process.execPath, [smokeScript], {
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const run = { child, stderr: '', stdout: '' }
  child.stdout.on('data', chunk => {
    run.stdout += chunk
  })
  child.stderr.on('data', chunk => {
    run.stderr += chunk
  })
  run.completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  harnessRuns.add(run)
  return run
}

const signalSmokeEntrypoint = async (run, signal) => {
  const tree = await inspectProcessTree(run.child.pid)
  const entrypoint = tree.find(
    processInfo => processInfo.ppid === run.child.pid && processInfo.state !== 'Z'
  )
  if (entrypoint) process.kill(entrypoint.pid, signal)
  else if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill(signal)
}

const cleanupHarnessRun = async run => {
  if (!run || run.cleaned) return
  run.cleaned = true
  const { child } = run
  let captured = []
  if (child.pid !== undefined) captured = await inspectProcessTree(child.pid)
  try {
    await closeOwnedProcessTreeGracefully(child, () => signalSmokeEntrypoint(run, 'SIGTERM'), {
      timeoutMs: Math.max(1_000, Math.floor(cleanupTimeout / 2))
    })
    if (captured.length) await waitForIdentitiesGone(captured)
  } catch {
    const latest = child.pid === undefined ? [] : await inspectProcessTree(child.pid)
    const attributable = new Map(
      [...captured, ...latest].map(processInfo => [
        `${processInfo.pid}:${processInfo.startTime}`,
        processInfo
      ])
    )
    await terminateProcessSnapshot([...attributable.values()])
    await terminateOwnedProcessTree(child)
    if (attributable.size) await waitForIdentitiesGone([...attributable.values()])
  } finally {
    await run.completion.catch(() => {})
    harnessRuns.delete(run)
  }
}

const successfulSmokeResult = async run => {
  const result = await run.completion
  if (result.code !== 0 || result.signal !== null) {
    throw new Error(
      `smoke failed with ${result.signal ?? `exit code ${result.code}`}\nstdout (tail):\n${run.stdout.slice(-4000)}\nstderr (tail):\n${run.stderr.slice(-4000)}`
    )
  }
  return { ...result, stderr: run.stderr, stdout: run.stdout }
}

const failedSmokeResult = async run => {
  const result = await run.completion
  assert.notEqual(result.code, 0, `smoke unexpectedly passed\n${run.stdout}\n${run.stderr}`)
  return { ...result, output: `${run.stdout}\n${run.stderr}` }
}

const terminalMutationProof =
  'persistence access and form-bus activity mutation proof covered 15 phases across 4 documents'

const runSmokesConcurrently = async runs => {
  try {
    return await Promise.all(runs.map(successfulSmokeResult))
  } finally {
    await Promise.allSettled(runs.map(run => cleanupHarnessRun(run)))
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  const testName = `${signal} after Chromium readiness closes the browser gracefully and reaps its tree`
  test(testName, { timeout: browserTestTimeout }, async () => {
    const isolatedTmp = await temporaryDirectory(`playground-browser-${signal.toLowerCase()}-`)
    const bin = join(isolatedTmp, 'bin')
    const fakeBun = join(bin, 'bun')
    const chromiumLink = join(bin, 'chromium')
    const wrapper = join(isolatedTmp, 'chromium-wrapper')
    const wrapperPidFile = join(isolatedTmp, 'chromium-wrapper-pid')
    await mkdir(bin)
    await symlink(chromiumPath, chromiumLink)
    const fakeBuiltHtml = `<!doctype html><title>signal test</title><div id="root" data-react-mounted="true"><div>mounted signal test</div></div><script>document.documentElement.dataset.playgroundReady = 'true'</script>`
    assert.match(
      fakeBuiltHtml,
      /<div id="root" data-react-mounted="true"><div>[^<]+<\/div><\/div><script>document\.documentElement\.dataset\.playgroundReady = 'true'<\/script>/,
      'fake build must mount a non-empty React root before declaring playground readiness'
    )
    await writeFile(
      fakeBun,
      `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs')
const outdir = process.argv[process.argv.indexOf('--outdir') + 1]
if (!outdir) throw new Error('missing --outdir')
mkdirSync(outdir, { recursive: true })
writeFileSync(outdir + '/index.html', ${JSON.stringify(fakeBuiltHtml)})
`
    )
    await chmod(fakeBun, 0o755)
    await writeFile(
      wrapper,
      `#!/usr/bin/env python3
import os
import sys

with open(os.environ['SMOKE_CHROMIUM_WRAPPER_PID_FILE'], 'w') as pid_file:
    pid_file.write(str(os.getpid()))
chromium = ${JSON.stringify(chromiumLink)}
os.execv(chromium, [chromium, *sys.argv[1:]])
`
    )
    await chmod(wrapper, 0o755)

    const run = spawnSmoke({
      env: {
        ...process.env,
        CHROMIUM_PATH: wrapper,
        SMOKE_CHROMIUM_WRAPPER_PID_FILE: wrapperPidFile,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        PLAYGROUND_SMOKE_BODY_DELAY_MS: '60000',
        TMPDIR: isolatedTmp
      }
    })
    const smoke = run.child
    const output = () => `${run.stdout}${run.stderr}`
    let recordedIdentities = []
    try {
      await waitForReadiness(
        () => {
          assert.match(output(), /smoke environment:/)
        },
        {
          child: smoke,
          childName: 'Smoke test',
          description: 'outer Chromium readiness marker',
          getStderr: output,
          timeoutMs: outerReadinessTimeout,
          pollIntervalMs: 10
        }
      )
      await readFile(wrapperPidFile, 'utf8')
      recordedIdentities = await inspectProcessTree(smoke.pid)
      assert.ok(
        recordedIdentities.length > 3,
        `expected the smoke and real Chromium tree, got ${recordedIdentities.map(({ pid }) => pid)}`
      )

      await signalSmokeEntrypoint(run, signal)
      const result = await run.completion

      assert.deepEqual(
        result,
        { code: null, signal },
        `smoke output (tail):\n${output().slice(-8000)}`
      )
      await waitForIdentitiesGone(recordedIdentities)
      assert.doesNotMatch(output(), /Graceful Chromium shutdown failed/)
      assert.deepEqual(
        (await readdir(isolatedTmp)).filter(
          name =>
            name.startsWith('market-making-playground-dist-') ||
            name.startsWith('market-making-playground-')
        ),
        [],
        `smoke output (tail):\n${output().slice(-8000)}`
      )
    } finally {
      await cleanupHarnessRun(run)
    }
  })
}

test(
  'outer timeout before readiness marker lets the actual entrypoint remove Chromium and temp dirs',
  { timeout: browserTestTimeout },
  async () => {
    const isolatedTmp = await temporaryDirectory('playground-browser-timeout-before-marker-')
    const bin = join(isolatedTmp, 'bin')
    const fakeBun = join(bin, 'bun')
    const wrapper = join(isolatedTmp, 'chromium-no-devtools')
    const chromePidFile = join(isolatedTmp, 'chrome-pid')
    await mkdir(bin)
    await writeFile(
      fakeBun,
      `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs')
const outdir = process.argv[process.argv.indexOf('--outdir') + 1]
mkdirSync(outdir, { recursive: true })
writeFileSync(outdir + '/index.html', '<!doctype html><title>timeout cleanup</title>')
`
    )
    await chmod(fakeBun, 0o755)
    await writeFile(
      wrapper,
      `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const args = process.argv.slice(2).filter(arg => !arg.startsWith('--remote-debugging-port='))
const chrome = spawn(${JSON.stringify(chromiumPath)}, args, { stdio: 'ignore' })
writeFileSync(process.env.SMOKE_TIMEOUT_CHROME_PID_FILE, String(chrome.pid))
const stop = () => chrome.kill('SIGTERM')
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
chrome.on('close', (code, signal) => process.exitCode = signal ? 1 : (code ?? 0))
`
    )
    await chmod(wrapper, 0o755)

    const run = spawnSmoke({
      env: {
        ...process.env,
        CHROMIUM_PATH: wrapper,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
        PLAYGROUND_SMOKE_READINESS_TIMEOUT_MS: '5000',
        SMOKE_TIMEOUT_CHROME_PID_FILE: chromePidFile,
        TMPDIR: isolatedTmp
      }
    })
    let captured = []
    try {
      await waitForReadiness(() => readFile(chromePidFile), {
        child: run.child,
        childName: 'Smoke test',
        description: 'real Chromium child before harness timeout',
        timeoutMs: 2_000
      })
      captured = await inspectProcessTree(run.child.pid)
      assert.ok(
        captured.length >= 4,
        `expected harness, smoke, wrapper, and Chrome; got ${captured.length}`
      )
      await assert.rejects(
        waitForReadiness(
          () => {
            assert.match(run.stdout, /smoke environment:/)
          },
          {
            child: run.child,
            childName: 'Smoke test',
            description: 'outer marker deliberately withheld',
            getStderr: () => run.stderr,
            timeoutMs: 200
          }
        ),
        /Timed out after 200ms waiting for outer marker deliberately withheld/
      )
    } finally {
      await cleanupHarnessRun(run)
    }
    await waitForIdentitiesGone(captured)
    assert.deepEqual(
      (await readdir(isolatedTmp)).filter(
        name =>
          name.startsWith('market-making-playground-dist-') ||
          name.startsWith('market-making-playground-')
      ),
      []
    )
  }
)

test(
  'one concurrent smoke failure gracefully cleans its still-running sibling',
  { timeout: browserTestTimeout },
  async () => {
    const isolatedTmp = await temporaryDirectory('playground-browser-concurrent-failure-')
    const sibling = spawnSmoke({
      env: {
        ...process.env,
        CHROMIUM_PATH: chromiumPath,
        PLAYGROUND_SMOKE_BODY_DELAY_MS: '60000',
        TMPDIR: isolatedTmp
      }
    })
    await waitForReadiness(
      () => {
        assert.match(sibling.stdout, /smoke environment:/)
      },
      {
        child: sibling.child,
        childName: 'Sibling smoke',
        description: 'sibling browser readiness',
        getStderr: () => sibling.stderr,
        timeoutMs: outerReadinessTimeout
      }
    )
    const siblingTree = await inspectProcessTree(sibling.child.pid)
    const failing = spawnSmoke({
      env: { ...process.env, CHROMIUM_PATH: '/definitely/missing/chromium' }
    })

    await assert.rejects(runSmokesConcurrently([sibling, failing]), /smoke failed with exit code 1/)
    await waitForIdentitiesGone(siblingTree)
    assert.deepEqual(
      (await readdir(isolatedTmp)).filter(name =>
        name.startsWith('market-making-playground-dist-')
      ),
      []
    )
  }
)

const runBuildTimeoutCase = async ({ publishFixture, timeoutMs, waitForFixture }) => {
  const isolatedTmp = await temporaryDirectory('playground-browser-build-timeout-')
  const bin = join(isolatedTmp, 'bin')
  const fakeBun = join(bin, 'bun')
  const buildPidFile = join(isolatedTmp, 'build-pid')
  const descendantPidFile = join(isolatedTmp, 'build-descendant-pid')
  const captureBarrierFile = join(isolatedTmp, 'build-capture-ready')
  const captureFile = join(isolatedTmp, 'build-capture.json')
  await mkdir(bin)
  await writeFile(
    fakeBun,
    `#!/usr/bin/env node
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const child = spawn(process.execPath, ['-e', \`setInterval(() => {}, 1000)\`], {
  stdio: 'ignore'
})
writeFileSync(process.env.PLAYGROUND_SMOKE_BUILD_CAPTURE_BARRIER_FILE, '')
if (${publishFixture}) {
  setTimeout(() => {
    writeFileSync(process.env.SMOKE_BUILD_PID_FILE, String(process.pid))
    writeFileSync(process.env.SMOKE_BUILD_DESCENDANT_PID_FILE, String(child.pid))
  }, 250)
}
child.on('close', () => process.exit(0))
setInterval(() => {}, 1000)
`
  )
  await chmod(fakeBun, 0o755)
  const run = spawnSmoke({
    env: {
      ...process.env,
      CHROMIUM_PATH: chromiumPath,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
      PLAYGROUND_SMOKE_BUILD_CAPTURE_BARRIER_FILE: captureBarrierFile,
      PLAYGROUND_SMOKE_BUILD_CAPTURE_FILE: captureFile,
      PLAYGROUND_SMOKE_BUILD_TIMEOUT_MS: String(timeoutMs),
      SMOKE_BUILD_PID_FILE: buildPidFile,
      SMOKE_BUILD_DESCENDANT_PID_FILE: descendantPidFile,
      TMPDIR: isolatedTmp
    }
  })
  let captured = [await processIdentity(run.child.pid)].filter(Boolean)
  if (waitForFixture) {
    await waitForReadiness(
      () => Promise.all([readFile(buildPidFile), readFile(descendantPidFile)]),
      {
        child: run.child,
        childName: 'Smoke test',
        description: 'post-spawn build process capture',
        getStderr: () => run.stderr,
        timeoutMs: 2_000
      }
    )
    captured = await inspectProcessTree(run.child.pid)
    assert.ok(captured.length >= 4, `expected owned build tree, got ${captured.length}`)
  }

  await assert.rejects(
    successfulSmokeResult(run),
    new RegExp(`Timed out after ${timeoutMs}ms during fresh playground build`)
  )
  const recordedBuildTree = JSON.parse(await readFile(captureFile, 'utf8'))
  assert.equal(recordedBuildTree.kind, 'market-making-playground-build-process-tree')
  assert.equal(recordedBuildTree.rootPid, recordedBuildTree.processes[0]?.pid)
  assert.ok(
    recordedBuildTree.processes.length >= 4,
    `expected the build subreaper, build runner, fake Bun, and descendant; got ${JSON.stringify(recordedBuildTree)}`
  )
  captured = [
    ...captured,
    ...recordedBuildTree.processes.filter(
      processInfo =>
        !captured.some(
          existing =>
            existing.pid === processInfo.pid && existing.startTime === processInfo.startTime
        )
    )
  ]
  await cleanupHarnessRun(run)

  await waitForIdentitiesGone(captured)
  assert.deepEqual(
    (await readdir(isolatedTmp)).filter(name => name.startsWith('market-making-playground-dist-')),
    []
  )
  await Promise.all([rm(captureFile), rm(captureBarrierFile)])
  await assert.rejects(readFile(captureFile, 'utf8'), { code: 'ENOENT' })
  await assert.rejects(readFile(captureBarrierFile, 'utf8'), { code: 'ENOENT' })
  return { buildPidFile, captured, descendantPidFile }
}

test(
  'build timeout captures and reaps pre-readiness and post-spawn process trees',
  { timeout: browserTestTimeout },
  async () => {
    const preReadiness = await runBuildTimeoutCase({
      publishFixture: false,
      timeoutMs: 100,
      waitForFixture: false
    })
    assert.ok(
      preReadiness.captured.length >= 5,
      `expected smoke harness plus build tree: ${preReadiness.captured}`
    )
    await assert.rejects(readFile(preReadiness.buildPidFile, 'utf8'), { code: 'ENOENT' })
    await assert.rejects(readFile(preReadiness.descendantPidFile, 'utf8'), { code: 'ENOENT' })

    const controlledLeak = spawnOwnedProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        stdio: 'ignore'
      }
    )
    try {
      const leakedIdentity = await processIdentity(controlledLeak.pid)
      assert.ok(leakedIdentity)
      await assert.rejects(
        waitForIdentitiesGoneWithin([leakedIdentity], 25),
        /Timed out after 25ms waiting for Chromium process identities to be reaped/
      )
    } finally {
      await terminateOwnedProcessTree(controlledLeak)
    }

    await runBuildTimeoutCase({ publishFixture: true, timeoutMs: 3_000, waitForFixture: true })
  }
)

test(
  'normal completion reaps every captured identity and removes all isolated resources',
  { timeout: browserTestTimeout },
  async () => {
    const isolatedTmp = await temporaryDirectory('playground-browser-normal-cleanup-')
    const run = spawnSmoke({
      env: {
        ...process.env,
        PLAYGROUND_SMOKE_BODY_DELAY_MS: '1000',
        TMPDIR: isolatedTmp
      }
    })
    await waitForReadiness(() => assert.match(run.stdout, /smoke environment:/), {
      child: run.child,
      childName: 'Smoke test',
      description: 'normal-completion process capture',
      getStderr: () => run.stderr,
      timeoutMs: outerReadinessTimeout
    })
    const captured = await inspectProcessTree(run.child.pid)
    assert.ok(captured.length > 3, `expected the smoke and Chromium tree, got ${captured.length}`)
    const smokeTemporaryRoot = run.stdout.match(/smokeTemporaryRoot=([^ ]+)/)?.[1]
    assert.ok(smokeTemporaryRoot)
    assert.ok((await readdir(smokeTemporaryRoot)).some(name => name.startsWith('profile-')))
    const ports = [...run.stdout.matchAll(/(?:appPort|chromiumDebugPort)=(\d+)/g)].map(match =>
      Number(match[1])
    )
    assert.equal(ports.length, 2)

    await successfulSmokeResult(run)
    await Promise.all([cleanupHarnessRun(run), cleanupHarnessRun(run)])

    await waitForIdentitiesGone(captured)
    await Promise.all(ports.map(assertPortClosed))
    await assert.rejects(readdir(smokeTemporaryRoot), { code: 'ENOENT' })
    assert.deepEqual(await readdir(isolatedTmp), [])
  }
)

test(
  'body timeout after readiness reaps Chromium, closes ports, and removes owned resources',
  { timeout: browserTestTimeout },
  async () => {
    const isolatedTmp = await temporaryDirectory('playground-browser-body-timeout-')
    const run = spawnSmoke({
      env: {
        ...process.env,
        PLAYGROUND_SMOKE_BODY_DELAY_MS: '60000',
        PLAYGROUND_SMOKE_BODY_TIMEOUT_MS: '100',
        TMPDIR: isolatedTmp
      }
    })
    await waitForReadiness(() => assert.match(run.stdout, /smoke environment:/), {
      child: run.child,
      childName: 'Smoke test',
      description: 'body-timeout process capture',
      getStderr: () => run.stderr,
      timeoutMs: outerReadinessTimeout
    })
    const captured = await inspectProcessTree(run.child.pid)
    const smokeTemporaryRoot = run.stdout.match(/smokeTemporaryRoot=([^ ]+)/)?.[1]
    assert.ok(smokeTemporaryRoot)
    const ports = [...run.stdout.matchAll(/(?:appPort|chromiumDebugPort)=(\d+)/g)].map(match =>
      Number(match[1])
    )

    await assert.rejects(
      successfulSmokeResult(run),
      /Timed out after 100ms during browser smoke body delay/
    )
    await cleanupHarnessRun(run)

    await waitForIdentitiesGone(captured)
    await Promise.all(ports.map(assertPortClosed))
    await assert.rejects(readdir(smokeTemporaryRoot), { code: 'ENOENT' })
    assert.deepEqual(await readdir(isolatedTmp), [])
  }
)

test(
  'full browser body gets a fresh deadline after startup has elapsed',
  { timeout: browserTestTimeout },
  async () => {
    const run = spawnSmoke({
      env: {
        ...process.env,
        PLAYGROUND_SMOKE_BODY_DELAY_MS: '6000',
        PLAYGROUND_SMOKE_READINESS_TIMEOUT_MS: '5000'
      }
    })
    const result = await runSmokesConcurrently([run])
    assert.match(result[0].stdout, /browser smoke: PASS/)
  }
)

test(
  'mobile Chromium smoke remains deployable below the /morpho-bots/ Pages subpath',
  { timeout: browserTestTimeout },
  async () => {
    const run = spawnSmoke({
      env: {
        ...process.env,
        PLAYGROUND_SMOKE_BASE_PATH: '/morpho-bots/',
        PLAYGROUND_SMOKE_VIEWPORT: 'mobile'
      }
    })
    const result = await runSmokesConcurrently([run])
    assert.match(result[0].stdout, /browser CSP: PASS/)
    assert.match(result[0].stdout, /browser smoke: PASS/)
    const summary = JSON.parse(result[0].stdout.trim().split(/\r?\n/).at(-1))
    assert.deepEqual(summary, {
      basePath: '/morpho-bots/',
      mobile: true,
      checks: 'passed',
      requests: summary.requests
    })
    assert.ok(summary.requests >= 3)
  }
)

test(
  'two complete smoke runs use isolated builds and dynamic ports concurrently',
  { timeout: browserTestTimeout },
  async () => {
    const isolatedRoots = await Promise.all(
      Array.from({ length: 2 }, (_, index) =>
        temporaryDirectory(`playground-browser-concurrent-${index}-`)
      )
    )
    const runs = isolatedRoots.map(isolatedTmp =>
      spawnSmoke({
        env: {
          ...process.env,
          PLAYGROUND_SMOKE_BODY_DELAY_MS: '1000',
          TMPDIR: isolatedTmp
        }
      })
    )
    await Promise.all(
      runs.map(run =>
        waitForReadiness(() => assert.match(run.stdout, /smoke environment:/), {
          child: run.child,
          childName: 'Smoke test',
          description: 'concurrent smoke process capture',
          getStderr: () => run.stderr,
          timeoutMs: outerReadinessTimeout
        })
      )
    )
    const capturedTrees = await Promise.all(runs.map(run => inspectProcessTree(run.child.pid)))
    const smokeTemporaryRoots = runs.map(run => run.stdout.match(/smokeTemporaryRoot=([^ ]+)/)?.[1])
    assert.equal(new Set(smokeTemporaryRoots).size, 2)
    for (const [index, isolatedTmp] of isolatedRoots.entries()) {
      const resources = await readdir(isolatedTmp)
      assert.ok(resources.some(name => name.startsWith('market-making-playground-dist-')))
      assert.ok(capturedTrees[index].length > 3)
      assert.ok(
        (await readdir(smokeTemporaryRoots[index])).some(name => name.startsWith('profile-'))
      )
    }

    const results = await runSmokesConcurrently(runs)
    for (const result of results) {
      assert.deepEqual(
        { code: result.code, signal: result.signal },
        { code: 0, signal: null },
        `stdout (tail):\n${result.stdout.slice(-4000)}\nstderr (tail):\n${result.stderr.slice(-4000)}`
      )
      assert.equal(result.stdout.match(/browser CSP: PASS/g)?.length, 1)
      assert.equal(result.stdout.match(/browser smoke: PASS/g)?.length, 1)
    }
    const appPorts = results.map(({ stdout }) => Number(stdout.match(/appPort=(\d+)/)?.[1]))
    const debugPorts = results.map(({ stdout }) =>
      Number(stdout.match(/chromiumDebugPort=(\d+)/)?.[1])
    )
    assert.equal(new Set(appPorts).size, 2)
    assert.equal(new Set(debugPorts).size, 2)
    assert.equal(new Set([...appPorts, ...debugPorts]).size, 4)
    await Promise.all(capturedTrees.map(waitForIdentitiesGone))
    await Promise.all([...appPorts, ...debugPorts].map(assertPortClosed))
    await Promise.all(
      smokeTemporaryRoots.map(root => assert.rejects(readdir(root), { code: 'ENOENT' }))
    )
    for (const isolatedTmp of isolatedRoots) assert.deepEqual(await readdir(isolatedTmp), [])

    const evidence = results[0].stdout
      .split(/\r?\n/)
      .filter(
        line => line.startsWith('browser CSP: PASS') || line.startsWith('browser smoke: PASS')
      )
    process.stdout.write(`${evidence.join('\n')}\n`)
  }
)

for (const { name, env, secondary } of [
  {
    name: 'every supported persistence patch is required to succeed',
    env: { PLAYGROUND_SMOKE_MUTATION_DISABLE_PATCH: 'all-supported' },
    secondary: {
      diagnostic: /form-bus activity detected during initial baseline/,
      env: { PLAYGROUND_SMOKE_MUTATION_EARLY_FORM_BUS_ACTIVITY: 'initial baseline' }
    }
  },
  {
    name: 'late persistence and form-bus activity fails the desktop root smoke in every document',
    env: { PLAYGROUND_SMOKE_MUTATION_LATE_ACTIVITY: 'all-documents' },
    secondary: {
      diagnostic: /persistence access detected during terminal completion/,
      env: { PLAYGROUND_SMOKE_MUTATION_TERMINAL_ACTIVITY: 'after-final-phase' }
    }
  },
  {
    name: 'late persistence and form-bus activity fails the mobile subpath smoke in every document',
    env: {
      PLAYGROUND_SMOKE_BASE_PATH: '/morpho-bots/',
      PLAYGROUND_SMOKE_MUTATION_LATE_ACTIVITY: 'all-documents',
      PLAYGROUND_SMOKE_VIEWPORT: 'mobile'
    },
    secondary: {
      diagnostic: /persistence access detected during terminal completion/,
      env: {
        PLAYGROUND_SMOKE_BASE_PATH: '/morpho-bots/',
        PLAYGROUND_SMOKE_MUTATION_TERMINAL_ACTIVITY: 'after-final-phase',
        PLAYGROUND_SMOKE_VIEWPORT: 'mobile'
      }
    }
  }
]) {
  test(name, { timeout: browserTestTimeout }, async () => {
    const run = spawnSmoke({ env: { ...process.env, ...env } })
    try {
      const result = await failedSmokeResult(run)
      if (env.PLAYGROUND_SMOKE_MUTATION_LATE_ACTIVITY === 'all-documents') {
        assert.match(result.output, new RegExp(terminalMutationProof))
      } else {
        assert.match(result.output, /persistence instrumentation missing during initial baseline/)
        assert.doesNotMatch(result.output, new RegExp(terminalMutationProof))
      }
    } finally {
      await cleanupHarnessRun(run)
    }

    const secondaryRun = spawnSmoke({ env: { ...process.env, ...secondary.env } })
    try {
      const result = await failedSmokeResult(secondaryRun)
      assert.match(result.output, secondary.diagnostic)
      assert.doesNotMatch(result.output, new RegExp(terminalMutationProof))
      assert.doesNotMatch(result.output, /browser smoke: PASS/)
    } finally {
      await cleanupHarnessRun(secondaryRun)
    }
  })
}
