import { spawn } from 'node:child_process'
import { constants, createReadStream, mkdtempSync } from 'node:fs'
import { access, lstat, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { delimiter, extname, isAbsolute, join, relative, resolve } from 'node:path'

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

const DEFAULT_READINESS_TIMEOUT_MS = 90_000
const MAX_READINESS_TIMEOUT_MS = 90_000
const OUTER_READINESS_GRACE_MS = 15_000
const BROWSER_TEST_GRACE_MS = 30_000

export const readinessTimeoutMs = value => {
  if (value === undefined) return DEFAULT_READINESS_TIMEOUT_MS
  if (!/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
    throw new Error(
      `PLAYGROUND_SMOKE_READINESS_TIMEOUT_MS must be a positive integer; received: ${value || 'empty'}`
    )
  }
  const timeoutMs = Number(value)
  if (timeoutMs > MAX_READINESS_TIMEOUT_MS) {
    throw new Error(
      `PLAYGROUND_SMOKE_READINESS_TIMEOUT_MS must be at most ${MAX_READINESS_TIMEOUT_MS}ms; received: ${value}`
    )
  }
  return timeoutMs
}

export const readinessBudgets = value => {
  const readinessTimeout = readinessTimeoutMs(value)
  return {
    readinessTimeout,
    outerReadinessTimeout: readinessTimeout + OUTER_READINESS_GRACE_MS,
    browserTestTimeout: readinessTimeout + BROWSER_TEST_GRACE_MS
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
    const onOpen = () => {
      cleanup()
      resolve(socket)
    }
    const onError = event => {
      cleanup()
      reject(event.error ?? new Error(`WebSocket handshake failed for ${url}`))
    }
    const onAbort = () => {
      cleanup()
      socket.close()
      reject(signal.reason)
    }
    socket.addEventListener('open', onOpen, { once: true })
    socket.addEventListener('error', onError, { once: true })
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })

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
    now = Date.now,
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
    const competitors = [Promise.resolve().then(() => task(controller.signal))]
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
      return result
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason
      throw error
    } finally {
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

const waitForIdentitiesGone = async (tracked, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const liveIdentities = new Set((await listProcesses()).map(identity))
    const remaining = [...tracked.values()].filter(processInfo =>
      liveIdentities.has(identity(processInfo))
    )
    if (remaining.length === 0) return []
    if (Date.now() >= deadline) return remaining
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

const trackGroup = async (processGroup, tracked) => {
  for (const processInfo of await inspectProcessGroup(processGroup)) {
    tracked.set(identity(processInfo), processInfo)
  }
}

const remainingTracked = async tracked => {
  const processes = new Map(
    (await listProcesses()).map(processInfo => [identity(processInfo), processInfo])
  )
  return [...tracked.keys()].flatMap(key => (processes.has(key) ? [processes.get(key)] : []))
}

const terminateDescendantsDeepestFirst = async ({ processGroup, rootPid, tracked }) => {
  while (true) {
    await trackGroup(processGroup, tracked)
    const members = (await inspectProcessGroup(processGroup)).filter(
      ({ pid, state }) => pid !== rootPid && state !== 'Z'
    )
    if (members.length === 0) return
    const parentPids = new Set(members.map(({ ppid }) => ppid))
    const leaves = members.filter(({ pid }) => !parentPids.has(pid))
    for (const leaf of leaves) signalPid(leaf.pid, 'SIGTERM')
    let remaining = await waitForIdentitiesGone(
      new Map(leaves.map(processInfo => [identity(processInfo), processInfo])),
      2000
    )
    if (remaining.length) {
      for (const leaf of remaining) signalPid(leaf.pid, 'SIGKILL')
      remaining = await waitForIdentitiesGone(
        new Map(remaining.map(processInfo => [identity(processInfo), processInfo])),
        2000
      )
    }
    if (remaining.length) {
      throw new Error(
        `Process parents did not reap terminated descendants: ${remaining
          .map(({ pid, ppid, state }) => `${pid}(ppid=${ppid},state=${state})`)
          .join(', ')}`
      )
    }
  }
}

const waitForTrackedTreeExit = async (processGroup, tracked, timeoutMs) => {
  const deadline = Date.now() + timeoutMs
  while (true) {
    await trackGroup(processGroup, tracked)
    const remaining = await remainingTracked(tracked)
    if (remaining.length === 0) return
    if (Date.now() >= deadline) {
      throw new Error(
        `Owned process tree did not exit: ${remaining
          .map(({ pid, ppid, state }) => `${pid}(ppid=${ppid},state=${state})`)
          .join(', ')}`
      )
    }
    await delay(25)
  }
}

export const closeOwnedProcessTreeGracefully = async (child, close, { timeoutMs = 4000 } = {}) => {
  if (child.pid === undefined) return
  const tracked = new Map()
  await trackGroup(child.pid, tracked)
  await close()
  await waitForTrackedTreeExit(child.pid, tracked, timeoutMs)
}

export const terminateOwnedProcessTree = async child => {
  if (child.pid === undefined) return
  assertProcessInspection()
  const rootPid = child.pid
  const tracked = new Map()
  await trackGroup(rootPid, tracked)
  signalPid(rootPid, 'SIGTERM')
  let remaining = await waitForIdentitiesGone(tracked, 2000)
  if (remaining.length === 0) return

  await terminateDescendantsDeepestFirst({ processGroup: rootPid, rootPid, tracked })
  signalPid(rootPid, 'SIGTERM')
  remaining = await waitForIdentitiesGone(tracked, 500)
  if (remaining.length) {
    signalPid(rootPid, 'SIGKILL')
    remaining = await waitForIdentitiesGone(tracked, 500)
  }
  if (remaining.length) {
    throw new Error(
      `Owned process tree survived bounded termination: ${remaining
        .map(({ pid, ppid, state }) => `${pid}(ppid=${ppid},state=${state})`)
        .join(', ')}`
    )
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

child = subprocess.Popen(sys.argv[1:])

def forward(signum, _frame):
    try:
        child.send_signal(signum)
    except ProcessLookupError:
        pass

signal.signal(signal.SIGINT, forward)
signal.signal(signal.SIGTERM, forward)
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
  executable = 'bun',
  onDistCreated = () => {},
  onBuildProcess = () => () => {},
  onTempCreated = async () => {},
  signal
}) => {
  await rm(join(root, 'playground/dist'), { recursive: true, force: true })
  if (signal?.aborted) throw signal.reason
  const dist = mkdtempSync(join(tmpdir(), 'market-making-playground-dist-'))
  onDistCreated(dist)
  const cleanup = () => rm(dist, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  let releaseBuildProcess = () => {}
  try {
    await onTempCreated(dist)
    if (signal?.aborted) throw signal.reason
    const build = spawnOwnedProcess(
      executable,
      ['build', 'playground/index.html', '--outdir', dist, '--target', 'browser'],
      {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    releaseBuildProcess = onBuildProcess(build)
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
    const result = await new Promise(resolveResult => {
      let spawnError
      build.once('error', error => {
        spawnError = error
      })
      build.once('close', (code, closeSignal) =>
        resolveResult({ code, error: spawnError, signal: closeSignal })
      )
    })
    if (result.error) {
      throw new Error(
        `Failed to start fresh playground build with ${executable}: ${result.error.message}`
      )
    }
    if (result.code !== 0) {
      const status = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`
      throw new Error(`Fresh playground build failed with ${status}.\n${stdout}${stderr}`)
    }
    const index = join(dist, 'index.html')
    try {
      if (!(await lstat(index)).isFile()) throw new Error('not a file')
    } catch (error) {
      throw new Error(`Fresh playground build did not create ${index}: ${error.message}`)
    }
    return { cleanup, dist }
  } catch (error) {
    await cleanup()
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

export const startStaticServer = async (root, { host = '127.0.0.1', port = 0 } = {}) => {
  const servedRoot = await realpath(root)
  const server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
      const pathname = decodeURIComponent(requestUrl.pathname)
      const candidate = resolve(servedRoot, `.${pathname === '/' ? '/index.html' : pathname}`)
      const candidateRelative = relative(servedRoot, candidate)
      if (candidateRelative.startsWith('..') || isAbsolute(candidateRelative)) {
        response.writeHead(404).end('Not found')
        return
      }
      const actual = await realpath(candidate)
      const actualRelative = relative(servedRoot, actual)
      if (actualRelative.startsWith('..') || isAbsolute(actualRelative)) {
        response.writeHead(404).end('Not found')
        return
      }
      if (!(await lstat(actual)).isFile()) {
        response.writeHead(404).end('Not found')
        return
      }
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': contentTypes.get(extname(actual)) ?? 'application/octet-stream'
      })
      createReadStream(actual).pipe(response)
    } catch {
      if (!response.headersSent) response.writeHead(404)
      response.end('Not found')
    }
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
  return {
    host,
    port: address.port,
    url: `http://${urlHost}:${address.port}`,
    close: () =>
      new Promise((resolveClose, rejectClose) =>
        server.close(error => (error ? rejectClose(error) : resolveClose()))
      )
  }
}
