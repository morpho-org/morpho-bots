import { spawn } from 'node:child_process'
import { constants, createReadStream, mkdtempSync } from 'node:fs'
import { access, lstat, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const chromiumNames = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'chrome',
  'microsoft-edge',
  'microsoft-edge-stable'
]
const commonChromiumPaths = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'
]

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

export const describeHttpFailures = responses =>
  responses
    .filter(({ status }) => status >= 400)
    .map(({ url, status, type }) => `${status} ${type ?? 'Unknown'} ${url}`)

export const runBounded = async (operation, { description, timeoutMs }) => {
  const controller = new AbortController()
  const deadline = performance.now() + timeoutMs
  let timer
  const operationPromise = Promise.resolve().then(() => operation(controller.signal, deadline))
  // The deadline wins even when the operation ignores AbortSignal. Keep a terminal
  // rejection handler attached because the operation may settle after this returns.
  void operationPromise.catch(() => {})
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => {
        const error = new Error(`Timed out after ${timeoutMs}ms during ${description}`)
        controller.abort(error)
        reject(error)
      },
      Math.max(0, deadline - performance.now())
    )
  })
  try {
    return await Promise.race([operationPromise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export const resignalAfterCleanup = async ({
  cleanup,
  processImpl = process,
  report = message => console.error(message),
  signal,
  signalHandler
}) => {
  try {
    await cleanup()
  } catch (error) {
    report(`Smoke cleanup failed before ${signal} re-signal: ${error.message}`)
  }
  processImpl.off('SIGINT', signalHandler)
  processImpl.off('SIGTERM', signalHandler)
  try {
    processImpl.kill(processImpl.pid, signal)
  } catch {
    processImpl.exit(signal === 'SIGINT' ? 130 : 143)
  }
}

const DEFAULT_READINESS_TIMEOUT_MS = 90_000
const MAX_READINESS_TIMEOUT_MS = 90_000
const DEFAULT_BUILD_TIMEOUT_MS = 30_000
const DEFAULT_BODY_TIMEOUT_MS = 60_000
const DEFAULT_UI_POLL_TIMEOUT_MS = 5_000
const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 5_000
const DEFAULT_CLEANUP_TIMEOUT_MS = 15_000
const OUTER_READINESS_GRACE_MS = 15_000
const BROWSER_TEST_GRACE_MS = 15_000
const MAX_BROWSER_TEST_TIMEOUT_MS = 300_000

const positiveBoundedTimeout = (name, value, defaultValue, maximum) => {
  if (value === undefined) return defaultValue
  if (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive integer; received: ${value || 'empty'}`)
  }
  const timeoutMs = Number(value)
  if (timeoutMs > maximum) {
    throw new Error(`${name} must be at most ${maximum}ms; received: ${value}`)
  }
  return timeoutMs
}

export const readinessTimeoutMs = value =>
  positiveBoundedTimeout(
    'PLAYGROUND_SMOKE_READINESS_TIMEOUT_MS',
    value,
    DEFAULT_READINESS_TIMEOUT_MS,
    MAX_READINESS_TIMEOUT_MS
  )

export const smokeBudgets = (env = process.env) => {
  const startupTimeout = readinessTimeoutMs(env.PLAYGROUND_SMOKE_READINESS_TIMEOUT_MS)
  const buildTimeout = positiveBoundedTimeout(
    'PLAYGROUND_SMOKE_BUILD_TIMEOUT_MS',
    env.PLAYGROUND_SMOKE_BUILD_TIMEOUT_MS,
    DEFAULT_BUILD_TIMEOUT_MS,
    60_000
  )
  const bodyTimeout = positiveBoundedTimeout(
    'PLAYGROUND_SMOKE_BODY_TIMEOUT_MS',
    env.PLAYGROUND_SMOKE_BODY_TIMEOUT_MS,
    DEFAULT_BODY_TIMEOUT_MS,
    120_000
  )
  const uiPollTimeout = positiveBoundedTimeout(
    'PLAYGROUND_SMOKE_UI_POLL_TIMEOUT_MS',
    env.PLAYGROUND_SMOKE_UI_POLL_TIMEOUT_MS,
    DEFAULT_UI_POLL_TIMEOUT_MS,
    30_000
  )
  const cdpCommandTimeout = positiveBoundedTimeout(
    'PLAYGROUND_SMOKE_CDP_COMMAND_TIMEOUT_MS',
    env.PLAYGROUND_SMOKE_CDP_COMMAND_TIMEOUT_MS,
    DEFAULT_CDP_COMMAND_TIMEOUT_MS,
    30_000
  )
  const cleanupTimeout = positiveBoundedTimeout(
    'PLAYGROUND_SMOKE_CLEANUP_TIMEOUT_MS',
    env.PLAYGROUND_SMOKE_CLEANUP_TIMEOUT_MS,
    DEFAULT_CLEANUP_TIMEOUT_MS,
    30_000
  )
  const derivedBrowserTestTimeout =
    buildTimeout + startupTimeout + bodyTimeout + cleanupTimeout + BROWSER_TEST_GRACE_MS
  const override = env.PLAYGROUND_SMOKE_BROWSER_TEST_TIMEOUT_MS
  let browserTestTimeout = derivedBrowserTestTimeout
  if (override !== undefined) {
    if (!/^\d+$/.test(override) || !Number.isSafeInteger(Number(override))) {
      throw new Error(
        `PLAYGROUND_SMOKE_BROWSER_TEST_TIMEOUT_MS must be a positive integer; received: ${override || 'empty'}`
      )
    }
    browserTestTimeout = Number(override)
    if (browserTestTimeout < derivedBrowserTestTimeout) {
      throw new Error(
        `PLAYGROUND_SMOKE_BROWSER_TEST_TIMEOUT_MS must be at least the derived lifecycle budget of ${derivedBrowserTestTimeout}ms; received: ${override}`
      )
    }
    if (browserTestTimeout > MAX_BROWSER_TEST_TIMEOUT_MS) {
      throw new Error(
        `PLAYGROUND_SMOKE_BROWSER_TEST_TIMEOUT_MS must be at most ${MAX_BROWSER_TEST_TIMEOUT_MS}ms; received: ${override}`
      )
    }
  }
  return {
    buildTimeout,
    startupTimeout,
    bodyTimeout,
    uiPollTimeout,
    cdpCommandTimeout,
    cleanupTimeout,
    outerReadinessTimeout: buildTimeout + startupTimeout + OUTER_READINESS_GRACE_MS,
    browserTestTimeout
  }
}

export const openWebSocket = (url, { signal, WebSocketImpl = globalThis.WebSocket } = {}) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(url)
    const cleanup = () => {
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
    }
    const dispose = () => {
      try {
        socket.close()
      } catch {
        // A failed handshake may leave a partially initialized implementation; disposal is best-effort.
      }
    }
    const onOpen = () => {
      cleanup()
      resolve(socket)
    }
    const onError = event => {
      cleanup()
      dispose()
      reject(event.error ?? new Error(`WebSocket handshake failed for ${url}`))
    }
    const onAbort = () => {
      cleanup()
      dispose()
      reject(signal.reason)
    }
    socket.addEventListener('open', onOpen, { once: true })
    socket.addEventListener('error', onError, { once: true })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })

export const createCdpClient = (
  socket,
  { commandTimeoutMs, onMessage = () => {}, now = performance.now.bind(performance) }
) => {
  let nextId = 0
  let disposed = false
  const pending = new Map()
  const rejectPending = error => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer)
      reject(error)
    }
    pending.clear()
  }
  const onSocketMessage = event => {
    let message
    try {
      message = JSON.parse(String(event.data))
      onMessage(message)
    } catch (error) {
      rejectPending(error)
      return
    }
    if (!message.id || !pending.has(message.id)) return
    const { resolve, reject, timer } = pending.get(message.id)
    pending.delete(message.id)
    clearTimeout(timer)
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
  }
  const onSocketClose = event => {
    const detail = [event.code, event.reason]
      .filter(value => value !== undefined && value !== '')
      .join(' ')
    rejectPending(new Error(`DevTools WebSocket closed${detail ? ` (${detail})` : ''}`))
  }
  const onSocketError = event =>
    rejectPending(event.error ?? new Error('DevTools WebSocket failed'))
  socket.addEventListener('message', onSocketMessage)
  socket.addEventListener('close', onSocketClose)
  socket.addEventListener('error', onSocketError)

  return {
    command(method, params = {}, { deadline } = {}) {
      if (disposed) return Promise.reject(new Error('DevTools client is disposed'))
      const phaseRemaining = deadline === undefined ? commandTimeoutMs : deadline - now()
      const timeoutMs = Math.min(commandTimeoutMs, phaseRemaining)
      if (timeoutMs <= 0) {
        return Promise.reject(new Error(`CDP command ${method} exceeded its phase deadline`))
      }
      return new Promise((resolve, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`CDP command ${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(id, { reject, resolve, timer })
        try {
          socket.send(JSON.stringify({ id, method, params }))
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(error)
        }
      })
    },
    dispose(reason = new Error('DevTools client disposed')) {
      if (disposed) return
      disposed = true
      socket.removeEventListener('message', onSocketMessage)
      socket.removeEventListener('close', onSocketClose)
      socket.removeEventListener('error', onSocketError)
      rejectPending(reason)
    }
  }
}

export const waitForReadiness = async (
  operation,
  {
    description,
    timeoutMs,
    deadline: suppliedDeadline,
    pollIntervalMs = 25,
    child,
    childName = 'Child process',
    getChildError = () => undefined,
    getStderr = () => '',
    disposeResult = () => {},
    now = performance.now.bind(performance),
    sleep = delay
  }
) => {
  const deadline = suppliedDeadline ?? now() + timeoutMs
  let lastError
  const terminalErrors = new WeakSet()
  const timeoutError = () => {
    const stderr = getStderr().trim()
    const lastErrorDetail = lastError ? ` Last readiness error: ${lastError.message}` : ''
    const error = new Error(
      `Timed out after ${timeoutMs}ms waiting for ${description}.${lastErrorDetail}${stderr ? `\nChild stderr:\n${stderr}` : ''}`,
      { cause: lastError }
    )
    terminalErrors.add(error)
    return error
  }
  const childExitError = (exitCode = child?.exitCode, signalCode = child?.signalCode) => {
    const status = signalCode !== null ? `signal ${signalCode}` : `exit code ${exitCode}`
    const stderr = getStderr().trim()
    const error = new Error(
      `${childName} exited with ${status} before readiness.${stderr ? `\n${stderr}` : ''}`,
      { cause: lastError }
    )
    terminalErrors.add(error)
    return error
  }
  const childSpawnError = cause => {
    const stderr = getStderr().trim()
    const error = new Error(
      `${childName} failed before readiness (${cause.message}).${stderr ? `\n${stderr}` : ''}`,
      { cause }
    )
    terminalErrors.add(error)
    return error
  }
  const assertChildRunning = () => {
    const childError = getChildError()
    if (childError) throw childSpawnError(childError)
    if (child && (child.exitCode !== null || child.signalCode !== null)) throw childExitError()
  }
  const runSupervised = async task => {
    assertChildRunning()
    const remainingMs = deadline - now()
    if (remainingMs <= 0) throw timeoutError()

    const controller = new AbortController()
    let timer
    let removeChildListeners = () => {}
    let outcomeDecided = false
    let accepted = false
    let completedResult
    let disposalPromise
    const disposeOnce = result =>
      (disposalPromise ??= Promise.resolve()
        .then(() => disposeResult(result))
        .catch(() => {}))
    const taskPromise = Promise.resolve()
      .then(() => task(controller.signal))
      .then(result => {
        completedResult = result
        if (outcomeDecided && !accepted) void disposeOnce(result)
        return result
      })
    const competitors = [taskPromise]
    competitors.push(
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = timeoutError()
          reject(error)
          controller.abort(error)
        }, remainingMs)
      })
    )
    if (child?.once && child?.off) {
      competitors.push(
        new Promise((_, reject) => {
          const onError = error => {
            const failure = childSpawnError(error)
            reject(failure)
            controller.abort(failure)
          }
          const onExit = (exitCode, signalCode) => {
            const failure = childExitError(exitCode, signalCode)
            reject(failure)
            controller.abort(failure)
          }
          child.once('error', onError)
          child.once('exit', onExit)
          removeChildListeners = () => {
            child.off('error', onError)
            child.off('exit', onExit)
          }
        })
      )
    }

    try {
      const result = await Promise.race(competitors)
      assertChildRunning()
      if (now() >= deadline) throw timeoutError()
      accepted = true
      return result
    } catch (error) {
      if (completedResult !== undefined) await disposeOnce(completedResult)
      if (controller.signal.aborted) throw controller.signal.reason
      throw error
    } finally {
      outcomeDecided = true
      clearTimeout(timer)
      removeChildListeners()
    }
  }
  while (true) {
    assertChildRunning()
    try {
      return await runSupervised(operation)
    } catch (error) {
      if (terminalErrors.has(error)) throw error
      lastError = error
    }
    const remainingMs = deadline - now()
    if (remainingMs <= 0) throw timeoutError()
    await runSupervised(() => sleep(Math.min(pollIntervalMs, remainingMs)))
  }
}

