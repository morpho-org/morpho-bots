import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  discoverChromium,
  inspectProcessGroup,
  readinessBudgets,
  waitForReadiness
} from './playground-smoke-support.mjs'

const temporaryDirectories = []
const smokeScript = fileURLToPath(new URL('./playground-smoke.mjs', import.meta.url))
const chromiumPath = await discoverChromium()
const { outerReadinessTimeout, browserTestTimeout } = readinessBudgets(
  process.env.PLAYGROUND_SMOKE_READINESS_TIMEOUT_MS
)
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

const waitForIdentitiesGone = async identities =>
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
      timeoutMs: 2_000,
      pollIntervalMs: 10
    }
  )

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
    await writeFile(
      fakeBun,
      `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require('node:fs')
const outdir = process.argv[process.argv.indexOf('--outdir') + 1]
if (!outdir) throw new Error('missing --outdir')
mkdirSync(outdir, { recursive: true })
writeFileSync(outdir + '/index.html', '<!doctype html><title>signal test</title>')
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

    const smoke = spawn(process.execPath, [smokeScript], {
      env: {
        ...process.env,
        CHROMIUM_PATH: wrapper,
        SMOKE_CHROMIUM_WRAPPER_PID_FILE: wrapperPidFile,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
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
    let recordedIdentities = []
    try {
      await waitForReadiness(
        () => {
          assert.match(output, /smoke environment:/)
        },
        {
          child: smoke,
          childName: 'Smoke test',
          description: 'outer Chromium readiness marker',
          getStderr: () => output,
          timeoutMs: outerReadinessTimeout,
          pollIntervalMs: 10
        }
      )
      const wrapperPid = Number(await readFile(wrapperPidFile, 'utf8'))
      const processGroup = (await processIdentity(wrapperPid)).processGroup
      recordedIdentities = await inspectProcessGroup(processGroup)
      assert.ok(
        recordedIdentities.length > 1,
        `expected a real Chromium tree, got ${recordedIdentities.map(({ pid }) => pid)}`
      )

      smoke.kill(signal)
      const result = await new Promise((resolve, reject) => {
        smoke.once('error', reject)
        smoke.once('close', (code, closeSignal) => resolve({ code, signal: closeSignal }))
      })

      assert.deepEqual(
        result,
        { code: null, signal },
        `smoke output (tail):\n${output.slice(-8000)}`
      )
      await waitForIdentitiesGone(recordedIdentities)
      assert.doesNotMatch(output, /Graceful Chromium shutdown failed/)
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
      for (const identity of recordedIdentities) {
        if (await sameIdentityExists(identity)) process.kill(identity.pid, 'SIGKILL')
      }
    }
  })
}

test(
  'two complete smoke runs use isolated builds and dynamic ports concurrently',
  { timeout: browserTestTimeout },
  async () => {
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
      .filter(
        line => line.startsWith('browser CSP: PASS') || line.startsWith('browser smoke: PASS')
      )
    process.stdout.write(`${evidence.join('\n')}\n`)
  }
)
