import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import * as smokeSupport from './playground-smoke-support.mjs'
import {
  chromiumAvailability,
  discoverChromium,
  inspectProcessGroup,
  prepareFreshDist,
  readinessTimeoutMs,
  spawnOwnedProcess,
  startStaticServer,
  terminateOwnedProcessTree,
  waitForReadiness
} from './playground-smoke-support.mjs'

const temporaryDirectories = []
const smokeScript = fileURLToPath(new URL('./playground-smoke.mjs', import.meta.url))
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

test('readiness timeout uses one bounded CI-safe configuration source', () => {
  assert.equal(readinessTimeoutMs(undefined), 90_000)
  assert.equal(readinessTimeoutMs('90000'), 90_000)
  assert.throws(
    () => readinessTimeoutMs('90001'),
    /PLAYGROUND_SMOKE_READINESS_TIMEOUT_MS.*at most 90000ms.*90001/
  )
  for (const invalid of ['', '0', '-1', '1.5', 'not-a-number']) {
    assert.throws(
      () => readinessTimeoutMs(invalid),
      new RegExp(`PLAYGROUND_SMOKE_READINESS_TIMEOUT_MS.*positive integer.*${invalid || 'empty'}`)
    )
  }
})

test('readiness rejects an operation that succeeds 50ms after a 10ms deadline', async () => {
  let operationSettled = false

  await assert.rejects(
    waitForReadiness(
      () =>
        new Promise(resolve =>
          setTimeout(() => {
            operationSettled = true
            resolve('too late')
          }, 50)
        ),
      {
        description: 'late readiness success',
        timeoutMs: 10,
        pollIntervalMs: 1
      }
    ),
    /Timed out after 10ms waiting for late readiness success/
  )

  assert.equal(operationSettled, false)
})

test('readiness rejects a never-settling operation at its deadline', async () => {
  await assert.rejects(
    waitForReadiness(() => new Promise(() => {}), {
      description: 'stalled readiness operation',
      timeoutMs: 10,
      pollIntervalMs: 1
    }),
    /Timed out after 10ms waiting for stalled readiness operation/
  )
})

test('readiness rejects immediately when the child exits during a stalled operation', async () => {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  setTimeout(() => {
    child.exitCode = 23
    child.emit('exit', 23, null)
  }, 10)

  await assert.rejects(
    waitForReadiness(() => new Promise(() => {}), {
      child,
      childName: 'Chromium',
      description: 'stalled child readiness',
      getStderr: () => 'zygote failed',
      timeoutMs: 100
    }),
    error => {
      assert.match(error.message, /Chromium exited with exit code 23 before readiness/)
      assert.match(error.message, /zygote failed/)
      return true
    }
  )
})

test('stalled DevTools WebSocket handshake is cancelled at the readiness deadline', async () => {
  let socket
  class StalledWebSocket extends EventTarget {
    constructor() {
      super()
      socket = this
      this.closed = false
    }

    close() {
      this.closed = true
    }
  }

  await assert.rejects(
    waitForReadiness(
      signal =>
        smokeSupport.openWebSocket('ws://127.0.0.1/devtools', {
          signal,
          WebSocketImpl: StalledWebSocket
        }),
      {
        description: 'Chromium DevTools WebSocket handshake',
        timeoutMs: 10
      }
    ),
    /Timed out after 10ms waiting for Chromium DevTools WebSocket handshake/
  )
  assert.equal(socket.closed, true)
})

test('DevTools WebSocket handshake aborts immediately when Chromium exits', async () => {
  let socket
  class StalledWebSocket extends EventTarget {
    constructor() {
      super()
      socket = this
      this.closed = false
    }

    close() {
      this.closed = true
    }
  }
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  setTimeout(() => {
    child.signalCode = 'SIGKILL'
    child.emit('exit', null, 'SIGKILL')
  }, 10)

  await assert.rejects(
    waitForReadiness(
      signal =>
        smokeSupport.openWebSocket('ws://127.0.0.1/devtools', {
          signal,
          WebSocketImpl: StalledWebSocket
        }),
      {
        child,
        childName: 'Chromium',
        description: 'Chromium DevTools WebSocket handshake',
        timeoutMs: 100
      }
    ),
    /Chromium exited with signal SIGKILL before readiness/
  )
  assert.equal(socket.closed, true)
})

test('readiness rejects success exactly at the absolute deadline', async () => {
  let now = 5_000

  await assert.rejects(
    waitForReadiness(
      () => {
        now = 5_010
        return 'boundary success'
      },
      {
        deadline: 5_010,
        description: 'exact-boundary readiness',
        timeoutMs: 10,
        now: () => now
      }
    ),
    /Timed out after 10ms waiting for exact-boundary readiness/
  )
})

test('readiness waits through a delayed file until it succeeds before the wall-clock deadline', async () => {
  const directory = await temporaryDirectory('playground-readiness-delayed-file-')
  const readyFile = join(directory, 'ready')
  let now = 1_000

  const contents = await waitForReadiness(() => readFile(readyFile, 'utf8'), {
    description: 'delayed readiness file',
    timeoutMs: 100,
    pollIntervalMs: 10,
    now: () => now,
    sleep: async milliseconds => {
      now += milliseconds
      if (now === 1_030) await writeFile(readyFile, 'ready')
    }
  })

  assert.equal(contents, 'ready')
  assert.equal(now, 1_030)
})