const assertProcessInspection = () => {
  if (process.platform !== 'linux') {
    throw new Error(
      `Definitive descendant cleanup requires Linux /proc process inspection; unsupported platform: ${process.platform}`
    )
  }
}

const readProcess = async pid => {
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

const listProcesses = async () => {
  assertProcessInspection()
  const entries = await readdir('/proc', { withFileTypes: true })
  return (
    await Promise.all(
      entries
        .filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name))
        .map(entry => readProcess(Number(entry.name)))
    )
  ).filter(Boolean)
}

const identity = processInfo => `${processInfo.pid}:${processInfo.startTime}`

export const inspectProcessGroup = async processGroup =>
  (await listProcesses()).filter(processInfo => processInfo.processGroup === processGroup)

export const inspectProcessTree = async rootPid => {
  const processes = await listProcesses()
  const included = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const processInfo of processes) {
      if (!included.has(processInfo.pid) && included.has(processInfo.ppid)) {
        included.add(processInfo.pid)
        changed = true
      }
    }
  }
  return processes.filter(processInfo => included.has(processInfo.pid))
}

const waitForIdentitiesGone = async (tracked, timeoutMs) => {
  const deadline = performance.now() + timeoutMs
  while (true) {
    const liveIdentities = new Set((await listProcesses()).map(identity))
    const remaining = [...tracked.values()].filter(processInfo =>
      liveIdentities.has(identity(processInfo))
    )
    if (remaining.length === 0) return []
    if (performance.now() >= deadline) return remaining
    await delay(25)
  }
}

