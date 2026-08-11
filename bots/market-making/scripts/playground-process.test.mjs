import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createPortableProcessRunner } from './playground-process.mjs'

const fakeChild = (pid = 1234) => {
  const child = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

test('pre-aborted commands never spawn', async () => {
  const controller = new AbortController()
  controller.abort(new Error('already stopped'))
  let spawns = 0
  const run = createPortableProcessRunner({
    spawnProcess() {
      spawns++
      return fakeChild()
    }
  })
  await assert.rejects(
    run({ executable: 'tool', args: [], signal: controller.signal }),
    /already stopped/
  )
  assert.equal(spawns, 0)
})

test('an abort raised synchronously inside spawn is caught by the registered listener and post-spawn check', async () => {
  const controller = new AbortController()
  const child = fakeChild()
  const kills = []
  const run = createPortableProcessRunner({
    terminationGraceMs: 1,
    forceKillGraceMs: 10,
    killProcess(pid, signal) {
      kills.push([pid, signal])
      if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, 'SIGKILL'))
    },
    spawnProcess() {
      controller.abort(new Error('spawn-window abort'))
      return child
    }
  })
  await assert.rejects(
    run({ executable: 'tool', args: [], signal: controller.signal }),
    /spawn-window abort/
  )
  assert.deepEqual(kills, [
    [-1234, 'SIGTERM'],
    [-1234, 'SIGKILL']
  ])
})

for (const platform of ['linux', 'darwin']) {
  test(`${platform} runner owns a detached process group and escalates TERM to KILL`, async () => {
    const child = fakeChild()
    const kills = []
    let spawnOptions
    const run = createPortableProcessRunner({
      platform,
      terminationGraceMs: 1,
      forceKillGraceMs: 10,
      killProcess(pid, signal) {
        kills.push([pid, signal])
        if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null, 'SIGKILL'))
      },
      spawnProcess(_executable, _args, options) {
        spawnOptions = options
        return child
      }
    })
    const controller = new AbortController()
    const result = run({ executable: 'tool', args: ['install'], signal: controller.signal })
    controller.abort(new Error('cancelled'))
    await assert.rejects(result, /cancelled/)
    assert.equal(spawnOptions.detached, true)
    assert.equal(spawnOptions.shell, false)
    assert.deepEqual(kills, [
      [-1234, 'SIGTERM'],
      [-1234, 'SIGKILL']
    ])
  })
}

test('Windows runner terminates a task tree with argument arrays and no shell', async () => {
  const child = fakeChild(4321)
  const commands = []
  const run = createPortableProcessRunner({
    platform: 'win32',
    terminationGraceMs: 1,
    forceKillGraceMs: 10,
    spawnProcess(executable, args, options) {
      if (executable === 'tool.exe') return child
      commands.push({ executable, args, options })
      const taskkill = fakeChild(999)
      queueMicrotask(() => taskkill.emit('close', 0, null))
      if (args.includes('/F')) queueMicrotask(() => child.emit('close', 1, null))
      return taskkill
    }
  })
  const controller = new AbortController()
  const result = run({ executable: 'tool.exe', args: ['build'], signal: controller.signal })
  controller.abort(new Error('cancelled'))
  await assert.rejects(result, /cancelled/)
  assert.deepEqual(
    commands.map(({ executable, args, options }) => [executable, args, options.shell]),
    [
      ['taskkill.exe', ['/PID', '4321', '/T'], false],
      ['taskkill.exe', ['/PID', '4321', '/T', '/F'], false]
    ]
  )
})

test('POSIX abort kills a command descendant that ignores TERM', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'playground-process-tree-'))
  const pidFile = join(directory, 'pid')
  const controller = new AbortController()
  const run = createPortableProcessRunner({ terminationGraceMs: 50, forceKillGraceMs: 500 })
  try {
    const pending = run({
      executable: '/bin/sh',
      args: [
        '-c',
        `trap '' TERM; sh -c 'trap "" TERM; echo $$ > "${pidFile}"; while :; do sleep 1; done' & wait`
      ],
      signal: controller.signal
    })
    let descendantPid
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        descendantPid = Number(await readFile(pidFile, 'utf8'))
        break
      } catch {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    assert.ok(descendantPid)
    controller.abort(new Error('tree cancelled'))
    await assert.rejects(pending, /tree cancelled/)
    let state = 'missing'
    try {
      state = (await readFile(`/proc/${descendantPid}/stat`, 'utf8')).split(' ')[2]
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    assert.ok(state === 'missing' || state === 'Z', `descendant remains live in state ${state}`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