test('readiness reports a fake child exit and stderr without waiting for the deadline', async () => {
  let now = 2_000
  const child = { exitCode: null, signalCode: null }

  await assert.rejects(
    waitForReadiness(
      () => {
        const error = new Error('ENOENT: DevToolsActivePort')
        error.code = 'ENOENT'
        throw error
      },
      {
        child,
        childName: 'Chromium',
        description: 'Chromium DevToolsActivePort',
        getStderr: () => 'zygote startup failed',
        timeoutMs: 100,
        pollIntervalMs: 10,
        now: () => now,
        sleep: async milliseconds => {
          now += milliseconds
          child.exitCode = 23
        }
      }
    ),
    error => {
      assert.match(error.message, /Chromium exited with exit code 23 before readiness/)
      assert.match(error.message, /zygote startup failed/)
      return true
    }
  )
  assert.equal(now, 2_010)
})

test('readiness deadline reports the last root cause and child stderr deterministically', async () => {
  let now = 3_000
  const rootCause = new Error('ENOENT: DevToolsActivePort')

  await assert.rejects(
    waitForReadiness(
      () => {
        throw rootCause
      },
      {
        description: 'Chromium DevToolsActivePort',
        getStderr: () => 'Chrome is still starting',
        timeoutMs: 30,
        pollIntervalMs: 10,
        now: () => now,
        sleep: async milliseconds => {
          now += milliseconds
        }
      }
    ),
    error => {
      assert.match(error.message, /Timed out after 30ms waiting for Chromium DevToolsActivePort/)
      assert.match(error.message, /Last readiness error: ENOENT: DevToolsActivePort/)
      assert.match(error.message, /Chrome is still starting/)
      assert.equal(error.cause, rootCause)
      return true
    }
  )
  assert.equal(now, 3_030)
})

test('readiness calls share one absolute deadline instead of resetting nested counters', async () => {
  let now = 4_000
  const deadline = 4_030
  let firstAttempts = 0
  const options = {
    deadline,
    description: 'shared startup readiness',
    timeoutMs: 30,
    pollIntervalMs: 10,
    now: () => now,
    sleep: async milliseconds => {
      now += milliseconds
    }
  }

  await waitForReadiness(() => {
    firstAttempts += 1
    if (firstAttempts < 3) throw new Error('first stage pending')
    return 'ready'
  }, options)
  assert.equal(now, 4_020)

  await assert.rejects(
    waitForReadiness(() => {
      throw new Error('second stage pending')
    }, options),
    /Timed out after 30ms waiting for shared startup readiness/
  )
  assert.equal(now, deadline)
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

test(
  'zombie descendants do not block live-parent termination or touch unrelated groups',
  { timeout: 30_000 },
  async () => {
    const isolatedTmp = await temporaryDirectory('playground-zombie-tree-')
    const parentScript = join(isolatedTmp, 'non-reaping-parent.py')
    const parentPidFile = join(isolatedTmp, 'parent-pid')
    const childPidFile = join(isolatedTmp, 'child-pid')
    await writeFile(
      parentScript,
      `import os
import signal
import subprocess
import sys
import time

term_count = 0

def on_term(_signum, _frame):
    global term_count
    term_count += 1
    if term_count >= 2:
        sys.exit(0)

signal.signal(signal.SIGTERM, on_term)
child = subprocess.Popen([sys.executable, '-c', 'import os; os._exit(0)'])
with open(os.environ['ZOMBIE_PARENT_PID_FILE'], 'w') as parent_file:
    parent_file.write(str(os.getpid()))
with open(os.environ['ZOMBIE_CHILD_PID_FILE'], 'w') as child_file:
    child_file.write(str(child.pid))
while True:
    time.sleep(1)
`
    )

    const unrelated = spawnOwnedProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore'
    })
    const owner = spawnOwnedProcess(process.env.PYTHON ?? 'python3', [parentScript], {
      env: {
        ...process.env,
        ZOMBIE_PARENT_PID_FILE: parentPidFile,
        ZOMBIE_CHILD_PID_FILE: childPidFile
      },
      stdio: 'ignore'
    })
    let targetPids = []
    let parentPid
    try {
      await waitFor(async () => {
        parentPid = Number(await readFile(parentPidFile, 'utf8'))
        const childPid = Number(await readFile(childPidFile, 'utf8'))
        assert.equal((await processStatus(childPid))?.state, 'Z')
      })
      targetPids = (await inspectProcessGroup(owner.pid)).map(({ pid }) => pid)
      const unrelatedBefore = await inspectProcessGroup(unrelated.pid)
      assert.ok(targetPids.length >= 3, `expected root+parent+zombie, got ${targetPids}`)
      assert.ok(unrelatedBefore.length >= 2, 'expected a separate unrelated process group')

      await terminateOwnedProcessTree(owner)

      await waitForProcessesGone(targetPids)
      assert.deepEqual(await inspectProcessGroup(owner.pid), [])
      assert.deepEqual(await inspectProcessGroup(unrelated.pid), unrelatedBefore)
    } finally {
      if (parentPid && processExists(parentPid)) process.kill(parentPid, 'SIGKILL')
      if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL')
      await terminateOwnedProcessTree(unrelated)
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