const signalPid = (pid, signal) => {
  try {
    process.kill(pid, signal)
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}

const remainingTracked = async tracked => {
  const processes = new Map(
    (await listProcesses()).map(processInfo => [identity(processInfo), processInfo])
  )
  return [...tracked.keys()].flatMap(key => (processes.has(key) ? [processes.get(key)] : []))
}

export const closeOwnedProcessTreeGracefully = async (
  child,
  close,
  { deadline, now = performance.now.bind(performance), signal, timeoutMs = 4000 } = {}
) => {
  if (child.pid === undefined) return
  const context = ownedTreeContext(child.pid, {
    deadline: Math.min(deadline ?? Number.POSITIVE_INFINITY, now() + timeoutMs),
    now,
    signal
  })
  await scanOwnedTree(context)
  await close()
  while (true) {
    const remaining = await requireStableEmptyOwnedTree(context)
    if (remaining.length === 0) return
    await sleepWithinCleanupBudget(context, 25)
  }
}

export const terminateProcessSnapshot = async processes => {
  const tracked = new Map(processes.map(processInfo => [identity(processInfo), processInfo]))
  while (true) {
    const current = await remainingTracked(tracked)
    if (current.length === 0) return
    const live = current.filter(({ state }) => state !== 'Z')
    if (live.length === 0) {
      const zombies = await waitForIdentitiesGone(tracked, 2_000)
      if (zombies.length === 0) return
      throw new Error(
        `Captured process-tree zombies were not reaped: ${zombies.map(({ pid, ppid }) => `${pid}(ppid=${ppid})`).join(', ')}`
      )
    }
    const livePids = new Set(live.map(({ pid }) => pid))
    const parentPids = new Set(live.map(({ ppid }) => ppid).filter(pid => livePids.has(pid)))
    const leaves = live.filter(({ pid }) => !parentPids.has(pid))
    for (const leaf of leaves) signalPid(leaf.pid, 'SIGTERM')
    let remainingLeaves = await waitForIdentitiesGone(
      new Map(leaves.map(processInfo => [identity(processInfo), processInfo])),
      2_000
    )
    if (remainingLeaves.length) {
      for (const leaf of remainingLeaves) signalPid(leaf.pid, 'SIGKILL')
      remainingLeaves = await waitForIdentitiesGone(
        new Map(remainingLeaves.map(processInfo => [identity(processInfo), processInfo])),
        2_000
      )
    }
    if (remainingLeaves.length) {
      throw new Error(
        `Captured process-tree leaves survived bounded termination: ${remainingLeaves
          .map(({ pid, ppid, state }) => `${pid}(ppid=${ppid},state=${state})`)
          .join(', ')}`
      )
    }
  }
}

const abortableDelay = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    let timer
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })

const describeProcesses = processes =>
  processes.map(({ pid, ppid, state }) => `${pid}(ppid=${ppid},state=${state})`).join(', ')

const readChildren = async pid => {
  try {
    const children = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')
    return children.trim().split(/\s+/).filter(Boolean).map(Number)
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return []
    throw error
  }
}

const listOwnedProcesses = async (rootPid, tracked) => {
  const queued = new Set([rootPid, ...[...tracked.values()].map(({ pid }) => pid)])
  const queue = [...queued]
  const processes = []
  while (queue.length) {
    const pid = queue.shift()
    const [processInfo, children] = await Promise.all([readProcess(pid), readChildren(pid)])
    if (processInfo) processes.push(processInfo)
    for (const childPid of children) {
      if (queued.has(childPid)) continue
      queued.add(childPid)
      queue.push(childPid)
    }
  }
  return processes
}

const ownedTreeContext = (rootPid, options) => {
  const now = options.now ?? performance.now.bind(performance)
  return {
    deadline: options.deadline ?? now() + 15_000,
    errors: [],
    inspectProcesses: options.inspectProcesses,
    lastRemaining: [],
    now,
    quietIntervalMs: options.quietIntervalMs ?? 25,
    rootPid,
    signal: options.signal,
    signalProcess: options.signalProcess ?? signalPid,
    sleep: options.sleep ?? abortableDelay,
    tracked: new Map()
  }
}

const cleanupAbortError = context => {
  const reason = context.signal?.aborted
    ? context.signal.reason
    : new Error(`global deadline ${context.deadline} reached`)
  const survivors = context.lastRemaining.length
    ? describeProcesses(context.lastRemaining)
    : 'none observed in the final completed scan'
  const failures = [...context.errors, reason]
  const error = new AggregateError(
    failures,
    `Owned process tree cleanup aborted; survivors: ${survivors}; errors: ${failures
      .map(error => error?.message ?? String(error))
      .join('; ')}`
  )
  error.code = 'OWNED_TREE_CLEANUP_ABORTED'
  return error
}

const assertCleanupBudget = context => {
  if (context.signal?.aborted || context.now() >= context.deadline) {
    throw cleanupAbortError(context)
  }
}

const sleepWithinCleanupBudget = async (context, milliseconds) => {
  assertCleanupBudget(context)
  const bounded = Math.min(milliseconds, context.deadline - context.now())
  try {
    await context.sleep(bounded, context.signal)
  } catch (error) {
    if (context.signal?.aborted) throw cleanupAbortError(context)
    throw error
  }
  assertCleanupBudget(context)
}

const scanOwnedTree = async context => {
  assertCleanupBudget(context)
  const processes = context.inspectProcesses
    ? await context.inspectProcesses()
    : await listOwnedProcesses(context.rootPid, context.tracked)
  assertCleanupBudget(context)
  const included = new Set([context.rootPid])
  for (const processInfo of processes) {
    if (processInfo.processGroup === context.rootPid) included.add(processInfo.pid)
  }
  let changed = true
  while (changed) {
    changed = false
    for (const processInfo of processes) {
      if (!included.has(processInfo.pid) && included.has(processInfo.ppid)) {
        included.add(processInfo.pid)
        changed = true
      }
    }
  }
  for (const processInfo of processes) {
    if (included.has(processInfo.pid)) context.tracked.set(identity(processInfo), processInfo)
  }
  const current = new Map(processes.map(processInfo => [identity(processInfo), processInfo]))
  context.lastRemaining = [...context.tracked.keys()].flatMap(key =>
    current.has(key) ? [current.get(key)] : []
  )
  return context.lastRemaining
}

const signalForCleanup = (context, pid, signal) => {
  assertCleanupBudget(context)
  try {
    context.signalProcess(pid, signal)
  } catch (error) {
    context.errors.push(
      new Error(`${signal} to pid ${pid} failed: ${error.message}`, { cause: error })
    )
  }
}

const waitForCleanupTargets = async (context, targets, stageDurationMs) => {
  const targetIdentities = new Set(targets.map(identity))
  const stageDeadline = Math.min(context.deadline, context.now() + stageDurationMs)
  while (true) {
    const current = await scanOwnedTree(context)
    const remaining = current.filter(processInfo => targetIdentities.has(identity(processInfo)))
    if (remaining.length === 0 || context.now() >= stageDeadline) return remaining
    await sleepWithinCleanupBudget(context, Math.min(25, stageDeadline - context.now()))
  }
}

const requireStableEmptyOwnedTree = async context => {
  const first = await scanOwnedTree(context)
  if (first.length) return first
  await sleepWithinCleanupBudget(context, context.quietIntervalMs)
  return scanOwnedTree(context)
}

export const terminateOwnedProcessTree = async (child, options = {}) => {
  if (child.pid === undefined) return
  assertProcessInspection()
  const context = ownedTreeContext(child.pid, options)
  try {
    let remaining = await scanOwnedTree(context)
    signalForCleanup(context, child.pid, 'SIGTERM')
    remaining = await waitForCleanupTargets(context, remaining, 2_000)
    if (remaining.length === 0) {
      remaining = await requireStableEmptyOwnedTree(context)
      if (remaining.length === 0) return
    }

    while (true) {
      remaining = await scanOwnedTree(context)
      if (remaining.length === 0) {
        remaining = await requireStableEmptyOwnedTree(context)
        if (remaining.length === 0) return
        continue
      }

      const descendants = remaining.filter(
        ({ pid, state }) => pid !== context.rootPid && state !== 'Z'
      )
      if (descendants.length) {
        const descendantPids = new Set(descendants.map(({ pid }) => pid))
        const parentPids = new Set(
          descendants.map(({ ppid }) => ppid).filter(pid => descendantPids.has(pid))
        )
        const leaves = descendants.filter(({ pid }) => !parentPids.has(pid))
        for (const leaf of leaves) signalForCleanup(context, leaf.pid, 'SIGTERM')
        let survivingLeaves = await waitForCleanupTargets(context, leaves, 2_000)
        if (survivingLeaves.length) {
          for (const leaf of survivingLeaves) signalForCleanup(context, leaf.pid, 'SIGKILL')
          survivingLeaves = await waitForCleanupTargets(context, survivingLeaves, 2_000)
        }
        if (survivingLeaves.length) {
          throw new AggregateError(
            context.errors,
            `Owned process tree descendants survived escalation: ${describeProcesses(survivingLeaves)}`
          )
        }
        continue
      }

      const root = remaining.find(({ pid }) => pid === context.rootPid)
      if (root) {
        signalForCleanup(context, root.pid, 'SIGTERM')
        let survivingRoot = await waitForCleanupTargets(context, [root], 500)
        if (survivingRoot.length) {
          signalForCleanup(context, root.pid, 'SIGKILL')
          survivingRoot = await waitForCleanupTargets(context, survivingRoot, 500)
        }
        if (survivingRoot.length) {
          throw new AggregateError(
            context.errors,
            `Owned process tree root survived escalation: ${describeProcesses(survivingRoot)}`
          )
        }
        continue
      }

      throw new AggregateError(
        context.errors,
        `Owned process tree zombies were not reaped: ${describeProcesses(remaining)}`
      )
    }
  } catch (error) {
    if (context.signal?.aborted || context.now() >= context.deadline) {
      if (error.code === 'OWNED_TREE_CLEANUP_ABORTED') throw error
      if (!context.errors.includes(error)) context.errors.push(error)
      throw cleanupAbortError(context)
    }
    throw error
  }
}

const executableFile = async path => {
  try {
    const canonicalPath = await realpath(path)
    const metadata = await stat(canonicalPath)
    if (!metadata.isFile()) return undefined
    await access(canonicalPath, constants.X_OK)
    return canonicalPath
  } catch {
    return undefined
  }
}

export const discoverChromium = async ({
  override = process.env.CHROMIUM_PATH,
  path = process.env.PATH ?? ''
} = {}) => {
  if (override) {
    if (!isAbsolute(override)) {
      throw new Error(`CHROMIUM_PATH must be an absolute executable path; received: ${override}`)
    }
    const executable = await executableFile(override)
    if (!executable) {
      throw new Error(`CHROMIUM_PATH is not an executable file: ${override}`)
    }
    return executable
  }

  const candidates = [
    ...path
      .split(delimiter)
      .filter(Boolean)
      .flatMap(directory => chromiumNames.map(name => join(directory, name))),
    ...commonChromiumPaths
  ]
  for (const candidate of candidates) {
    const executable = await executableFile(candidate)
    if (executable) return executable
  }
  throw new Error(
    `Chromium was not found. Install one of ${chromiumNames.join(', ')} on PATH, or set CHROMIUM_PATH to its absolute executable path.`
  )
}

export const chromiumAvailability = async options => {
  try {
    return { path: await discoverChromium(options), reason: undefined }
  } catch (error) {
    return { path: undefined, reason: `Chromium-dependent test skipped: ${error.message}` }
  }
}

const linuxSubreaper = String.raw`
import ctypes
import os
import signal
import subprocess
import sys
import time

PR_SET_CHILD_SUBREAPER = 36
if ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
    errno = ctypes.get_errno()
    raise OSError(errno, os.strerror(errno))

child = None
pending_signals = []


def forward(signum, _frame):
    if child is None:
        pending_signals.append(signum)
        return
    try:
        child.send_signal(signum)
    except ProcessLookupError:
        pass


def finish_with_signal(signum):
    signal.signal(signal.SIGINT, signal.SIG_DFL)
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    os.kill(os.getpid(), signum)
    os._exit(128 + signum)


def test_barrier(phase):
    ready = os.environ.get('SUBREAPER_TEST_' + phase + '_READY_FILE')
    release = os.environ.get('SUBREAPER_TEST_' + phase + '_RELEASE_FILE')
    if not ready or not release:
        return
    open(ready, 'w').close()
    while not os.path.exists(release):
        time.sleep(0.001)


signal.signal(signal.SIGINT, forward)
signal.signal(signal.SIGTERM, forward)
test_barrier('BEFORE_POPEN')
if pending_signals:
    finish_with_signal(pending_signals[0])

preexec_fn = None
if os.environ.get('SUBREAPER_TEST_DURING_POPEN_READY_FILE'):
    preexec_fn = lambda: test_barrier('DURING_POPEN')

try:
    child = subprocess.Popen(sys.argv[1:], preexec_fn=preexec_fn)
except BaseException:
    if pending_signals:
        finish_with_signal(pending_signals[0])
    raise

signals_to_forward = pending_signals
pending_signals = []
for signum in signals_to_forward:
    try:
        child.send_signal(signum)
    except ProcessLookupError:
        pass

test_barrier('AFTER_ASSIGNMENT')
returncode = child.wait()

while True:
    try:
        pid, _status = os.waitpid(-1, os.WNOHANG)
    except ChildProcessError:
        break
    if pid == 0:
        time.sleep(0.01)

if returncode < 0:
    signum = -returncode
    signal.signal(signum, signal.SIG_DFL)
    os.kill(os.getpid(), signum)
sys.exit(returncode)
`

export const spawnOwnedProcess = (executable, args, options = {}) => {
  assertProcessInspection()
  return spawn(process.env.PYTHON ?? 'python3', ['-c', linuxSubreaper, executable, ...args], {
    ...options,
    detached: true,
    shell: false
  })
}

export const prepareFreshDist = async ({
  root,
  executable = process.execPath,
  onDistCreated = () => {},
  onBuildProcess = () => () => {},
  onTempCreated = async () => {},
  processRunner,
  removeTemporaryDist = rm,
  signal,
  temporaryRoot = tmpdir()
}) => {
  if (signal?.aborted) throw signal.reason
  await rm(join(root, 'playground/dist'), { recursive: true, force: true })
  if (signal?.aborted) throw signal.reason
  const dist = mkdtempSync(join(temporaryRoot, 'market-making-playground-dist-'))
  let cleanupPromise
  const cleanup = () =>
    (cleanupPromise ??= Promise.resolve().then(() =>
      removeTemporaryDist(dist, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    ))
  let releaseBuildProcess = () => {}
  try {
    onDistCreated(dist)
    await onTempCreated(dist)
    if (signal?.aborted) throw signal.reason
    const command = {
      executable,
      args: [join(root, 'scripts/playground-build.mjs'), '--outdir', dist, '--no-clean'],
      cwd: root,
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
      onProcess: build => {
        releaseBuildProcess = onBuildProcess(build)
      }
    }
    let result
    if (processRunner) {
      result = await processRunner(command)
    } else {
      const build = spawnOwnedProcess(command.executable, command.args, {
        cwd: command.cwd,
        stdio: command.stdio
      })
      command.onProcess(build)
      build.stdout.setEncoding('utf8')
      build.stderr.setEncoding('utf8')
      let stdout = ''
      let stderr = ''
      build.stdout.on('data', chunk => {
        stdout += chunk
      })
      build.stderr.on('data', chunk => {
        stderr += chunk
      })
      result = await new Promise(resolveResult => {
        let spawnError
        build.once('error', error => {
          spawnError = error
        })
        build.once('close', (code, closeSignal) =>
          resolveResult({ code, error: spawnError, signal: closeSignal, stderr, stdout })
        )
      })
    }
    if (signal?.aborted) throw signal.reason
    if (result.error) {
      throw new Error(
        `Failed to start fresh playground build with ${executable}: ${result.error.message}`
      )
    }
    if (result.code !== 0) {
      const status = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`
      throw new Error(
        `Fresh playground build failed with ${status}.\n${result.stdout ?? ''}${result.stderr ?? ''}`
      )
    }
    const index = join(dist, 'index.html')
    try {
      if (!(await lstat(index)).isFile()) throw new Error('not a file')
    } catch (error) {
      throw new Error(`Fresh playground build did not create ${index}: ${error.message}`)
    }
    if (signal?.aborted) throw signal.reason
    return { cleanup, dist }
  } catch (error) {
    try {
      await cleanup()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Fresh playground preparation failed: ${error.message}; temporary dist cleanup failed: ${cleanupError.message}`,
        { cause: error }
      )
    }
    throw error
  } finally {
    releaseBuildProcess()
  }
}

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8']
])

const escapesRoot = relativePath =>
  relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)

const rejectStaticRequest = (request, response) => {
  if (response.destroyed) return
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(404)
  response.end(request.method === 'HEAD' ? undefined : 'Not found')
}

export const startStaticServer = async (
  root,
  { host = '127.0.0.1', port = 0, createFileStream = createReadStream, closeTimeoutMs = 1_000 } = {}
) => {
  const servedRoot = await realpath(root)
  const server = createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Length': 0 }).end()
      return
    }
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
      const pathname = decodeURIComponent(requestUrl.pathname)
      const requestedPath = pathname.endsWith('/') ? `${pathname}index.html` : pathname
      const candidate = resolve(servedRoot, `.${requestedPath}`)
      const candidateRelative = relative(servedRoot, candidate)
      if (escapesRoot(candidateRelative)) {
        rejectStaticRequest(request, response)
        return
      }
      const actual = await realpath(candidate)
      const actualRelative = relative(servedRoot, actual)
      if (escapesRoot(actualRelative)) {
        rejectStaticRequest(request, response)
        return
      }
      const metadata = await lstat(actual)
      if (!metadata.isFile()) {
        rejectStaticRequest(request, response)
        return
      }
      const headers = {
        'Cache-Control': 'no-store',
        'Content-Length': metadata.size,
        'Content-Type': contentTypes.get(extname(actual)) ?? 'application/octet-stream'
      }
      if (request.method === 'HEAD') {
        response.writeHead(200, headers).end()
        return
      }
      const stream = createFileStream(actual)
      let streamFailed = false
      stream.once('error', () => {
        streamFailed = true
        rejectStaticRequest(request, response)
      })
      stream.once('open', () => {
        if (streamFailed || stream.destroyed || response.destroyed || response.writableEnded) return
        response.writeHead(200, headers)
        stream.pipe(response)
      })
      response.once('close', () => {
        if (!stream.destroyed) stream.destroy()
      })
    } catch {
      rejectStaticRequest(request, response)
    }
  })
  server.on('connect', (_request, socket) => {
    socket.end(
      'HTTP/1.1 405 Method Not Allowed\r\nAllow: GET, HEAD\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'
    )
  })
  const sockets = new Set()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'))
  await new Promise((resolveListen, rejectListen) => {
    const onError = error => {
      if (error.code === 'EADDRINUSE') {
        rejectListen(
          new Error(
            `Cannot serve playground on ${host}:${port}: port is already in use. Choose another with --port or PORT.`
          )
        )
        return
      }
      rejectListen(new Error(`Cannot serve playground on ${host}:${port}: ${error.message}`))
    }
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolveListen()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Static server has no TCP address')
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  let closePromise
  const close = argument =>
    (closePromise ??= new Promise((resolveClose, rejectClose) => {
      const signal = argument?.addEventListener ? argument : argument?.signal
      const timeoutMs = argument?.timeoutMs ?? closeTimeoutMs
      const errors = []
      let settled = false
      let forceTimer
      let hardTimer
      const finish = error => {
        if (settled) return
        settled = true
        clearTimeout(forceTimer)
        clearTimeout(hardTimer)
        signal?.removeEventListener('abort', forceClose)
        if (error) errors.push(error)
        if (errors.length > 0) {
          rejectClose(
            new AggregateError(errors, `Static server cleanup failed (${errors.length} error(s))`)
          )
        } else {
          resolveClose()
        }
      }
      const attempt = operation => {
        try {
          operation?.call(server)
        } catch (error) {
          errors.push(error)
        }
      }
      const forceClose = () => {
        attempt(server.closeIdleConnections)
        attempt(server.closeAllConnections)
        for (const socket of sockets) {
          try {
            socket.destroy()
          } catch (error) {
            errors.push(error)
          }
        }
      }
      signal?.addEventListener('abort', forceClose, { once: true })
      try {
        server.close(finish)
      } catch (error) {
        finish(error)
        return
      }
      if (signal?.aborted) forceClose()
      forceTimer = setTimeout(forceClose, timeoutMs)
      hardTimer = setTimeout(
        () => finish(new Error(`Static server did not close within ${timeoutMs + 250}ms`)),
        timeoutMs + 250
      )
      forceTimer.unref?.()
      hardTimer.unref?.()
    }))
  return {
    host,
    port: address.port,
    url: `http://${urlHost}:${address.port}`,
    close
  }
}
