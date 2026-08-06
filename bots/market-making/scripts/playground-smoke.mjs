import { createHash } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  closeOwnedProcessTreeGracefully,
  createCdpClient,
  describeHttpFailures,
  discoverChromium,
  openWebSocket,
  prepareFreshDist,
  resignalAfterCleanup,
  runBounded,
  smokeBudgets,
  spawnOwnedProcess,
  startStaticServer,
  terminateOwnedProcessTree,
  waitForReadiness
} from './playground-smoke-support.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const basePath = process.env.PLAYGROUND_SMOKE_BASE_PATH ?? '/'
if (!/^\/(?:[A-Za-z0-9._-]+\/)*$/.test(basePath)) {
  throw new Error(
    `PLAYGROUND_SMOKE_BASE_PATH must be / or a slash-delimited path ending in /; received: ${basePath}`
  )
}
const budgets = smokeBudgets(process.env)
const {
  bodyTimeout,
  buildTimeout,
  cdpCommandTimeout,
  cleanupTimeout,
  startupTimeout,
  uiPollTimeout
} = budgets
const shutdown = new AbortController()
const ownedDirectories = new Set()
const children = new Set()
let server
let cleanupPromise
let terminatingSignal
let browser
let browserSocket
let browserClient
let browserReady = false

const stopChild = (child, cleanupOptions) => terminateOwnedProcessTree(child, cleanupOptions)
const trackChild = child => {
  children.add(child)
  const release = () => children.delete(child)
  child.once('close', release)
  return release
}
const stopOwnedChild = async (child, cleanupOptions) => {
  if (child === browser && browserReady && browserSocket?.readyState === WebSocket.OPEN) {
    try {
      await closeOwnedProcessTreeGracefully(
        child,
        () => {
          browserSocket.send(JSON.stringify({ id: 0, method: 'Browser.close' }))
        },
        cleanupOptions
      )
      return
    } catch (error) {
      console.error(`Graceful Chromium shutdown failed; escalating: ${error.message}`)
      // Fall through to bounded direct-parent/deepest-first termination.
    }
  }
  await stopChild(child, cleanupOptions)
}
const cleanup = () =>
  (cleanupPromise ??= runBounded(
    async (signal, deadline) => {
      browserClient?.dispose(new Error('Smoke cleanup started'))
      const cleanupOptions = { deadline, signal }
      const childResults = await Promise.allSettled(
        [...children].map(child => stopOwnedChild(child, cleanupOptions))
      )
      if (signal.aborted) {
        const failures = childResults.flatMap(result =>
          result.status === 'rejected' ? [result.reason] : []
        )
        throw new AggregateError(
          failures,
          `Smoke child cleanup exceeded its global deadline: ${failures
            .map(error => error.message)
            .join('; ')}`
        )
      }
      const resourceResults = await Promise.allSettled([
        ...(server ? [server.close(signal)] : []),
        // Node fs promises do not guarantee cancellation. These removals are best effort:
        // runBounded may return at the deadline while their terminally-handled aggregate
        // completes later. The signal path re-signals immediately after that bounded return.
        ...[...ownedDirectories].map(directory =>
          rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
        )
      ])
      const failures = [...childResults, ...resourceResults].flatMap(result =>
        result.status === 'rejected' ? [result.reason] : []
      )
      if (failures.length) {
        throw new AggregateError(
          failures,
          `Smoke cleanup failed: ${failures.map(error => error.message).join('; ')}`
        )
      }
    },
    { description: 'smoke cleanup', timeoutMs: cleanupTimeout }
  ))
const onSignal = signal => {
  if (terminatingSignal) return
  terminatingSignal = signal
  shutdown.abort(new Error(`Smoke test interrupted by ${signal}`))
  void resignalAfterCleanup({ cleanup, signal, signalHandler: onSignal })
}
process.once('SIGINT', onSignal)
process.once('SIGTERM', onSignal)

const waitAtTempCreationBoundary = async directory => {
  const readyFile = process.env.PLAYGROUND_SMOKE_TEMP_BOUNDARY_READY_FILE
  if (!readyFile) return
  const releaseFile = process.env.PLAYGROUND_SMOKE_TEMP_BOUNDARY_RELEASE_FILE
  if (!releaseFile) throw new Error('Temp creation boundary hook requires a release file')
  await writeFile(readyFile, directory)
  while (true) {
    try {
      await readFile(releaseFile)
      return
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
}

const createOwnedTempDirectory = async prefix => {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  ownedDirectories.add(directory)
  if (!shutdown.signal.aborted) return directory
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  throw shutdown.signal.reason
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

try {
  const chromiumPath = await discoverChromium()
  const preparedDist = await runBounded(
    signal =>
      prepareFreshDist({
        root,
        onDistCreated: directory => ownedDirectories.add(directory),
        onBuildProcess: trackChild,
        onTempCreated: waitAtTempCreationBoundary,
        signal: AbortSignal.any([shutdown.signal, signal])
      }),
    { description: 'fresh playground build', timeoutMs: buildTimeout }
  )
  const dist = preparedDist.dist
  let servedRoot = dist
  if (basePath !== '/') {
    servedRoot = await createOwnedTempDirectory('market-making-playground-site-')
    const mountedDist = join(servedRoot, ...basePath.split('/').filter(Boolean))
    await mkdir(mountedDist, { recursive: true })
    await cp(dist, mountedDist, { recursive: true })
  }
  const userDataDir = await createOwnedTempDirectory('market-making-playground-')
  const screenshotDirectory = await createOwnedTempDirectory(
    'market-making-playground-screenshots-'
  )
  const startupDeadline = performance.now() + startupTimeout
  const startedServer = await runBounded(() => startStaticServer(servedRoot), {
    description: 'static server startup',
    timeoutMs: startupTimeout
  })
  if (shutdown.signal.aborted) {
    await startedServer.close()
    throw shutdown.signal.reason
  }
  server = startedServer
  const port = server.port
  let browserStderr = ''
  let browserSpawnError
  browser = spawnOwnedProcess(
    chromiumPath,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank'
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  trackChild(browser)
  browser.once('error', error => {
    browserSpawnError = error
  })
  browser.stderr.setEncoding('utf8')
  browser.stderr.on('data', chunk => {
    browserStderr = `${browserStderr}${chunk}`.slice(-4000)
  })
  let phaseDeadline = startupDeadline
  const browserReadiness = description => ({
    child: browser,
    childName: 'Chromium',
    deadline: startupDeadline,
    description,
    getChildError: () => browserSpawnError,
    getStderr: () => browserStderr,
    pollIntervalMs: 25,
    timeoutMs: startupTimeout
  })

  const debuggingPort = await waitForReadiness(async () => {
    const [portText] = (await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8')).split(
      /\r?\n/
    )
    const discoveredPort = Number(portText)
    if (!Number.isInteger(discoveredPort) || discoveredPort <= 0) {
      throw new Error(`invalid Chromium debugging port: ${portText}`)
    }
    return discoveredPort
  }, browserReadiness('Chromium DevToolsActivePort; increase PLAYGROUND_SMOKE_READINESS_TIMEOUT_MS only when cold startup is expected to need longer'))
  const target = await waitForReadiness(async signal => {
    const response = await fetch(`http://127.0.0.1:${debuggingPort}/json/new?about:blank`, {
      method: 'PUT',
      signal
    })
    if (!response.ok) throw new Error(`browser target endpoint returned HTTP ${response.status}`)
    return response.json()
  }, browserReadiness('Chromium DevTools target endpoint'))
  const socket = await waitForReadiness(
    signal => openWebSocket(target.webSocketDebuggerUrl, { signal }),
    {
      ...browserReadiness('Chromium DevTools WebSocket handshake'),
      disposeResult: openedSocket => openedSocket.close()
    }
  )
  browserSocket = socket
  browserReady = true
  const requests = []
  const networkRequestEvents = []
  const networkFailures = []
  const networkResponses = []
  const consoleErrors = []
  const consoleMessages = []
  browserClient = createCdpClient(socket, {
    commandTimeoutMs: cdpCommandTimeout,
    onMessage: message => {
      if (message.method === 'Network.requestWillBeSent') {
        requests.push(message.params.request.url)
        networkRequestEvents.push({
          requestId: message.params.requestId,
          url: message.params.request.url
        })
      }
      if (message.method === 'Network.loadingFailed') networkFailures.push(message.params)
      if (message.method === 'Network.responseReceived') {
        networkResponses.push({
          status: message.params.response.status,
          type: message.params.type,
          url: message.params.response.url
        })
      }
      if (message.method === 'Runtime.exceptionThrown')
        consoleErrors.push(
          message.params.exceptionDetails.exception?.description ??
            message.params.exceptionDetails.text
        )
      if (message.method === 'Runtime.consoleAPICalled')
        consoleMessages.push(
          message.params.args
            .map(argument => argument.value ?? argument.description ?? '')
            .join(' ')
        )
      if (message.method === 'Log.entryAdded') {
        consoleMessages.push(message.params.entry.text)
        if (message.params.entry.level === 'error') consoleErrors.push(message.params.entry.text)
      }
    }
  })
  const command = (method, params = {}) =>
    browserClient.command(method, params, { deadline: phaseDeadline })
  let evaluationId = 0
  const evaluate = async expression => {
    const objectGroup = `playground-smoke-evaluation-${evaluationId++}`
    let result
    try {
      result = await command('Runtime.evaluate', {
        expression,
        objectGroup,
        awaitPromise: false,
        returnByValue: false
      })
      if (!result.exceptionDetails && result.result.subtype === 'promise') {
        result = await command('Runtime.awaitPromise', {
          promiseObjectId: result.result.objectId,
          returnByValue: true
        })
      } else if (!result.exceptionDetails && result.result.objectId) {
        result = await command('Runtime.callFunctionOn', {
          functionDeclaration: 'function () { return this }',
          objectId: result.result.objectId,
          returnByValue: true
        })
      }
    } finally {
      await command('Runtime.releaseObjectGroup', { objectGroup }).catch(() => {})
    }
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      )
    return result.result.value
  }
  await command('Page.enable')
  await command('Runtime.enable')
  await command('Log.enable')
  await command('Network.enable')
  await command('Accessibility.enable')
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false
  })
  await command('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      Object.defineProperty(globalThis, '__playgroundSmoke', { value: true })
      const accesses = []
      const securityProbeAccesses = []
      const instrumented = []
      const formBusActivity = { events: [], listeners: [], intervals: [] }
      Object.defineProperty(globalThis, '__formBusActivity', {
        value: formBusActivity,
        configurable: false,
        enumerable: false,
        writable: false
      })
      const nativeWindowDispatchEvent = Window.prototype.dispatchEvent
      Window.prototype.dispatchEvent = function (event) {
        if (event instanceof CustomEvent) formBusActivity.events.push(event.type)
        return Reflect.apply(nativeWindowDispatchEvent, this, [event])
      }
      const nativeWindowAddEventListener = Window.prototype.addEventListener
      Window.prototype.addEventListener = function (type, listener, options) {
        if (/tanstack|form|devtools|connect/i.test(String(type))) {
          formBusActivity.listeners.push(String(type))
        }
        return Reflect.apply(nativeWindowAddEventListener, this, [type, listener, options])
      }
      const nativeSetInterval = globalThis.setInterval
      globalThis.setInterval = function (...args) {
        formBusActivity.intervals.push(String(args[0]))
        return Reflect.apply(nativeSetInterval, this, args)
      }
      Object.defineProperty(globalThis, '__persistenceAccesses', {
        value: accesses,
        configurable: false,
        enumerable: false,
        writable: false
      })
      Object.defineProperty(globalThis, '__persistenceInstrumentation', {
        value: instrumented,
        configurable: false,
        enumerable: false,
        writable: false
      })
      Object.defineProperty(globalThis, '__securityProbeAccesses', {
        value: securityProbeAccesses,
        configurable: false,
        enumerable: false,
        writable: false
      })
      Object.defineProperty(globalThis, '__securityProbeActive', {
        value: false,
        configurable: true,
        enumerable: false,
        writable: true
      })
      const record = name =>
        (globalThis.__securityProbeActive ? securityProbeAccesses : accesses).push(name)
      const wrapMethod = (prototype, key, label) => {
        const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, key)
        if (!descriptor || typeof descriptor.value !== 'function') return
        instrumented.push(label)
        Object.defineProperty(prototype, key, {
          ...descriptor,
          value: function (...args) {
            record(label)
            return Reflect.apply(descriptor.value, this, args)
          }
        })
      }
      const wrapAccessor = (prototype, key, label) => {
        const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, key)
        if (!descriptor || (!descriptor.get && !descriptor.set)) return
        instrumented.push(label)
        Object.defineProperty(prototype, key, {
          ...descriptor,
          get: descriptor.get && function () {
            record(label + '.get')
            return Reflect.apply(descriptor.get, this, [])
          },
          set: descriptor.set && function (value) {
            record(label + '.set')
            return Reflect.apply(descriptor.set, this, [value])
          }
        })
      }
      const wrapConstructor = (prototype, key, label) => {
        const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, key)
        if (!descriptor || typeof descriptor.value !== 'function') return
        instrumented.push(label)
        Object.defineProperty(prototype, key, {
          ...descriptor,
          value: new Proxy(descriptor.value, {
            apply(target, thisArgument, argumentsList) {
              record(label + '.call')
              return Reflect.apply(target, thisArgument, argumentsList)
            },
            construct(target, argumentsList, newTarget) {
              record(label + '.construct')
              return Reflect.construct(target, argumentsList, newTarget)
            }
          })
        })
      }
      for (const key of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) {
        wrapMethod(globalThis.Storage?.prototype, key, 'Storage.' + key)
      }
      wrapAccessor(globalThis.Storage?.prototype, 'length', 'Storage.length')
      wrapAccessor(globalThis, 'localStorage', 'Window.localStorage')
      wrapAccessor(globalThis, 'sessionStorage', 'Window.sessionStorage')
      wrapAccessor(globalThis, 'indexedDB', 'Window.indexedDB')
      for (const key of ['open', 'deleteDatabase', 'databases', 'cmp']) {
        wrapMethod(globalThis.IDBFactory?.prototype, key, 'IDBFactory.' + key)
      }
      wrapAccessor(globalThis, 'caches', 'Window.caches')
      for (const key of ['open', 'match', 'has', 'delete', 'keys']) {
        wrapMethod(globalThis.CacheStorage?.prototype, key, 'CacheStorage.' + key)
      }
      wrapAccessor(globalThis.Navigator?.prototype, 'serviceWorker', 'Navigator.serviceWorker')
      for (const key of ['register', 'getRegistration', 'getRegistrations']) {
        wrapMethod(globalThis.ServiceWorkerContainer?.prototype, key, 'ServiceWorkerContainer.' + key)
      }
      wrapAccessor(globalThis.ServiceWorkerContainer?.prototype, 'ready', 'ServiceWorkerContainer.ready')
      wrapAccessor(globalThis.Document?.prototype, 'cookie', 'Document.cookie')
      wrapAccessor(globalThis, 'cookieStore', 'Window.cookieStore')
      for (const key of ['get', 'getAll', 'set', 'delete']) {
        wrapMethod(globalThis.CookieStore?.prototype, key, 'CookieStore.' + key)
      }
      wrapAccessor(globalThis.Navigator?.prototype, 'storage', 'Navigator.storage')
      for (const key of ['estimate', 'persist', 'persisted', 'getDirectory']) {
        wrapMethod(globalThis.StorageManager?.prototype, key, 'StorageManager.' + key)
      }
      wrapConstructor(globalThis, 'Worker', 'Window.Worker')
      wrapConstructor(globalThis, 'SharedWorker', 'Window.SharedWorker')
    })()`
  })
  await command('Page.navigate', { url: `http://127.0.0.1:${port}${basePath}` })
  await waitForReadiness(async () => {
    const readiness = await evaluate(`({
      ready: document.documentElement.dataset.playgroundReady === 'true',
      rootChildren: document.querySelector('#root')?.childElementCount ?? -1,
      rootText: document.querySelector('#root')?.textContent?.slice(0, 200) ?? '',
      failure: document.querySelector('#playground-failure')?.textContent ?? ''
    })`)
    if (!readiness.ready) {
      throw new Error(
        `playground not ready: ${JSON.stringify(readiness)}; console errors: ${consoleErrors.join('; ') || 'none'}; console messages: ${consoleMessages.join('; ') || 'none'}`
      )
    }
  }, browserReadiness('playground page readiness'))
  assert(
    await evaluate(
      "document.querySelector('#root')?.dataset.reactMounted === 'true' && document.querySelector('#root')?.childElementCount > 0"
    ),
    'React root did not commit before the ready contract'
  )
  console.log(
    `smoke environment: appPort=${port} chromiumDebugPort=${debuggingPort} chromium=${chromiumPath}`
  )
  phaseDeadline = performance.now() + bodyTimeout
  const bodyDelayMs = Number(process.env.PLAYGROUND_SMOKE_BODY_DELAY_MS ?? 0)
  if (bodyDelayMs > 0) {
    await runBounded(() => new Promise(resolve => setTimeout(resolve, bodyDelayMs)), {
      description: 'browser smoke body delay',
      timeoutMs: bodyTimeout
    })
  }
  const uiReadiness = description => ({
    child: browser,
    childName: 'Chromium',
    deadline: Math.min(performance.now() + uiPollTimeout, phaseDeadline),
    description,
    getChildError: () => browserSpawnError,
    getStderr: () => browserStderr,
    pollIntervalMs: 25,
    timeoutMs: uiPollTimeout
  })

  const cspStructure = await evaluate(`(() => {
    const content = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? ''
    const directives = Object.fromEntries(content.split(';').map(part => part.trim()).filter(Boolean).map(part => {
      const [name, ...values] = part.split(/\\s+/)
      return [name, values]
    }))
    return { content, directives }
  })()`)
  assert(
    ['connect-src', 'worker-src', 'frame-src', 'child-src'].every(
      directive => JSON.stringify(cspStructure.directives[directive]) === JSON.stringify(["'none'"])
    ),
    `playground CSP blocking directives are incomplete: ${JSON.stringify(cspStructure)}`
  )
  const httpFailuresBeforeCsp = describeHttpFailures(networkResponses)
  assert(
    consoleErrors.length === 0 && httpFailuresBeforeCsp.length === 0,
    `browser errors before CSP probes: ${consoleErrors.join('; ') || 'none'}; HTTP failures (status resource-type URL): ${httpFailuresBeforeCsp.join('; ') || 'none'}`
  )
  const cspRequestOffset = networkRequestEvents.length
  const cspProof = await evaluate(`(async () => {
    const violations = []
    const errors = []
    const rejections = []
    const executions = []
    const recordViolation = event => violations.push({
      blockedURI: event.blockedURI,
      effectiveDirective: event.effectiveDirective
    })
    const recordMessage = event => {
      if (event.data === 'csp-probe-executed') executions.push(event.data)
    }
    document.addEventListener('securitypolicyviolation', recordViolation)
    addEventListener('message', recordMessage)
    try {
      await fetch('https://csp-probe.invalid/forbidden-fetch')
    } catch (error) {
      rejections.push({ source: 'fetch', name: error.name })
    }
    await new Promise(resolve => {
      try {
        const socket = new WebSocket('wss://csp-probe.invalid/forbidden-websocket')
        socket.addEventListener('error', () => {
          errors.push('websocket')
          resolve()
        }, { once: true })
      } catch (error) {
        rejections.push({ source: 'websocket', name: error.name })
        resolve()
      }
    })
    await new Promise(resolve => {
      const script = document.createElement('script')
      script.src = 'https://csp-probe.invalid/forbidden-script.js'
      script.addEventListener('error', () => {
        errors.push('script')
        resolve()
      }, { once: true })
      document.head.append(script)
    })
    globalThis.__securityProbeActive = true
    const workerUrls = [
      new URL('csp-worker-probe.js', location.href).href,
      'data:text/javascript,postMessage(%22csp-probe-executed%22)',
      URL.createObjectURL(new Blob(['postMessage("csp-probe-executed")'], { type: 'text/javascript' }))
    ]
    const workerResults = []
    for (const url of workerUrls) {
      workerResults.push(await new Promise(resolve => {
        try {
          const worker = new Worker(url)
          let settled = false
          const finish = result => {
            if (settled) return
            settled = true
            worker.terminate()
            resolve(result)
          }
          worker.addEventListener('message', () => finish('executed'), { once: true })
          worker.addEventListener('error', event => {
            event.preventDefault()
            finish('blocked')
          }, { once: true })
          setTimeout(() => finish('blocked-timeout'), 100)
        } catch (error) {
          resolve('rejected:' + error.name)
        }
      }))
    }
    URL.revokeObjectURL(workerUrls[2])
    const frameUrls = [
      new URL('csp-frame-probe.html', location.href).href,
      'data:text/html,<script>parent.postMessage(%22csp-probe-executed%22,%22*%22)<\\/script>',
      URL.createObjectURL(new Blob(['<script>parent.postMessage("csp-probe-executed","*")<\\/script>'], { type: 'text/html' }))
    ]
    const frameResults = []
    for (const url of frameUrls) {
      frameResults.push(await new Promise(resolve => {
        const frame = document.createElement('iframe')
        frame.hidden = true
        let settled = false
        const finish = result => {
          if (settled) return
          settled = true
          frame.remove()
          resolve(result)
        }
        frame.addEventListener('load', () => finish('blocked'), { once: true })
        frame.addEventListener('error', () => finish('blocked-error'), { once: true })
        frame.src = url
        document.body.append(frame)
        setTimeout(() => finish('blocked-timeout'), 100)
      }))
    }
    URL.revokeObjectURL(frameUrls[2])
    globalThis.__securityProbeActive = false
    await new Promise(resolve => setTimeout(resolve, 50))
    document.removeEventListener('securitypolicyviolation', recordViolation)
    removeEventListener('message', recordMessage)
    return { violations, errors, rejections, executions, workerResults, frameResults }
  })()`)
  const cspDirectives = cspProof.violations.map(({ effectiveDirective }) => effectiveDirective)
  assert(
    cspDirectives.filter(directive => directive === 'connect-src').length >= 2 &&
      cspDirectives.some(
        directive => directive === 'script-src-elem' || directive === 'script-src'
      ) &&
      cspProof.errors.includes('websocket') &&
      cspProof.errors.includes('script') &&
      cspProof.rejections.some(({ source }) => source === 'fetch') &&
      cspDirectives.filter(directive => directive === 'worker-src').length >= 3 &&
      cspDirectives.filter(directive => directive === 'frame-src').length >= 3 &&
      cspProof.executions.length === 0 &&
      cspProof.workerResults.every(result => result !== 'executed') &&
      cspProof.frameResults.every(result => result !== 'executed'),
    `deliberate CSP enforcement proof failed: ${JSON.stringify(cspProof)}`
  )
  const cspExternalRequests = networkRequestEvents
    .slice(cspRequestOffset)
    .filter(
      ({ url }) =>
        url.startsWith('https://csp-probe.invalid/') || url.startsWith('wss://csp-probe.invalid/')
    )
  const cspBlockedRequestIds = new Set(
    networkFailures
      .filter(({ blockedReason }) => blockedReason === 'csp')
      .map(({ requestId }) => requestId)
  )
  const cspExternalResponses = networkResponses.filter(
    ({ url }) =>
      url.startsWith('https://csp-probe.invalid/') || url.startsWith('wss://csp-probe.invalid/')
  )
  const cspLocalProbeResponses = networkResponses.filter(
    ({ url }) => url.includes('/csp-worker-probe.js') || url.includes('/csp-frame-probe.html')
  )
  assert(
    cspExternalRequests.every(({ requestId }) => cspBlockedRequestIds.has(requestId)) &&
      cspExternalResponses.length === 0 &&
      cspLocalProbeResponses.length === 0,
    `CSP probes escaped before network: ${JSON.stringify({ cspExternalRequests, cspExternalResponses, cspLocalProbeResponses })}`
  )
  console.log(`browser CSP: PASS (${cspProof.violations.length} violations, 0 probe responses)`)
  consoleErrors.length = 0

  const auditVisibleText = async ({ width, height, mobile, state }) => {
    await command('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile
    })
    return evaluate(`(async () => {
      const details = [...document.querySelectorAll('details')]
      const detailStates = details.map(detail => detail.open)
      details.forEach(detail => { detail.open = true })
      const tabs = [...document.querySelectorAll('[role=tab]')]
      const activeTab = tabs.find(tab => tab.getAttribute('aria-selected') === 'true')
      const snapshots = []
      const inspect = tab => {
        const elements = [...document.querySelectorAll('body *')]
        const rows = elements.flatMap((element, index) => {
          if (element.matches('script,style,template,[hidden],[aria-hidden=true],.visually-hidden') ||
              element.closest('[hidden],[aria-hidden=true],.visually-hidden')) return []
          const style = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0' ||
              rect.width <= 0 || rect.height <= 0) return []
          if (style.clipPath === 'inset(50%)' ||
              (style.position === 'absolute' && rect.width <= 1 && rect.height <= 1)) return []
          const ownText = [...element.childNodes].some(
            node => node.nodeType === Node.TEXT_NODE && node.textContent.trim()
          )
          const textControl = element.matches('button,input:not([type=hidden]),select,textarea')
          if (!ownText && !textControl) return []
          const fontSize = Number.parseFloat(style.fontSize)
          return [{
            fontSize,
            tag: element.tagName.toLowerCase(),
            id: element.id,
            className: typeof element.className === 'string' ? element.className : element.className.baseVal,
            index
          }]
        })
        snapshots.push({ tab: tab?.id ?? 'none', rows })
      }
      for (const tab of tabs) {
        tab.click()
        await new Promise(resolve => requestAnimationFrame(resolve))
        inspect(tab)
      }
      if (tabs.length === 0) inspect(undefined)
      activeTab?.click()
      details.forEach((detail, index) => { detail.open = detailStates[index] })
      const rows = snapshots.flatMap(snapshot => snapshot.rows.map(row => ({ ...row, tab: snapshot.tab })))
      return {
        minimum: Math.min(...rows.map(row => row.fontSize)),
        count: rows.length,
        offenders: rows.filter(row => !Number.isFinite(row.fontSize) || row.fontSize < 11).slice(0, 50),
        tabs: snapshots.map(snapshot => snapshot.tab)
      }
    })()`)
  }
  const fontAudits = []
  for (const viewport of [
    { width: 1440, height: 1000, mobile: false, viewport: 'desktop' },
    { width: 390, height: 844, mobile: true, viewport: 'mobile' }
  ]) {
    fontAudits.push({
      state: 'default',
      viewport: viewport.viewport,
      result: await auditVisibleText({ ...viewport, state: 'default' })
    })
  }
  await evaluate(`(() => {
    const set = (selector, value) => {
      const input = document.querySelector(selector)
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set('[data-quick-field=spreadBps]', '')
    set('[data-field=MAKER_PRIVATE_KEY]', 'invalid')
    set('[data-field=BETTERSTACK_SOURCE_TOKEN]', 'font-audit-token')
    set('[data-field=BETTERSTACK_HEARTBEAT_URL]', 'javascript:font-audit')
  })()`)
  for (const viewport of [
    { width: 1440, height: 1000, mobile: false, viewport: 'desktop' },
    { width: 390, height: 844, mobile: true, viewport: 'mobile' }
  ]) {
    fontAudits.push({
      state: 'full-quick-errors-and-warning',
      viewport: viewport.viewport,
      result: await auditVisibleText({ ...viewport, state: 'full-quick-errors-and-warning' })
    })
  }
  assert(
    fontAudits.every(audit => audit.result.count > 0 && audit.result.offenders.length === 0),
    `visible UI text below 11px: ${JSON.stringify(fontAudits)}`
  )
  console.log(
    `visible fonts: PASS (${fontAudits.map(audit => `${audit.viewport}/${audit.state}=${audit.result.minimum}px`).join(', ')})`
  )
  await evaluate(`(() => {
    const set = (selector, value) => {
      const input = document.querySelector(selector)
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set('[data-quick-field=spreadBps]', '200')
    set('[data-field=MAKER_PRIVATE_KEY]', '0x' + 'a'.repeat(64))
    set('[data-field=BETTERSTACK_SOURCE_TOKEN]', '')
    set('[data-field=BETTERSTACK_HEARTBEAT_URL]', '')
  })()`)
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false
  })
  assert(
    await evaluate("document.querySelectorAll('.ladder-market').length === 1"),
    'initial ladder was not rendered immediately'
  )
  assert(
    await evaluate(
      "document.querySelector('main > .configure-surface > .workbench > .monitor-surface #ladders') && document.querySelector('main > .configure-surface > .workbench > #controls') && document.querySelector('.monitor-surface').getBoundingClientRect().width >= document.querySelector('#controls').getBoundingClientRect().width"
    ),
    'monitor/configure workbench hierarchy is missing or preview is not dominant'
  )
  assert(
    await evaluate(
      "document.querySelector('#include-sensitive-values')?.checked === false && document.querySelector('#include-sensitive-warning')?.textContent.includes('complete RPC URLs') && document.querySelector('#include-sensitive-warning')?.textContent.includes('heartbeat URLs may contain credentials')"
    ),
    'sensitive export opt-in is not explicit, unchecked, and warned'
  )
  assert(
    await evaluate(
      "document.querySelector('.ladder-scroll') && document.querySelector('.rung-table:not([hidden])') && getComputedStyle(document.querySelector('.rung-table')).display !== 'none' && document.querySelectorAll('.rung-table tbody tr').length === 6 && [...document.querySelectorAll('.rung-table thead th')].map(cell => cell.textContent).join('|') === 'Side|Rate (BPS)|Allocation (assets)|Offer maxAssets (assets)' && [...document.querySelectorAll('.rung-table tbody tr')].map(row => [row.cells[2].textContent, row.cells[3].textContent]).every(([allocation, maxAssets]) => allocation === maxAssets) && [...document.querySelectorAll('.rung-table tbody tr')].map(row => row.cells[2].textContent + ' (' + row.cells[3].textContent + ')').join('|') === '3333333334 (3333333334)|3333333333 (3333333333)|3333333333 (3333333333)|3333333333 (3333333333)|3333333333 (3333333333)|3333333334 (3333333334)'"
    ),
    'exact allocation and offer maxAssets enumeration is unavailable to assistive technology'
  )
  assert(
    await evaluate(`(() => {
      const heading = document.querySelector('.ladder-heading h3')
      const figure = document.querySelector('.ladder-graphic')
      const description = document.querySelector('#ladder-description-0')
      const scroll = document.querySelector('.ladder-scroll')
      const svg = document.querySelector('.ladder-graphic svg[role=img]')
      const table = document.querySelector('.rung-table')
      const text = description?.textContent ?? ''
      return heading?.textContent === 'Ladder market 1: allocation and offer maxAssets' &&
        figure?.getAttribute('aria-labelledby') === heading.id &&
        figure?.getAttribute('aria-describedby') === description.id &&
        scroll?.getAttribute('aria-labelledby') === heading.id &&
        scroll?.getAttribute('aria-describedby')?.split(/\\s+/).includes(description.id) &&
        svg?.getAttribute('aria-describedby') === description.id &&
        table?.getAttribute('aria-labelledby') === heading.id &&
        table?.getAttribute('aria-describedby') === description.id &&
        table?.caption?.textContent === 'Exact allocation and offer maxAssets rungs for ladder market 1' &&
        text.includes('Allocation is the configured asset amount assigned to one rung.') &&
        text.includes('Offer maxAssets is the protocol maximum asset amount for that rung’s offer.') &&
        text.includes('In shared-rung mode, allocation and offer maxAssets are equal and their rectangles share identical geometry.') &&
        text.includes('In per-book mode, each rung allocation is nested inside its side-wide offer maxAssets cap.') &&
        text.includes('This stateless graphic does not model live capacities, current offers, or the current book.')
    })()`),
    'ladder accessible description or relationships are incomplete'
  )
  const initialAccessibilityTree = await command('Accessibility.getFullAXTree')
  const initialAxNodes = initialAccessibilityTree.nodes.map(node => ({
    role: node.role?.value,
    name: node.name?.value,
    description: node.description?.value
  }))
  const expectedLadderDescription =
    'Allocation is the configured asset amount assigned to one rung. Offer maxAssets is the protocol maximum asset amount for that rung’s offer. In shared-rung mode, allocation and offer maxAssets are equal and their rectangles share identical geometry. In per-book mode, each rung allocation is nested inside its side-wide offer maxAssets cap. This stateless graphic does not model live capacities, current offers, or the current book.'
  assert(
    ['figure', 'region', 'image', 'table'].every(role =>
      initialAxNodes.some(
        node =>
          node.role === role &&
          node.name?.includes('allocation and offer maxAssets') &&
          node.description?.includes(expectedLadderDescription)
      )
    ),
    `ladder accessibility tree is incomplete: ${JSON.stringify(initialAxNodes.filter(node => ['figure', 'region', 'image', 'table'].includes(node.role)))}`
  )
  assert(
    await evaluate(
      "document.querySelectorAll('.offer-cap-bar').length === 6 && document.querySelectorAll('.allocation-bar').length === 6 && [...document.querySelectorAll('.offer-cap-bar')].every(rung => rung.dataset.rateBps && rung.dataset.allocationAssets && rung.dataset.offerMaxAssets && rung.dataset.side && Number.isFinite(Number(rung.getAttribute('y'))))"
    ),
    'ladder did not expose exact allocation, offer maxAssets, and SVG geometry'
  )
  assert(
    await evaluate(
      "['marketId','quotePremiumBps','spreadBps','stepBps','rungCount','sizeSkewBps','lowerRateBudgetAssets','higherRateBudgetAssets','targetMarketExposureAssets','maximumTotalExposureAssets','minimumOfferAssets','groupMode','loopIntervalSeconds','movementToleranceBps','minimumRateBps','maximumRateBps','referenceRateBps'].every(key => document.querySelector(`[data-parameter~=${key}]`))"
    ),
    'not every ladder parameter is visibly mapped into the graphic'
  )
  assert(
    await evaluate(
      "document.querySelectorAll('.ladder-callout').length === 8 && document.querySelector('.ladder-legend').textContent.includes('Outlined bar = offer maxAssets') && document.querySelector('.ladder-legend').textContent.includes('Nested fill = allocation') && document.querySelector('.ladder-legend').textContent.includes('live capacities and current offers remain excluded')"
    ),
    'graphic callouts or stateless legend are missing'
  )

  const quickEditStructure = await evaluate(`(() => {
    const quick = document.querySelector('#quick-edit')
    const fieldsets = [...(quick?.querySelectorAll('fieldset') ?? [])]
    const fields = [...(quick?.querySelectorAll('[data-quick-field]') ?? [])]
    return {
      directlyBelowGraphic: quick?.previousElementSibling?.id === 'ladders',
      progressive: fieldsets.every(fieldset => fieldset.closest('details')),
      groups: fieldsets.map(fieldset => fieldset.querySelector('legend')?.textContent),
      fields: fields.map(field => field.dataset.quickField),
      labeled: fields.every(field => field.labels?.length && field.getAttribute('aria-describedby')),
      fullEditorLink: quick?.querySelector('a[href="#generated-controls"]')?.textContent.includes('full configuration')
    }
  })()`)
  assert(
    quickEditStructure.directlyBelowGraphic &&
      quickEditStructure.progressive &&
      [
        'Market',
        'Center',
        'Spacing & Gap',
        'Sizing & Skew',
        'Budgets & Exposure',
        'Runtime & Bounds'
      ].every(group => quickEditStructure.groups.includes(group)) &&
      [
        'referenceRateBps',
        'marketId',
        'quotePremiumBps',
        'spreadBps',
        'stepBps',
        'rungCount',
        'sizeSkewBps',
        'minimumOfferAssets',
        'lowerRateBudgetAssets',
        'higherRateBudgetAssets',
        'targetMarketExposureAssets',
        'maximumTotalExposureAssets',
        'groupMode',
        'loopIntervalSeconds',
        'movementToleranceBps',
        'minimumRateBps',
        'maximumRateBps'
      ].every(field => quickEditStructure.fields.includes(field)) &&
      quickEditStructure.fields.length === 17 &&
      quickEditStructure.labeled &&
      quickEditStructure.fullEditorLink,
    `quick edit structure is incomplete: ${JSON.stringify(quickEditStructure)}`
  )

  const ladderJsonIo = await evaluate(`(async () => {
    const nextFrame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const area = document.querySelector('#ladder-import')
    const drop = document.querySelector('#ladder-import-drop')
    const file = document.querySelector('#ladder-import-file')
    const text = document.querySelector('#ladder-import-text')
    const apply = document.querySelector('#apply-ladder-import')
    const status = document.querySelector('#ladder-import-status')
    const envTab = document.querySelector('#tab-ladder-env')
    const envOutput = document.querySelector('#export-ladder-env')
    const initial = envOutput?.value
    const fileLabel = document.querySelector('label[for="ladder-import-file"]')
    const accessible = Boolean(
      area && drop && file && fileLabel && text && apply && status && envTab && envOutput &&
      file.accept.includes('.json') && text.getAttribute('aria-describedby')?.includes('ladder-import-help') &&
      status.getAttribute('role') === 'status' && drop.getAttribute('role') === 'group' &&
      drop.getAttribute('aria-describedby')?.includes('ladder-import-help') &&
      !drop.hasAttribute('tabindex') && !drop.contains(file) &&
      file.labels?.length === 1 && file.labels[0] === fileLabel &&
      fileLabel.textContent.trim().length > 0 && file.tabIndex === 0
    )
    file.focus()
    const nativeFileFocus = document.activeElement === file
    const documentedCopy = area.textContent
    const documentedShapes = documentedCopy.includes('LADDER_MARKETS array') &&
      documentedCopy.includes('one exact ladder object') &&
      documentedCopy.includes('JSON string literal') &&
      documentedCopy.includes('either') &&
      !documentedCopy.includes('full playground JSON export')
    text.value = initial
    apply.click()
    await nextFrame()
    const pasteApplied = status.dataset.status === 'ok' && status.textContent.includes('1 ladder') &&
      document.querySelectorAll('#controls .market-card:has([data-field=quotePremiumBps])').length === 1 &&
      document.querySelectorAll('.ladder-market').length === 1 &&
      document.querySelector('#quick-market-select').options.length === 1 &&
      document.querySelector('[data-quick-field=marketId]').value === JSON.parse(initial)[0].marketId
    text.value = JSON.stringify(initial)
    apply.click()
    await nextFrame()
    const stringLiteralApplied = status.dataset.status === 'ok' && envOutput.value === initial
    const beforeShapeFailure = envOutput.value
    text.value = JSON.stringify({ LADDER_MARKETS: JSON.parse(initial) })
    apply.click()
    await nextFrame()
    const wrapperRejected = status.dataset.status === 'error' && envOutput.value === beforeShapeFailure
    const originalGraphic = document.querySelector('.ladder-graphic svg')?.outerHTML
    const modified = JSON.parse(initial)
    modified[0].quotePremiumBps = '25'
    text.value = JSON.stringify(modified)
    apply.click()
    await nextFrame()
    const previewUpdated = envOutput.value === JSON.stringify(modified) &&
      document.querySelector('.ladder-graphic svg')?.outerHTML !== originalGraphic &&
      document.querySelector('[data-quick-field=quotePremiumBps]').value === '25' &&
      getComputedStyle(document.querySelector('.monitor-surface')).position === 'sticky'
    text.value = initial
    apply.click()
    await nextFrame()
    const roundTripRestored = envOutput.value === initial &&
      document.querySelector('.ladder-graphic svg')?.outerHTML === originalGraphic
    const beforeFailure = envOutput.value
    const beforeGraphic = document.querySelector('.ladder-graphic svg')?.outerHTML
    const duplicate = initial.replace('{', '{"marketId":"0x' + '5'.repeat(64) + '",')
    text.value = duplicate
    apply.click()
    await nextFrame()
    const duplicatePasteRejected = status.dataset.status === 'error' &&
      status.textContent === 'Import contains duplicate JSON member names' &&
      envOutput.value === beforeFailure && document.querySelector('.ladder-graphic svg')?.outerHTML === beforeGraphic
    text.value = JSON.stringify([{ marketId: '0x' + '5'.repeat(64), rungCount: '0' }])
    apply.click()
    await nextFrame()
    const atomicFailure = status.dataset.status === 'error' && status.textContent.includes('ladder[0]') &&
      envOutput.value === beforeFailure && document.querySelector('.ladder-graphic svg')?.outerHTML === beforeGraphic
    text.value = 'x'.repeat(131073)
    apply.click()
    await nextFrame()
    const oversizedRejected = status.dataset.status === 'error' && status.textContent.includes('128 KiB') &&
      envOutput.value === beforeFailure
    const dropFiles = files => {
      const transfer = new DataTransfer()
      for (const candidate of files) transfer.items.add(candidate)
      drop.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
    drop.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))
    await nextFrame()
    const dragStateVisible = drop.classList.contains('is-dragging')
    drop.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }))
    await nextFrame()
    const dragStateCleared = !drop.classList.contains('is-dragging')
    const waitForImportStatus = async predicate => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return true
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      return false
    }
    dropFiles([new File([initial], 'ladder.json', { type: 'application/json' })])
    const validDropSettled = await waitForImportStatus(() => status.dataset.status === 'ok')
    const dropApplied = validDropSettled && envOutput.value === initial
    dropFiles([new File([duplicate], 'duplicate.json', { type: 'application/json' })])
    const duplicateDropSettled = await waitForImportStatus(
      () => status.dataset.status === 'error' && status.textContent === 'Import contains duplicate JSON member names'
    )
    const duplicateDropRejected = duplicateDropSettled && envOutput.value === initial &&
      document.querySelector('.ladder-graphic svg')?.outerHTML === beforeGraphic
    const controlValues = selector => [...document.querySelectorAll(selector)].map(input => input.value)
    const semanticBefore = {
      env: envOutput.value,
      controls: controlValues('#controls [data-field]'),
      quick: controlValues('#quick-edit [data-quick-field]'),
      graphic: document.querySelector('.ladder-graphic svg')?.outerHTML,
      text: text.value
    }
    const syntacticallyValidSemanticFailure = JSON.stringify([{ marketId: '0x' + '5'.repeat(64), rungCount: '0' }])
    dropFiles([new File([syntacticallyValidSemanticFailure], 'semantic-invalid.json', { type: 'application/json' })])
    const semanticInvalidSettled = await waitForImportStatus(
      () => status.dataset.status === 'error' && status.textContent.includes('ladder[0]')
    )
    const semanticInvalidDropAtomic = semanticInvalidSettled &&
      envOutput.value === semanticBefore.env && text.value === semanticBefore.text &&
      JSON.stringify(controlValues('#controls [data-field]')) === JSON.stringify(semanticBefore.controls) &&
      JSON.stringify(controlValues('#quick-edit [data-quick-field]')) === JSON.stringify(semanticBefore.quick) &&
      document.querySelector('.ladder-graphic svg')?.outerHTML === semanticBefore.graphic
    dropFiles([new File([initial], 'ladder.txt', { type: 'text/plain' })])
    const invalidDropSettled = await waitForImportStatus(
      () => status.dataset.status === 'error' && status.textContent.includes('JSON file')
    )
    const mimeRejected = invalidDropSettled && envOutput.value === initial
    dropFiles([
      new File([initial], 'one.json', { type: 'application/json' }),
      new File([initial], 'two.json', { type: 'application/json' })
    ])
    await new Promise(resolve => setTimeout(resolve, 0))
    const multipleRejected = status.dataset.status === 'error' && status.textContent.includes('one JSON file') && envOutput.value === initial

    const variant = premium => {
      const value = JSON.parse(initial)
      value[0].quotePremiumBps = String(premium)
      return JSON.stringify(value)
    }
    const deferredFile = name => {
      let resolve
      let reject
      const file = new File(['{}'], name, { type: 'application/json' })
      Object.defineProperty(file, 'text', {
        value: () => new Promise((onResolve, onReject) => {
          resolve = onResolve
          reject = onReject
        })
      })
      return { file, resolve: value => resolve(value), reject: error => reject(error) }
    }
    const dispatchFiles = files => {
      const event = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: { files } })
      drop.dispatchEvent(event)
    }

    const slowOld = deferredFile('slow-old.json')
    const fastNew = variant(41)
    dispatchFiles([slowOld.file])
    dispatchFiles([new File([fastNew], 'fast-new.json', { type: 'application/json' })])
    await waitForImportStatus(() => envOutput.value === fastNew)
    const latestGraphic = document.querySelector('.ladder-graphic svg')?.outerHTML
    slowOld.resolve(variant(31))
    await nextFrame()
    const slowOldFastNew = envOutput.value === fastNew && text.value === fastNew &&
      status.dataset.status === 'ok' && status.textContent.includes('Applied') &&
      document.querySelector('.ladder-graphic svg')?.outerHTML === latestGraphic

    const delayedBeforeDraft = deferredFile('delayed-before-draft.json')
    const draftBefore = {
      env: envOutput.value,
      controls: controlValues('#controls [data-field]'),
      selected: document.querySelector('#quick-market-select')?.value,
      status: status.textContent,
      statusKind: status.dataset.status
    }
    dispatchFiles([delayedBeforeDraft.file])
    const unappliedDraft = variant(47)
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(text, unappliedDraft)
    text.dispatchEvent(new Event('input', { bubbles: true }))
    delayedBeforeDraft.resolve(variant(48))
    await nextFrame()
    const delayedFileSupersededByDraft = text.value === unappliedDraft &&
      envOutput.value === draftBefore.env &&
      JSON.stringify(controlValues('#controls [data-field]')) === JSON.stringify(draftBefore.controls) &&
      document.querySelector('#quick-market-select')?.value === draftBefore.selected &&
      status.textContent === draftBefore.status && status.dataset.status === draftBefore.statusKind

    const rejectedBeforeDraft = deferredFile('rejected-before-draft.json')
    dispatchFiles([rejectedBeforeDraft.file])
    const errorDraft = variant(49)
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(text, errorDraft)
    text.dispatchEvent(new Event('input', { bubbles: true }))
    rejectedBeforeDraft.reject(new Error('superseded read detail'))
    await nextFrame()
    const delayedErrorSupersededByDraft = text.value === errorDraft &&
      envOutput.value === draftBefore.env && status.textContent === draftBefore.status &&
      status.dataset.status === draftBefore.statusKind && !status.textContent.includes('superseded')

    const marketIds = document.querySelector('[data-field=MARKET_IDS]')
    const setNativeInputValue = (input, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const ladderControlValues = () => controlValues(
      '#controls .market-card:has([data-field=quotePremiumBps]) [data-field]'
    )
    const currentLaddersBeforeConfigRace = ladderControlValues()
    const staleForChangedAllowlist = deferredFile('stale-for-changed-allowlist.json')
    dispatchFiles([staleForChangedAllowlist.file])
    const replacementMarketId = '0x' + '6'.repeat(64)
    setNativeInputValue(marketIds, replacementMarketId)
    await nextFrame()
    staleForChangedAllowlist.resolve(initial)
    const configRaceRejected = await waitForImportStatus(
      () => status.dataset.status === 'error' && status.textContent.trim().length > 0
    )
    const staleConfigImportAtomic = configRaceRejected &&
      JSON.stringify(ladderControlValues()) === JSON.stringify(currentLaddersBeforeConfigRace)
    const validForCurrentAllowlist = JSON.parse(initial)
    validForCurrentAllowlist[0].marketId = replacementMarketId
    const currentValidText = JSON.stringify(validForCurrentAllowlist)
    const currentValid = deferredFile('current-valid.json')
    dispatchFiles([currentValid.file])
    currentValid.resolve(currentValidText)
    const currentValidCompletion = await waitForImportStatus(
      () => status.dataset.status === 'ok' &&
        document.querySelector(
          '#controls .market-card:has([data-field=quotePremiumBps]) [data-field=marketId]'
        )?.value === replacementMarketId
    )
    setNativeInputValue(marketIds, JSON.parse(initial)[0].marketId)
    text.value = initial
    apply.click()
    await nextFrame()

    const secondMarketId = '0x' + '7'.repeat(64)
    setNativeInputValue(marketIds, JSON.parse(initial)[0].marketId + ',' + secondMarketId)
    const reorderedPair = JSON.parse(initial)
    reorderedPair.push({ ...reorderedPair[0], marketId: secondMarketId, quotePremiumBps: '17' })
    text.value = JSON.stringify(reorderedPair)
    apply.click()
    await nextFrame()
    const importDuringReorder = deferredFile('import-during-reorder.json')
    dispatchFiles([importDuringReorder.file])
    document.querySelector(
      '#controls .market-card:has([data-field=quotePremiumBps]) .item-actions button:nth-of-type(2)'
    )?.click()
    await nextFrame()
    importDuringReorder.resolve(initial)
    const concurrentReorderImport = await waitForImportStatus(
      () => status.dataset.status === 'ok' &&
        document.querySelectorAll(
          '#controls .market-card:has([data-field=quotePremiumBps])'
        ).length === 1 &&
        document.querySelector(
          '#controls .market-card:has([data-field=quotePremiumBps]) [data-field=marketId]'
        )?.value === JSON.parse(initial)[0].marketId
    )
    setNativeInputValue(marketIds, JSON.parse(initial)[0].marketId)
    await nextFrame()

    const fileBeforePaste = deferredFile('file-before-paste.json')
    dispatchFiles([fileBeforePaste.file])
    text.value = initial
    apply.click()
    await nextFrame()
    fileBeforePaste.resolve(variant(51))
    await nextFrame()
    const fileThenPaste = envOutput.value === initial && text.value === initial && status.dataset.status === 'ok'

    const oldBeforeInvalid = deferredFile('old-before-invalid.json')
    dispatchFiles([oldBeforeInvalid.file])
    dispatchFiles([new File([variant(61)], 'invalid.txt', { type: 'text/plain' })])
    await nextFrame()
    const invalidStatus = status.textContent
    oldBeforeInvalid.resolve(variant(62))
    await nextFrame()
    const invalidBeatsOldSuccess = envOutput.value === initial && status.dataset.status === 'error' &&
      status.textContent === invalidStatus && status.textContent.includes('JSON file')

    const staleUnreadable = deferredFile('stale-unreadable.json')
    dispatchFiles([staleUnreadable.file])
    const afterStaleError = variant(71)
    text.value = afterStaleError
    apply.click()
    await nextFrame()
    const successStatus = status.textContent
    staleUnreadable.reject(new Error('secret stale read detail'))
    await nextFrame()
    const staleErrorDiscarded = envOutput.value === afterStaleError && status.dataset.status === 'ok' &&
      status.textContent === successStatus && !status.textContent.includes('secret')

    const beforeUnreadable = envOutput.value
    const unreadableLatest = deferredFile('unreadable-latest.json')
    dispatchFiles([unreadableLatest.file])
    unreadableLatest.reject(new Error('filesystem secret'))
    await nextFrame()
    const unreadableLatestSafe = envOutput.value === beforeUnreadable && status.dataset.status === 'error' &&
      status.textContent === 'The JSON file could not be read.' && !status.textContent.includes('filesystem')

    let oversizedTextCalls = 0
    const oversizedFile = new File(['x'.repeat(131073)], 'oversized.json', { type: 'application/json' })
    Object.defineProperty(oversizedFile, 'text', { value: async () => { oversizedTextCalls++; return initial } })
    dispatchFiles([oversizedFile])
    await nextFrame()
    const oversizedFileSkippedRead = oversizedTextCalls === 0 && status.dataset.status === 'error' &&
      status.textContent.includes('128 KiB') && envOutput.value === beforeUnreadable

    text.value = '"' + 'é'.repeat(65535) + '"'
    apply.click()
    await nextFrame()
    const utf8AtBoundary = status.dataset.status === 'error' && !status.textContent.includes('128 KiB')
    text.value = '"' + 'é'.repeat(65536) + '"'
    apply.click()
    await nextFrame()
    const utf8OverBoundary = status.dataset.status === 'error' && status.textContent.includes('128 KiB')

    const inputChangeValue = variant(81)
    const inputTransfer = new DataTransfer()
    inputTransfer.items.add(new File([inputChangeValue], 'input-change.json', { type: 'application/json' }))
    Object.defineProperty(file, 'files', { value: inputTransfer.files, configurable: true })
    file.dispatchEvent(new Event('change', { bubbles: true }))
    await waitForImportStatus(() => envOutput.value === inputChangeValue)
    const fileInputChange = envOutput.value === inputChangeValue && text.value === inputChangeValue &&
      status.dataset.status === 'ok'

    text.value = initial
    apply.click()
    await nextFrame()
    envTab.click()
    await nextFrame()
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { copied = value } }, configurable: true })
    document.querySelector('#copy-export').click()
    await new Promise(resolve => setTimeout(resolve, 0))
    const exactCopy = copied === initial && !copied.includes('\\n') && !copied.startsWith('LADDER_MARKETS=')
    document.querySelector('#tab-yaml').click()
    return {
      accessible,
      nativeFileFocus,
      documentedShapes,
      pasteApplied,
      stringLiteralApplied,
      wrapperRejected,
      previewUpdated,
      roundTripRestored,
      duplicatePasteRejected,
      atomicFailure,
      oversizedRejected,
      dragStateVisible,
      dragStateCleared,
      dropApplied,
      duplicateDropRejected,
      semanticInvalidDropAtomic,
      mimeRejected,
      multipleRejected,
      slowOldFastNew,
      delayedFileSupersededByDraft,
      delayedErrorSupersededByDraft,
      staleConfigImportAtomic,
      currentValidCompletion,
      concurrentReorderImport,
      fileThenPaste,
      invalidBeatsOldSuccess,
      staleErrorDiscarded,
      unreadableLatestSafe,
      oversizedFileSkippedRead,
      utf8AtBoundary,
      utf8OverBoundary,
      fileInputChange,
      exactCopy
    }
  })()`)
  assert(
    Object.values(ladderJsonIo).every(Boolean),
    `ladder JSON import/export failed: ${JSON.stringify(ladderJsonIo)}`
  )

  const reactIdentityProof = await evaluate(`(async () => {
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const set = (element, value) => {
      const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value)
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    }
    const allowlist = document.querySelector('[data-field=MARKET_IDS]')
    const importText = document.querySelector('#ladder-import-text')
    const apply = document.querySelector('#apply-ladder-import')
    const initial = JSON.parse(document.querySelector('#export-ladder-env').value)
    const firstMarketId = initial[0].marketId
    const secondMarketId = '0x' + '6'.repeat(64)
    set(allowlist, firstMarketId + ',' + secondMarketId)
    const pair = [initial[0], { ...initial[0], marketId: secondMarketId, quotePremiumBps: '19' }]
    set(importText, JSON.stringify(pair))
    apply.click()
    await frame()

    let ladderCards = [...document.querySelectorAll('.market-card:has([data-field=quotePremiumBps])')]
    const firstOldId = ladderCards[0].dataset.uiId
    const secondCard = ladderCards[1]
    const secondId = secondCard.dataset.uiId
    const switcher = document.querySelector('#quick-market-select')
    set(switcher, secondId)
    await frame()
    const focused = secondCard.querySelector('[data-field=stepBps]')
    focused.focus()
    secondCard.querySelector('.item-actions button:first-child').click()
    await frame()
    ladderCards = [...document.querySelectorAll('.market-card:has([data-field=quotePremiumBps])')]
    const ladderFocusMoved = document.activeElement === focused && ladderCards[0] === secondCard &&
      focused.value === initial[0].stepBps && switcher.value === secondId &&
      document.querySelector('[data-quick-field=marketId]').value === secondMarketId

    set(focused, '90')
    await frame()
    const movedExport = JSON.parse(document.querySelector('#export-ladder-env').value)
    const movedEditOnly = movedExport[0].marketId === secondMarketId && movedExport[0].stepBps === '90' &&
      movedExport[1].marketId === firstMarketId && movedExport[1].stepBps === initial[0].stepBps


    const marketInput = secondCard.querySelector('[data-field=marketId]')
    set(marketInput, 'invalid')
    await frame()
    const invalidEditStable = secondCard.dataset.uiId === secondId && switcher.value === secondId
    set(marketInput, firstMarketId)
    await frame()
    const duplicateEditStable = secondCard.dataset.uiId === secondId && switcher.value === secondId &&
      document.querySelector('#quick-validation-status').textContent === 'ladder market IDs must be unique' &&
      document.querySelector('[data-quick-field=marketId]').getAttribute('aria-invalid') === 'false'
    set(marketInput, secondMarketId)
    await frame()

    secondCard.querySelector('.item-actions button:last-child').click()
    await frame()
    ladderCards = [...document.querySelectorAll('.market-card:has([data-field=quotePremiumBps])')]
    const selectionDeleteCoherent = ladderCards.length === 1 && switcher.value === ladderCards[0].dataset.uiId &&
      switcher.value === firstOldId && document.querySelector('[data-quick-field=marketId]').value === firstMarketId

    set(importText, JSON.stringify(pair))
    apply.click()
    await frame()
    ladderCards = [...document.querySelectorAll('.market-card:has([data-field=quotePremiumBps])')]
    const importedIds = ladderCards.map(card => card.dataset.uiId)
    const selectionImportCoherent = switcher.value === importedIds[0] &&
      !importedIds.includes(firstOldId) && !importedIds.includes(secondId)
    const exportsExcludeUiIds = [...document.querySelectorAll('#export-yaml,#export-shell,#export-json,#export-ladder-env')]
      .every(output => !output.value.includes('-ui-') && !output.value.includes('data-ui-id'))

    const ladderSection = ladderCards[0].closest('.control-section')
    ladderCards.at(-1).querySelector('.item-actions button:last-child').click()
    await frame()
    document.querySelector('.market-card:has([data-field=quotePremiumBps]) .item-actions button:last-child').click()
    await frame()
    const deleteLastEmpty = document.querySelectorAll('.market-card:has([data-field=quotePremiumBps])').length === 0 &&
      document.querySelector('#quick-edit .empty-state')?.textContent.includes('enable quick edit')
    ladderSection.querySelector('.section-heading button').click()
    await frame()
    const addedCard = document.querySelector('.market-card:has([data-field=quotePremiumBps])')
    const emptyThenAdd = deleteLastEmpty && Boolean(addedCard?.dataset.uiId) &&
      document.querySelector('#quick-market-select').value === addedCard.dataset.uiId

    ladderSection.querySelector('.section-heading button').click()
    await Promise.resolve()
    const rapidCards = [...document.querySelectorAll('.market-card:has([data-field=quotePremiumBps])')]
    rapidCards.at(-1)?.querySelector('.item-actions button:first-child')?.click()
    rapidCards[0]?.querySelector('.item-actions button:last-child')?.click()
    set(importText, JSON.stringify(pair))
    apply.click()
    await frame()
    const rapidFinalCards = [...document.querySelectorAll('.market-card:has([data-field=quotePremiumBps])')]
    const rapidFinalIds = rapidFinalCards.map(card => card.dataset.uiId)
    const rapidIdsSynchronized = rapidFinalCards.length === pair.length &&
      new Set(rapidFinalIds).size === rapidFinalIds.length &&
      [...document.querySelector('#quick-market-select').options].every((option, index) => option.value === rapidFinalIds[index]) &&
      rapidFinalIds.includes(document.querySelector('#quick-market-select').value) &&
      !document.querySelector('#export-ladder-env').value.includes('-ui-')

    const bootstrapCards = () => [...document.querySelectorAll('.market-card:has([data-field=creditTarget])')]
    bootstrapCards()[0].closest('.control-section').querySelector('.section-heading button').click()
    await frame()
    const bootstrapSecond = bootstrapCards()[1]
    const bootstrapFocused = bootstrapSecond.querySelector('[data-field=creditTarget]')
    bootstrapFocused.focus()
    bootstrapSecond.querySelector('.item-actions button:first-child').click()
    await frame()
    const bootstrapFocusMoved = document.activeElement === bootstrapFocused && bootstrapCards()[0] === bootstrapSecond
    bootstrapSecond.querySelector('.item-actions button:last-child').click()
    await frame()

    set(allowlist, firstMarketId)
    set(importText, JSON.stringify(initial))
    apply.click()
    await frame()
    return {
      ladderFocusMoved,
      movedEditOnly,
      invalidEditStable,
      duplicateEditStable,
      selectionDeleteCoherent,
      selectionImportCoherent,
      exportsExcludeUiIds,
      emptyThenAdd,
      rapidIdsSynchronized,
      bootstrapFocusMoved
    }
  })()`)
  assert(
    Object.values(reactIdentityProof).every(Boolean),
    `stable React identity proof failed: ${JSON.stringify(reactIdentityProof)}`
  )

  const quickValidationProof = await evaluate(`(async () => {
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const set = (element, value) => {
      const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value)
      element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    }
    const scalar = document.querySelector('[data-field=MAKER_PRIVATE_KEY]')
    const allowlist = document.querySelector('[data-field=MARKET_IDS]')
    const bootstrapMinimum = document.querySelector('.market-card:has([data-field=creditTarget]) [data-field=minimumRateBps]')
    const ladderCard = document.querySelector('.market-card:has([data-field=quotePremiumBps])')
    const ladderStep = ladderCard.querySelector('[data-field=stepBps]')
    const ladderMinimum = ladderCard.querySelector('[data-field=minimumRateBps]')
    const ladderRungCount = ladderCard.querySelector('[data-field=rungCount]')
    const ladderMinimumOffer = ladderCard.querySelector('[data-field=minimumOfferAssets]')
    const reference = document.querySelector('#preview-reference')
    const initialMarketId = ladderCard.querySelector('[data-field=marketId]').value
    const initial = document.querySelector('#export-ladder-env').value
    set(scalar, 'invalid')
    set(bootstrapMinimum, 'invalid-bootstrap-rate')
    set(ladderStep, 'invalid-step')
    set(reference, 'invalid-reference')
    await frame()
    const quickStep = document.querySelector('[data-quick-field=stepBps]')
    const quickMinimum = document.querySelector('[data-quick-field=minimumRateBps]')
    const quickReference = document.querySelector('[data-quick-field=referenceRateBps]')
    const scalarStepReference = quickStep.getAttribute('aria-invalid') === 'true' &&
      document.querySelector('#quick-error-stepBps').textContent === 'ladder[0].stepBps must be an integer' &&
      quickReference.getAttribute('aria-invalid') === 'true' &&
      document.querySelector('#quick-error-referenceRateBps').textContent === 'referenceRateBps must be an integer'
    const bootstrapNameNeverAttributed = quickMinimum.getAttribute('aria-invalid') === 'false' &&
      document.querySelector('#quick-error-minimumRateBps').textContent === ''

    set(ladderRungCount, 'invalid-count')
    set(ladderMinimumOffer, '0')
    await frame()
    const multipleSelectedFields = ['stepBps', 'rungCount', 'minimumOfferAssets'].every(field =>
      document.querySelector('[data-quick-field=' + field + ']').getAttribute('aria-invalid') === 'true' &&
      document.querySelector('#quick-error-' + field).textContent.startsWith('ladder[0].' + field + ' ')
    )

    set(allowlist, 'malformed-market-list')
    set(reference, '0')
    await frame()
    const malformedAllowlistIndependent = document.querySelector('#quick-validation-status').textContent ===
      'MARKET_IDS must contain 0x-prefixed 32-byte hex values' &&
      document.querySelector('#quick-error-stepBps').textContent === 'ladder[0].stepBps must be an integer' &&
      document.querySelector('#quick-error-referenceRateBps').textContent === 'referenceRateBps must be positive' &&
      !document.querySelector('#quick-edit').textContent.includes('must be allowlisted')

    set(allowlist, initialMarketId)
    set(ladderStep, '100')
    set(ladderRungCount, '3')
    set(ladderMinimumOffer, '101000000')
    set(reference, '500')
    set(ladderMinimum, '200')
    set(bootstrapMinimum, '200')
    set(scalar, '0x' + 'a'.repeat(64))
    await frame()

    const ladderSection = ladderCard.closest('.control-section')
    ladderSection.querySelector('.section-heading button').click()
    await frame()
    ladderSection.querySelector('.section-heading button').click()
    await frame()
    const cards = [...document.querySelectorAll('.market-card:has([data-field=quotePremiumBps])')]
    const switcher = document.querySelector('#quick-market-select')
    set(switcher, cards[1].dataset.uiId)
    set(cards[2].querySelector('[data-field=stepBps]'), 'unrelated-invalid-step')
    await frame()
    const duplicateWithOtherInvalid = document.querySelector('#quick-validation-status').textContent ===
      'ladder market IDs must be unique' &&
      document.querySelector('[data-quick-field=stepBps]').getAttribute('aria-invalid') === 'false'

    const mixedCaseMarketId = '0x' + 'aB'.repeat(32)
    set(allowlist, mixedCaseMarketId + ',' + initialMarketId)
    set(cards[0].querySelector('[data-field=marketId]'), mixedCaseMarketId)
    set(cards[1].querySelector('[data-field=marketId]'), mixedCaseMarketId.toUpperCase().replace('0X', '0x'))
    await frame()
    const mixedCaseDuplicate = document.querySelector('#quick-validation-status').textContent ===
      'ladder market IDs must be unique'

    const importText = document.querySelector('#ladder-import-text')
    set(allowlist, initialMarketId)
    set(importText, JSON.stringify([{ ...JSON.parse(initial)[0], marketId: initialMarketId, stepBps: '100' }]))
    document.querySelector('#apply-ladder-import').click()
    await frame()
    return {
      scalarStepReference,
      bootstrapNameNeverAttributed,
      multipleSelectedFields,
      malformedAllowlistIndependent,
      duplicateWithOtherInvalid,
      mixedCaseDuplicate
    }
  })()`)
  assert(
    Object.values(quickValidationProof).every(Boolean),
    `quick structured validation proof failed: ${JSON.stringify(quickValidationProof)}`
  )
  const captureImportViewport = async (path, selector = '#ladder-import', block = 'start') => {
    await evaluate(
      `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({ block: ${JSON.stringify(block)} })`
    )
    await new Promise(resolve => setTimeout(resolve, 50))
    const shot = await command('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false
    })
    await writeFile(path, Buffer.from(shot.data, 'base64'))
  }
  await captureImportViewport(join(screenshotDirectory, 'ladder-jsonio-desktop.png'))
  await command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true
  })
  await captureImportViewport(
    join(screenshotDirectory, 'ladder-jsonio-mobile-drop.png'),
    '#ladder-import-drop',
    'center'
  )
  await captureImportViewport(
    join(screenshotDirectory, 'ladder-jsonio-mobile.png'),
    '#apply-ladder-import',
    'end'
  )
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluate('scrollTo(0, 0)')

  const stickyGeometryAt = async ({ width, height, mobile, expectedColumns }) => {
    await command('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile
    })
    return evaluate(`(async () => {
      scrollTo(0, 0)
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const monitor = document.querySelector('.monitor-surface')
      const controls = document.querySelector('#controls')
      const workbench = document.querySelector('.workbench')
      const monitorCss = getComputedStyle(monitor)
      const monitorAtStart = monitor.getBoundingClientRect()
      const controlsAtStart = controls.getBoundingClientRect()
      const stacked = controlsAtStart.top >= monitorAtStart.bottom - 1
      const representativeControls = selector => {
        const matches = [...document.querySelectorAll(selector)]
        return [matches[0], matches[Math.floor(matches.length / 2)], matches.at(-1)].filter(Boolean)
      }
      const targets = [
        ...representativeControls(
          '#controls .market-card:has([data-field=autoRefill]) input, #controls .market-card:has([data-field=autoRefill]) select'
        ),
        ...representativeControls(
          '#controls .market-card:has([data-field=quotePremiumBps]) input, #controls .market-card:has([data-field=quotePremiumBps]) select'
        )
      ]
      const measurements = []
      const stickyTop = Number.parseFloat(monitorCss.top)
      const ancestors = []
      for (let ancestor = monitor.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor)
        ancestors.push({ tag: ancestor.tagName, className: ancestor.className, overflow: style.overflow, overflowY: style.overflowY })
      }
      for (const [index, target] of targets.entries()) {
        target.focus({ preventScroll: true })
        target.scrollIntoView({ block: 'center' })
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const before = monitor.getBoundingClientRect()
        const scrollBefore = scrollY
        const spread = document.querySelector('.market-card:has([data-field=quotePremiumBps]) [data-field=spreadBps]')
        const oldLabel = document.querySelector('.spread-gap-label')?.textContent
        const nextSpread = spread.value === '180' ? '200' : '180'
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(spread, nextSpread)
        spread.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const after = monitor.getBoundingClientRect()
        const focusedAfter = target.getBoundingClientRect()
        measurements.push({
          index,
          top: after.top,
          bottom: after.bottom,
          height: after.height,
          stickyTop,
          pageScroll: scrollY,
          pageJump: scrollY - scrollBefore,
          focusedVisible:
            focusedAfter.top >= Math.max(0, stacked ? after.bottom : 0) - 1 &&
            focusedAfter.bottom <= innerHeight + 1,
          focusRetained: document.activeElement === target,
          monitorStable: Math.abs(after.top - before.top) <= 2,
          graphicChanged: document.querySelector('.spread-gap-label')?.textContent !== oldLabel,
          horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
        })
      }
      const ladderScroll = document.querySelector('.ladder-scroll')
      const fieldWidths = [...document.querySelectorAll('#controls .field-grid > .field')]
        .filter(element => element.getClientRects().length)
        .map(element => element.getBoundingClientRect().width)
      const quickWidths = [...document.querySelectorAll('#quick-edit .quick-field')]
        .filter(element => element.getClientRects().length)
        .map(element => element.getBoundingClientRect().width)
      const tabletActions = [...document.querySelectorAll(
        '#controls .item-actions button, #controls .section-heading > button, #apply-ladder-import, .export-card button'
      )].filter(element => element.getClientRects().length)
      const actionMetrics = tabletActions.map(element => {
        const rect = element.getBoundingClientRect()
        const owner = element.closest('.control-section, .market-card, .export-card')?.getBoundingClientRect()
        return {
          label: element.textContent.trim(),
          height: rect.height,
          width: rect.width,
          ownerWidth: owner?.width,
          fits: !owner || (rect.left >= owner.left - 1 && rect.right <= owner.right + 1)
        }
      })
      const exportButton = document.querySelector('#copy-export')
      exportButton.scrollIntoView({ block: 'center' })
      await new Promise(resolve => requestAnimationFrame(resolve))
      const exportRect = exportButton.getBoundingClientRect()
      return {
        width: ${width},
        height: ${height},
        expectedColumns: ${expectedColumns},
        stacked,
        cssPosition: monitorCss.position,
        cssMaxHeight: monitorCss.maxHeight,
        monitorHeight: monitor.getBoundingClientRect().height,
        monitorParent: monitor.parentElement?.className,
        domOrderLogical: Boolean(monitor.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING),
        ancestors,
        measurements,
        ladderIndependent: Boolean(ladderScroll) && ['auto', 'scroll'].includes(getComputedStyle(ladderScroll).overflowY),
        monitorBodyIndependent: ['auto', 'scroll'].includes(getComputedStyle(document.querySelector('.monitor-body')).overflowY),
        exportAccessible: exportRect.top >= 0 && exportRect.bottom <= innerHeight && document.elementFromPoint(exportRect.left + 4, exportRect.top + 4)?.closest('#copy-export') === exportButton,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        minimumFieldWidth: Math.min(...fieldWidths),
        minimumQuickWidth: Math.min(...quickWidths),
        minimumActionHeight: Math.min(...actionMetrics.map(metric => metric.height)),
        failingActions: actionMetrics.filter(metric => !metric.fits),
        actionsFit: actionMetrics.every(metric => metric.fits),
        workbenchColumns: getComputedStyle(workbench).gridTemplateColumns
      }
    })()`)
  }
  const stickyMatrix = []
  for (const viewport of [
    { width: 760, height: 500, mobile: false, expectedColumns: 1 },
    { width: 768, height: 500, mobile: false, expectedColumns: 1 },
    { width: 820, height: 500, mobile: false, expectedColumns: 1 },
    { width: 900, height: 500, mobile: false, expectedColumns: 1 },
    { width: 901, height: 600, mobile: false, expectedColumns: 2 },
    { width: 1024, height: 640, mobile: false, expectedColumns: 2 },
    { width: 1440, height: 900, mobile: false, expectedColumns: 2 },
    { width: 390, height: 844, mobile: true, expectedColumns: 1 }
  ])
    stickyMatrix.push(await stickyGeometryAt(viewport))
  assert(
    stickyMatrix.every(
      result =>
        result.cssPosition === 'sticky' &&
        result.stacked === (result.expectedColumns === 1) &&
        result.monitorParent.includes('workbench') &&
        result.domOrderLogical &&
        result.ladderIndependent &&
        result.monitorBodyIndependent &&
        result.documentOverflow === 0 &&
        result.minimumFieldWidth >= 220 &&
        result.minimumQuickWidth >= (result.width <= 900 ? 200 : 160) &&
        (result.width > 900 || result.minimumActionHeight >= 44) &&
        result.actionsFit &&
        (result.width > 900 || result.monitorHeight <= Math.min(result.height * 0.5, 440) + 1) &&
        result.ancestors.every(
          ancestor => !['auto', 'scroll', 'hidden', 'clip'].includes(ancestor.overflowY)
        ) &&
        result.measurements.every(
          measurement =>
            measurement.pageScroll > 0 &&
            (Math.abs(measurement.top - measurement.stickyTop) <= 2 ||
              (measurement.top < measurement.stickyTop && measurement.bottom <= result.height)) &&
            measurement.bottom <= result.height + 1 &&
            measurement.height < result.height &&
            Math.abs(measurement.pageJump) <= 2 &&
            measurement.focusedVisible &&
            measurement.focusRetained &&
            measurement.monitorStable &&
            measurement.graphicChanged &&
            measurement.horizontalOverflow === 0
        ) &&
        result.exportAccessible
    ),
    `sticky tablet boundary geometry failed: ${JSON.stringify(stickyMatrix)}`
  )
  console.log(
    `tablet layout matrix: ${JSON.stringify(
      stickyMatrix.map(result => ({
        viewport: `${result.width}x${result.height}`,
        columns: result.stacked ? 1 : 2,
        overflow: result.documentOverflow,
        monitorHeight: result.monitorHeight,
        minimumFieldWidth: result.minimumFieldWidth,
        minimumQuickWidth: result.minimumQuickWidth,
        minimumActionHeight: result.minimumActionHeight,
        focusRetained: result.measurements.every(measurement => measurement.focusRetained),
        maximumPageJump: Math.max(
          ...result.measurements.map(measurement => Math.abs(measurement.pageJump))
        ),
        graphicChanged: result.measurements.every(measurement => measurement.graphicChanged)
      }))
    )}`
  )

  const captureViewport = async ({ width, height, mobile, path }) => {
    await command('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile
    })
    await evaluate(
      "document.querySelector('.market-card:has([data-field=quotePremiumBps]) [data-field=sizeSkewBps]').scrollIntoView({block:'center'})"
    )
    await new Promise(resolve => setTimeout(resolve, 50))
    const shot = await command('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      fromSurface: true
    })
    await writeFile(path, Buffer.from(shot.data, 'base64'))
  }
  for (const viewport of [
    {
      width: 768,
      height: 500,
      mobile: false,
      path: join(screenshotDirectory, 'sticky-768x500.png')
    },
    {
      width: 900,
      height: 500,
      mobile: false,
      path: join(screenshotDirectory, 'sticky-900x500.png')
    },
    {
      width: 1440,
      height: 900,
      mobile: false,
      path: join(screenshotDirectory, 'sticky-1440x900.png')
    },
    {
      width: 1024,
      height: 768,
      mobile: false,
      path: join(screenshotDirectory, 'sticky-1024x768.png')
    },
    {
      width: 390,
      height: 844,
      mobile: true,
      path: join(screenshotDirectory, 'sticky-390x844.png')
    }
  ])
    await captureViewport(viewport)

  await command('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await captureImportViewport(
    join(screenshotDirectory, 'quick-edit-desktop.png'),
    '#quick-edit',
    'center'
  )
  await command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true
  })
  await captureImportViewport(
    join(screenshotDirectory, 'quick-edit-mobile.png'),
    '#quick-edit',
    'center'
  )
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluate('scrollTo(0, 0)')
  const screenshotClip = async () =>
    evaluate(
      "(() => { const r=document.querySelector('.monitor-surface').getBoundingClientRect(); return {x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height,scale:1} })()"
    )
  const capture = async path => {
    const shot = await command('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: await screenshotClip()
    })
    await writeFile(path, Buffer.from(shot.data, 'base64'))
  }
  await capture(join(screenshotDirectory, 'ladder-default-desktop.png'))

  const parameterProof = await evaluate(`(() => {
    const result = {}
    const input = field => document.querySelector(\`.market-card:has([data-field=quotePremiumBps]) [data-field=\${field}]\`)
    const set = (field, value) => {
      const element = input(field)
      const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
      if (element instanceof HTMLSelectElement) element.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const callout = field => document.querySelector(\`[data-parameter~=\${field}].ladder-callout dd\`)?.textContent ?? ''
    set('minimumRateBps', '0')
    set('maximumRateBps', '2000')
    const allowlist = document.querySelector('[data-field=MARKET_IDS]')
    const secondMarket = '0x' + '6'.repeat(64)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(allowlist, allowlist.value + ',' + secondMarket)
    allowlist.dispatchEvent(new Event('input', { bubbles: true }))
    set('marketId', secondMarket)
    result.marketId = document.querySelector('.ladder-heading code')?.textContent.includes(secondMarket)
    set('marketId', '0x' + '5'.repeat(64))

    set('quotePremiumBps', '25')
    result.quotePremiumBps = document.querySelector('.center-label')?.textContent === 'CENTER 525'
    set('quotePremiumBps', '0')
    set('spreadBps', '220')
    result.spreadBps = document.querySelector('.spread-gap-label')?.textContent === 'SPREAD GAP · 220 BPS'
    set('spreadBps', '200')
    set('stepBps', '110')
    result.stepBps = [...document.querySelectorAll('.ladder-rung[data-side=higher]')].some(rung => rung.dataset.rateBps === '710')
    set('stepBps', '100')
    set('rungCount', '4')
    result.rungCount = document.querySelectorAll('.ladder-rung').length === 8
    set('rungCount', '3')
    const equalWidths = [...document.querySelectorAll('.ladder-rung')].map(rung => rung.getAttribute('width')).join('|')
    set('sizeSkewBps', '1000')
    result.sizeSkewBps = [...document.querySelectorAll('.ladder-rung')].map(rung => rung.getAttribute('width')).join('|') !== equalWidths
    set('sizeSkewBps', '0')
    const lowerAssets = document.querySelector('.ladder-rung[data-side=lower]')?.dataset.allocationAssets
    set('lowerRateBudgetAssets', '9000000000')
    result.lowerRateBudgetAssets = document.querySelector('.ladder-rung[data-side=lower]')?.dataset.allocationAssets !== lowerAssets
    set('lowerRateBudgetAssets', '10000000000')
    const higherAssets = document.querySelector('.ladder-rung[data-side=higher]')?.dataset.allocationAssets
    set('higherRateBudgetAssets', '9000000000')
    result.higherRateBudgetAssets = document.querySelector('.ladder-rung[data-side=higher]')?.dataset.allocationAssets !== higherAssets
    set('higherRateBudgetAssets', '10000000000')
    set('targetMarketExposureAssets', '9000000000')
    result.targetMarketExposureAssets = document.querySelector('.ladder-rung[data-side=higher]')?.dataset.allocationAssets !== higherAssets
    set('targetMarketExposureAssets', '20000000000')
    const beforeMaximumTotalExposureAssets = [...document.querySelectorAll('.ladder-rung')].map(rung => rung.dataset.allocationAssets).join('|')
    set('maximumTotalExposureAssets', '25000000000')
    result.maximumTotalExposureAssets = [...document.querySelectorAll('.ladder-rung')].map(rung => rung.dataset.allocationAssets).join('|') === beforeMaximumTotalExposureAssets && callout('maximumTotalExposureAssets') === '20000000000 target (static binding cap) · 25000000000 configured total ceiling; current aggregate exposure and live capacity excluded'
    set('maximumTotalExposureAssets', '30000000000')
    set('minimumOfferAssets', '4000000000')
    result.minimumOfferAssets = document.querySelectorAll('.ladder-rung').length < 6
    set('minimumOfferAssets', '101000000')
    const sharedCapWidths = [...document.querySelectorAll('.offer-cap-bar')].map(rung => rung.getAttribute('width')).join('|')
    set('groupMode', 'per-book')
    const perBookCaps = [...document.querySelectorAll('.offer-cap-bar')]
    result.groupMode = callout('groupMode').includes('side-wide shared offer maxAssets caps') && callout('groupMode').includes('Reduce-only: 10,000,000,000') && callout('groupMode').includes('Lend: 10,000,000,000') && perBookCaps.map(rung => rung.getAttribute('width')).join('|') !== sharedCapWidths && perBookCaps.every(rung => rung.dataset.offerMaxAssets === '10000000000') && perBookCaps.map(rung => rung.dataset.allocationAssets).join('|') === '3333333334|3333333333|3333333333|3333333333|3333333333|3333333334' && [...document.querySelectorAll('.rung-table tbody tr')].every(row => row.cells[2]?.textContent && row.cells[3]?.textContent === '10000000000')
    set('groupMode', 'shared-rung')
    set('loopIntervalSeconds', '30')
    result.loopIntervalSeconds = callout('loopIntervalSeconds').includes('30s configured interval') && callout('loopIntervalSeconds').includes('30s effective runtime cycle')
    set('loopIntervalSeconds', '60')
    set('movementToleranceBps', '20')
    result.movementToleranceBps = callout('movementToleranceBps').includes('20 BPS informational deadband against retained active center') && callout('movementToleranceBps').includes('fresh stateless center unchanged')
    set('movementToleranceBps', '10')
    set('minimumRateBps', '50')
    result.minimumRateBps = [...document.querySelectorAll('.axis-label')].some(label => label.textContent === 'MIN 50 BPS')
    set('minimumRateBps', '0')
    set('maximumRateBps', '1950')
    result.maximumRateBps = [...document.querySelectorAll('.axis-label')].some(label => label.textContent === 'MAX 1950 BPS')
    set('maximumRateBps', '2000')
    const reference = document.querySelector('#preview-reference')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(reference, '510')
    reference.dispatchEvent(new Event('input', { bubbles: true }))
    result.referenceRateBps = document.querySelector('.reference-label')?.textContent === 'REFERENCE 510'
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(reference, '500')
    reference.dispatchEvent(new Event('input', { bubbles: true }))
    return result
  })()`)
  const failedParameters = Object.entries(parameterProof)
    .filter(([, passed]) => !passed)
    .map(([field]) => field)
  assert(
    failedParameters.length === 0,
    `parameter render proof failed: ${failedParameters.join(', ')}`
  )
  assert(
    Object.keys(parameterProof).length === 17,
    'parameter proof did not cover all 16 ladder fields plus reference rate'
  )

  const quickEditSyncProof = await evaluate(`(() => {
    const values = {
      marketId: '0x' + '6'.repeat(64),
      quotePremiumBps: '15',
      spreadBps: '220',
      stepBps: '110',
      rungCount: '4',
      sizeSkewBps: '100',
      minimumOfferAssets: '100000000',
      lowerRateBudgetAssets: '9000000000',
      higherRateBudgetAssets: '8000000000',
      targetMarketExposureAssets: '15000000000',
      maximumTotalExposureAssets: '25000000000',
      groupMode: 'per-book',
      loopIntervalSeconds: '45',
      movementToleranceBps: '12',
      minimumRateBps: '0',
      maximumRateBps: '1200'
    }
    const cards = () => [...document.querySelectorAll('.market-card:has([data-field=quotePremiumBps])')]
    const full = key => cards()[0].querySelector('[data-field=' + key + ']')
    const quick = key => document.querySelector('[data-quick-field=' + key + ']')
    const set = (element, value) => {
      const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
      if (element instanceof HTMLSelectElement) element.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const quickToFull = {}
    for (const [key, value] of Object.entries(values)) {
      set(quick(key), value)
      quickToFull[key] = full(key).value === value
    }
    set(quick('referenceRateBps'), '510')
    quickToFull.referenceRateBps = document.querySelector('.reference-label')?.textContent === 'REFERENCE 510'
    quickToFull.marketSwitcherIdentity = document
      .querySelector('#quick-market-select')
      .selectedOptions[0].textContent.includes('0x66666666')
    const quickExport = [
      document.querySelector('#export-yaml').value,
      document.querySelector('#export-shell').value,
      document.querySelector('#export-json').value,
      document.querySelector('#export-ladder-env').value
    ]
    const ladderExport = JSON.parse(quickExport[3])[0]
    const exportEquality = Object.entries(values).every(([key, value]) => ladderExport[key] === value) &&
      JSON.parse(quickExport[2]).configuration.LADDER_MARKETS[0].quotePremiumBps === '15' &&
      quickExport.slice(0, 3).every(payload => payload.includes('15'))

    const reverseValues = { ...values, quotePremiumBps: '16', spreadBps: '240', stepBps: '120' }
    const fullToQuick = {}
    for (const [key, value] of Object.entries(reverseValues)) {
      set(full(key), value)
      fullToQuick[key] = quick(key).value === value
    }
    set(quick('quotePremiumBps'), '17')
    const viaQuick = [...document.querySelectorAll('#export-yaml,#export-shell,#export-json,#export-ladder-env')].map(output => output.value)
    set(full('quotePremiumBps'), '16')
    set(full('quotePremiumBps'), '17')
    const viaFull = [...document.querySelectorAll('#export-yaml,#export-shell,#export-json,#export-ladder-env')].map(output => output.value)
    return {
      quickToFull,
      fullToQuick,
      exportEquality,
      exactSameStateExports: JSON.stringify(viaQuick) === JSON.stringify(viaFull),
      graphicAndCallouts: document.querySelector('.center-label')?.textContent === 'CENTER 527' &&
        document.querySelector('.spread-gap-label')?.textContent === 'SPREAD GAP · 240 BPS' &&
        document.querySelectorAll('.ladder-rung').length === 8 &&
        document.querySelector('[data-parameter~=groupMode].ladder-callout dd')?.textContent.includes('per-book')
    }
  })()`)
  assert(
    Object.values(quickEditSyncProof.quickToFull).every(Boolean) &&
      Object.values(quickEditSyncProof.fullToQuick).every(Boolean) &&
      quickEditSyncProof.exportEquality &&
      quickEditSyncProof.exactSameStateExports &&
      quickEditSyncProof.graphicAndCallouts,
    `quick/full two-way synchronization failed: ${JSON.stringify(quickEditSyncProof)}`
  )

  const quickFocusProof = await evaluate(`(() => {
    const input = document.querySelector('[data-quick-field=spreadBps]')
    input.closest('details').open = true
    input.scrollIntoView({ block: 'center' })
    input.focus({ preventScroll: true })
    const sameNode = input
    const pageBefore = scrollY
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '')
    input.setSelectionRange(0, 0)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const invalid = document.activeElement === sameNode &&
      input.getAttribute('aria-invalid') === 'true' &&
      document.querySelector('#quick-error-spreadBps').textContent.length > 0 &&
      document.querySelector('.ladder-invalid[role=img]') &&
      !document.querySelector('#validation-errors').hidden
    const carets = []
    for (const character of '240') {
      input.setRangeText(character, input.selectionStart, input.selectionEnd, 'end')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      carets.push({
        focused: document.activeElement === sameNode,
        caret: input.selectionStart,
        value: input.value,
        sameNode: document.querySelector('[data-quick-field=spreadBps]') === sameNode
      })
    }
    return {
      invalid: Boolean(invalid),
      recovered: input.getAttribute('aria-invalid') === 'false' &&
        document.querySelector('#validation-errors').hidden &&
        document.querySelector('#ladder-status').dataset.status === 'ok',
      carets,
      noPageJump: Math.abs(scrollY - pageBefore) <= 2
    }
  })()`)
  assert(
    quickFocusProof.invalid &&
      quickFocusProof.recovered &&
      quickFocusProof.noPageJump &&
      quickFocusProof.carets.every(
        (entry, index) =>
          entry.focused &&
          entry.sameNode &&
          entry.caret === index + 1 &&
          entry.value === '240'.slice(0, index + 1)
      ),
    `quick edit focus/caret or invalid recovery failed: ${JSON.stringify(quickFocusProof)}`
  )
  await evaluate(`(() => {
    const values = {
      marketId: '0x' + '5'.repeat(64), quotePremiumBps: '0', spreadBps: '200', stepBps: '100',
      rungCount: '3', sizeSkewBps: '0', lowerRateBudgetAssets: '10000000000',
      higherRateBudgetAssets: '10000000000', targetMarketExposureAssets: '20000000000',
      maximumTotalExposureAssets: '30000000000', minimumOfferAssets: '101000000',
      groupMode: 'shared-rung', loopIntervalSeconds: '60', movementToleranceBps: '10',
      minimumRateBps: '200', maximumRateBps: '800'
    }
    const card = document.querySelector('.market-card:has([data-field=quotePremiumBps])')
    for (const [key, value] of Object.entries(values)) {
      const input = card.querySelector('[data-field=' + key + ']')
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const reference = document.querySelector('#preview-reference')
    reference.value = '500'
    reference.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)

  const hugeGeometryProof = await evaluate(`(() => {
    const input = field => document.querySelector(\`.market-card:has([data-field=quotePremiumBps]) [data-field=\${field}]\`)
    const set = (field, value) => { const element=input(field); const prototype=element instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,String(value)); element.dispatchEvent(new Event('input',{bubbles:true})) }
    const results = []
    for (const power of [100, 308, 309, 400]) {
      const unit = BigInt('1' + '0'.repeat(power))
      set('minimumRateBps', '0')
      set('maximumRateBps', String(unit * 8n))
      set('spreadBps', String(unit * 2n))
      set('stepBps', String(unit))
      const reference=document.querySelector('#preview-reference'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(reference,String(unit * 4n)); reference.dispatchEvent(new Event('input',{bubbles:true}))
      const svg=document.querySelector('.ladder-scroll svg')
      const numericAttributes=[...document.querySelectorAll('.ladder-market [x],[y],[width],[height],[cx],[cy],[r]')].flatMap(element => ['x','y','width','height','cx','cy','r'].flatMap(name => element.hasAttribute(name) ? [Number(element.getAttribute(name))] : []))
      results.push({
        power,
        valid:document.querySelector('#ladder-status').dataset.status==='ok',
        bounded:Number(svg?.getAttribute('height')) <= 32832 && document.querySelector('.ladder-scroll').clientHeight <= 900,
        finite:numericAttributes.every(Number.isFinite),
        noInvalidTokens:!document.querySelector('.ladder-market').innerHTML.match(/NaN|Infinity/)
      })
    }
    set('maximumRateBps', '1' + '0'.repeat(400)); set('spreadBps', '2'); set('stepBps', '1')
    const practicalReference=document.querySelector('#preview-reference'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(practicalReference,'4'); practicalReference.dispatchEvent(new Event('input',{bubbles:true}))
    const practicalInvalid = document.querySelector('.ladder-invalid[role=img]')?.getAttribute('aria-label')?.includes('32768px practical plot-height limit') && document.querySelector('#ladder-status').dataset.status==='error' && document.querySelector('#validation-errors').hidden && !document.querySelector('#copy-export').disabled && [...document.querySelectorAll('#export-yaml,#export-shell,#export-json')].every(output => output.dataset.invalid==='false' && !output.value.match(/NaN|Infinity/))
    set('spreadBps', '200'); set('stepBps', '100'); set('minimumRateBps', '200'); set('maximumRateBps', '800')
    const reference=document.querySelector('#preview-reference'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(reference,'500'); reference.dispatchEvent(new Event('input',{bubbles:true}))
    return { results, practicalInvalid }
  })()`)
  assert(
    hugeGeometryProof.practicalInvalid &&
      hugeGeometryProof.results.every(
        result => result.valid && result.bounded && result.finite && result.noInvalidTokens
      ),
    `huge bigint browser geometry failed: ${JSON.stringify(hugeGeometryProof)}`
  )
  await evaluate(`(() => {
    const input = field => document.querySelector(\`.market-card:has([data-field=quotePremiumBps]) [data-field=\${field}]\`)
    const set = (field, value) => { const element=input(field); const prototype=element instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,String(value)); element.dispatchEvent(new Event('input',{bubbles:true})) }
    set('minimumRateBps', '200')
    set('maximumRateBps', '800')
    set('groupMode', 'per-book')
  })()`)
  await capture(join(screenshotDirectory, 'perbook-default-desktop.png'))

  const configureDensity = async rungCount =>
    evaluate(`(() => {
      const input = field => document.querySelector(\`.market-card:has([data-field=quotePremiumBps]) [data-field=\${field}]\`)
      const set = (field, value) => { const element=input(field); const prototype=element instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype,'value').set.call(element,String(value)); element.dispatchEvent(new Event('input',{bubbles:true})) }
      set('rungCount', '${rungCount}')
      set('minimumOfferAssets', '1')
      set('minimumRateBps', '0')
      set('maximumRateBps', '${rungCount * 200 + 400}')
      const reference=document.querySelector('#preview-reference'); reference.value='${rungCount * 100 + 200}'; reference.dispatchEvent(new Event('input',{bubbles:true}))
    })()`)
  const densityMetrics = () =>
    evaluate(`(() => {
      const rungs=[...document.querySelectorAll('.ladder-rung')]
      const boxes=rungs.map(rung=>{const rect=rung.getBoundingClientRect();return {side:rung.dataset.side, top:rect.top+rect.height/2}}).sort((a,b)=>a.top-b.top)
      const gaps=boxes.slice(1).map((box,index)=>box.top-boxes[index].top)
      const center=document.querySelector('.center-line').getBoundingClientRect().top
      const higher=boxes.filter(box=>box.side==='higher').at(-1).top
      const lower=boxes.find(box=>box.side==='lower').top
      const scroll=document.querySelector('.ladder-scroll')
      return {
        rungs:rungs.length,
        tableRows:document.querySelectorAll('.rung-table tbody tr').length,
        minGap:Math.min(...gaps),
        higherCenterGap:center-higher,
        lowerCenterGap:lower-center,
        minimumLabelPx:Math.min(...[...document.querySelectorAll('.ladder-market *')].filter(element => {
          const style=getComputedStyle(element)
          if (style.display==='none' || style.visibility==='hidden') return false
          return [...element.childNodes].some(node => node.nodeType===Node.TEXT_NODE && node.textContent.trim())
        }).map(element=>parseFloat(getComputedStyle(element).fontSize))),
        viewportHeight:scroll.clientHeight,
        contentHeight:scroll.scrollHeight,
        svgWidth:document.querySelector('.ladder-scroll svg').getBoundingClientRect().width,
        equalGeometryPairs:[...document.querySelectorAll('.rung-group')].filter(group => {
          const offer=group.querySelector('.offer-cap-bar'); const allocation=group.querySelector('.allocation-bar')
          return offer?.dataset.offerMaxAssets === allocation?.dataset.allocationAssets && offer.getAttribute('x') === allocation.getAttribute('x') && offer.getAttribute('width') === allocation.getAttribute('width')
        }).length,
        nestedGeometryPairs:[...document.querySelectorAll('.rung-group')].filter(group => {
          const offer=group.querySelector('.offer-cap-bar'); const allocation=group.querySelector('.allocation-bar')
          return Number(allocation?.getAttribute('x')) >= Number(offer?.getAttribute('x')) && Number(allocation?.getAttribute('x')) + Number(allocation?.getAttribute('width')) < Number(offer?.getAttribute('x')) + Number(offer?.getAttribute('width'))
        }).length
      }
    })()`)

  await configureDensity(32)
  const density32Desktop = await densityMetrics()
  assert(
    density32Desktop.rungs === 64 && density32Desktop.tableRows === 64,
    '32-rung configuration did not render/enumerate all 64 rungs'
  )
  assert(
    density32Desktop.minGap >= 28 &&
      density32Desktop.higherCenterGap >= 28 &&
      density32Desktop.lowerCenterGap >= 28,
    `32-rung desktop spacing is unreadable: ${JSON.stringify(density32Desktop)}`
  )
  assert(density32Desktop.minimumLabelPx >= 11, '32-rung labels are smaller than 11px')
  await capture(join(screenshotDirectory, 'ladder-32-desktop.png'))

  await command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true
  })
  const density32Mobile = await densityMetrics()
  const mobileLayout = await evaluate(`(() => {
    document.querySelectorAll('.quick-group').forEach(group => { group.open = true })
    const quickControls = [...document.querySelectorAll('#quick-edit input,#quick-edit select,#quick-edit summary')]
    const monitor = document.querySelector('.monitor-surface')
    const monitorBody = document.querySelector('.monitor-body')
    return {
      documentWidth: document.documentElement.scrollWidth,
      scrollWidth: document.querySelector('.ladder-scroll').clientWidth,
      quickTouchMinimum: Math.min(...quickControls.map(control => control.getBoundingClientRect().height)),
      quickWithinViewport: [...document.querySelectorAll('#quick-edit *')].every(element => {
        const rect = element.getBoundingClientRect()
        return rect.width === 0 || (rect.left >= -0.5 && rect.right <= 390.5)
      }),
      monitorBounded: monitor.getBoundingClientRect().height <= innerHeight &&
        ['auto', 'scroll'].includes(getComputedStyle(monitorBody).overflowY) &&
        monitorBody.scrollHeight > monitorBody.clientHeight,
      overflow: [...document.querySelectorAll('body *')].filter(element => {
        if (element.closest('.ladder-scroll')) return false
        const rect = element.getBoundingClientRect()
        return rect.right > 390.5 || rect.left < -0.5
      }).slice(0, 20).map(element => ({ tag: element.tagName, className: String(element.className), position: getComputedStyle(element).position, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }))
    }
  })()`)
  assert(
    mobileLayout.documentWidth <= 390 &&
      mobileLayout.scrollWidth <= 358 &&
      mobileLayout.quickTouchMinimum >= 44 &&
      mobileLayout.quickWithinViewport &&
      mobileLayout.monitorBounded &&
      mobileLayout.overflow.length === 0,
    `mobile layout overflows its viewport or quick controls are unusable: ${JSON.stringify(mobileLayout)}`
  )
  assert(
    density32Mobile.minGap >= 28 &&
      density32Mobile.minimumLabelPx >= 11 &&
      density32Mobile.svgWidth >= 1120,
    `32-rung mobile density is unreadable: ${JSON.stringify(density32Mobile)}`
  )

  await evaluate(
    `(() => { const input=document.querySelector('.market-card:has([data-field=quotePremiumBps]) [data-field=groupMode]'); input.value='shared-rung'; input.dispatchEvent(new Event('input',{bubbles:true})) })()`
  )
  await configureDensity(512)
  const density512Mobile = await densityMetrics()
  assert(
    density512Mobile.rungs === 1024 && density512Mobile.tableRows === 1024,
    '512-rung configuration did not render/enumerate all 1024 rungs'
  )
  assert(
    density512Mobile.minGap >= 28 &&
      density512Mobile.higherCenterGap >= 28 &&
      density512Mobile.lowerCenterGap >= 28,
    `512-rung spacing is unreadable: ${JSON.stringify(density512Mobile)}`
  )
  assert(
    density512Mobile.minimumLabelPx >= 11 &&
      density512Mobile.viewportHeight <= 900 &&
      density512Mobile.contentHeight > density512Mobile.viewportHeight &&
      density512Mobile.equalGeometryPairs === 1024,
    '512-rung chart is not bounded/readable or shared-rung pairs do not have exact equal geometry'
  )
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false
  })
  const density512Desktop = await densityMetrics()
  assert(
    density512Desktop.rungs === 1024 &&
      density512Desktop.minGap >= 28 &&
      density512Desktop.minimumLabelPx >= 11 &&
      density512Desktop.equalGeometryPairs === 1024,
    `512-rung desktop density or shared-rung geometry is incorrect: ${JSON.stringify(density512Desktop)}`
  )
  const shared512ConfigurationExports = await evaluate(
    "[...document.querySelectorAll('#export-yaml,#export-shell,#export-json,#export-ladder-env')].map(output => output.value)"
  )
  await evaluate(
    `(() => { const input=document.querySelector('.market-card:has([data-field=quotePremiumBps]) [data-field=groupMode]'); input.value='per-book'; input.dispatchEvent(new Event('input',{bubbles:true})) })()`
  )
  const density512PerBook = await densityMetrics()
  assert(
    density512PerBook.rungs === 1024 && density512PerBook.nestedGeometryPairs === 1024,
    `512-rung per-book allocations are not nested inside side caps: ${JSON.stringify(density512PerBook)}`
  )
  await evaluate(
    `(() => { const input=document.querySelector('.market-card:has([data-field=quotePremiumBps]) [data-field=groupMode]'); input.value='shared-rung'; input.dispatchEvent(new Event('input',{bubbles:true})) })()`
  )
  const shared512ConfigurationExportsAfterRoundTrip = await evaluate(
    "[...document.querySelectorAll('#export-yaml,#export-shell,#export-json,#export-ladder-env')].map(output => output.value)"
  )
  assert(
    JSON.stringify(shared512ConfigurationExportsAfterRoundTrip) ===
      JSON.stringify(shared512ConfigurationExports),
    '512-rung graphic and accessibility checks changed configuration export bytes'
  )

  await command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true
  })
  await configureDensity(3)
  await evaluate(`(() => {
    const input = field => document.querySelector(\`.market-card:has([data-field=quotePremiumBps]) [data-field=\${field}]\`)
    const set=(field,value)=>{const element=input(field);element.value=value;element.dispatchEvent(new Event('input',{bubbles:true}))}
    set('minimumOfferAssets','101000000'); set('minimumRateBps','200'); set('maximumRateBps','800'); set('groupMode','shared-rung')
    const reference=document.querySelector('#preview-reference');reference.value='500';reference.dispatchEvent(new Event('input',{bubbles:true}))
  })()`)
  assert(
    await evaluate(
      "[...document.querySelectorAll('.offer-cap-bar')].every(rung => rung.dataset.offerMaxAssets === rung.dataset.allocationAssets)"
    ),
    'shared-rung mobile screenshot state does not preserve per-rung maxAssets semantics'
  )
  await capture(join(screenshotDirectory, 'ladder-default-mobile.png'))
  await evaluate(
    `(() => { const input=document.querySelector('.market-card:has([data-field=quotePremiumBps]) [data-field=groupMode]'); input.value='per-book'; input.dispatchEvent(new Event('input',{bubbles:true})) })()`
  )
  assert(
    await evaluate(
      "[...document.querySelectorAll('.offer-cap-bar')].every(rung => rung.dataset.offerMaxAssets === '10000000000')"
    ),
    'per-book mobile screenshot state does not preserve side-wide maxAssets semantics'
  )
  await capture(join(screenshotDirectory, 'perbook-default-mobile.png'))
  await command('Emulation.clearDeviceMetricsOverride')
  console.log(
    `density 32 desktop/mobile: ${JSON.stringify({ desktop: density32Desktop, mobile: density32Mobile })}`
  )
  console.log(
    `density 512 desktop/mobile/per-book: ${JSON.stringify({ desktop: density512Desktop, mobile: density512Mobile, perBook: density512PerBook })}`
  )
  console.log(
    `mobile overflow: ${JSON.stringify({ elements: mobileLayout.overflow, documentWidth: mobileLayout.documentWidth, viewportWidth: 390 })}`
  )
  await command('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  })
  assert(
    await evaluate(
      "getComputedStyle(document.querySelector('.rung-group')).animationName === 'none' && getComputedStyle(document.querySelector('.ladder-rung')).transitionDuration === '0s'"
    ),
    'reduced-motion preference did not disable ladder animation and transitions'
  )
  await command('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
  })
  assert(
    await evaluate(
      "[...document.querySelectorAll('[role=tab]')].every((tab, index) => Boolean(tab.getAttribute('aria-controls')) && tab.tabIndex === (index === 0 ? 0 : -1))"
    ),
    'tabs do not have aria-controls and roving tabindex'
  )
  await evaluate(
    "document.querySelector('#tab-yaml').focus(); document.querySelector('#tab-yaml').dispatchEvent(new KeyboardEvent('keydown', {key:'End', bubbles:true}))"
  )
  assert(
    await evaluate(
      "document.activeElement.id === 'tab-ladder-env' && document.querySelector('#tab-ladder-env').getAttribute('aria-selected') === 'true' && !document.querySelector('#panel-ladder-env').hidden && document.querySelector('#panel-yaml').hidden"
    ),
    'End key did not activate the final tab and hide inactive panels'
  )
  await evaluate(
    "document.querySelector('#tab-ladder-env').dispatchEvent(new KeyboardEvent('keydown', {key:'Home', bubbles:true}))"
  )
  assert(
    await evaluate("document.activeElement.id === 'tab-yaml'"),
    'Home key did not activate the first tab'
  )

  await evaluate(`(() => {
    const values = {
      MAKER_PRIVATE_KEY: '0x' + '9'.repeat(64),
      BETTERSTACK_SOURCE_TOKEN: 'browser-secret-source-token',
      RPC_URL: 'https://rpc-user:rpc-password@rpc.example.test/path?api_key=query-secret#fragment',
      REFERENCE_RPC_URL: 'https://archive-user:archive-password@archive.example.test/path?token=archive-secret',
      BETTERSTACK_HEARTBEAT_URL: 'https://heartbeat-user:heartbeat-password@heartbeat.example.test/credential-path?token=heartbeat-query-secret#heartbeat-fragment-secret'
    }
    const set = (field, value) => {
      const input = document.querySelector(\`[data-field=\${field}]\`)
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    for (const [field, value] of Object.entries(values)) set(field, value)
    set('BETTERSTACK_INGESTING_HOST', 'logs.example.test')
    document.querySelector('#tab-json').click()
  })()`)
  const proveCredentialState = async includeSensitive =>
    evaluate(`(async () => {
      const values = {
        MAKER_PRIVATE_KEY: '0x' + '9'.repeat(64),
        BETTERSTACK_SOURCE_TOKEN: 'browser-secret-source-token',
        RPC_URL: 'https://rpc-user:rpc-password@rpc.example.test/path?api_key=query-secret#fragment',
        REFERENCE_RPC_URL: 'https://archive-user:archive-password@archive.example.test/path?token=archive-secret',
        BETTERSTACK_HEARTBEAT_URL: 'https://heartbeat-user:heartbeat-password@heartbeat.example.test/credential-path?token=heartbeat-query-secret#heartbeat-fragment-secret'
      }
      const toggle = document.querySelector('#include-sensitive-values')
      const setToggle = checked => { if (toggle.checked !== checked) toggle.click() }
      setToggle(${!includeSensitive})
      setToggle(${includeSensitive})
      document.querySelector('#tab-json').click()
      let copied = ''
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async value => { copied = value } },
        configurable: true
      })
      document.querySelector('#copy-export').click()
      await new Promise(resolve => setTimeout(resolve, 0))
      const yaml = document.querySelector('#export-yaml').value
      const shell = document.querySelector('#export-shell').value
      const jsonText = document.querySelector('#export-json').value
      const json = JSON.parse(jsonText)
      const fields = Object.keys(values)
      const expectedType = ${includeSensitive} ? 'text' : 'password'
      const controls = fields.every(field => {
        const input = document.querySelector(\`[data-field=\${field}]\`)
        return input?.type === expectedType && input.value === values[field]
      })
      for (const field of fields) {
        const input = document.querySelector(\`[data-field=\${field}]\`)
        input.scrollLeft = 0
        input.setSelectionRange(0, 0)
      }
      for (const output of document.querySelectorAll('#export-yaml,#export-shell,#export-json')) {
        output.scrollTop = 0
        output.scrollLeft = 0
        output.setSelectionRange(0, 0)
      }
      const focusAnchor = document.querySelector('h1')
      focusAnchor.tabIndex = -1
      focusAnchor.focus({ preventScroll: true })
      const yamlSensitive = [values.MAKER_PRIVATE_KEY, values.RPC_URL, values.REFERENCE_RPC_URL]
      const yamlCorrect = ${includeSensitive}
        ? yamlSensitive.every(value => yaml.includes(value)) &&
          !yaml.includes(values.BETTERSTACK_SOURCE_TOKEN) &&
          !yaml.includes(values.BETTERSTACK_HEARTBEAT_URL)
        : yamlSensitive.every(value => !yaml.includes(value)) && yaml.includes('<redacted>')
      const allSensitive = Object.values(values)
      const shellAndJsonCorrect = ${includeSensitive}
        ? allSensitive.every(value => shell.includes(value) && jsonText.includes(value))
        : allSensitive.every(value => !shell.includes(value) && !jsonText.includes(value)) &&
          shell.includes('<redacted>') && jsonText.includes('<redacted>')
      const structuredValues = {
        MAKER_PRIVATE_KEY: json.configuration.MAKER_PRIVATE_KEY,
        RPC_URL: json.configuration.RPC_URL,
        REFERENCE_RPC_URL: json.configuration.REFERENCE_RPC_URL,
        BETTERSTACK_SOURCE_TOKEN: json.observability.BETTERSTACK_SOURCE_TOKEN,
        BETTERSTACK_HEARTBEAT_URL: json.observability.BETTERSTACK_HEARTBEAT_URL
      }
      const structuredCorrect = fields.every(field =>
        structuredValues[field] === (${includeSensitive} ? values[field] : '<redacted>')
      )
      const noPeripheralLeak = ![...document.querySelectorAll('.ladder-market *,#observability-status *,#ladder-status')]
        .some(element =>
          (element.textContent && allSensitive.some(value => element.textContent.includes(value))) ||
          [...element.attributes].some(attribute => allSensitive.some(value => attribute.value.includes(value)))
        )
      return {
        activeJson: document.querySelector('#tab-json').getAttribute('aria-selected') === 'true' &&
          !document.querySelector('#panel-json').hidden,
        clipboardExact: copied === jsonText,
        clipboardSensitive: ${includeSensitive}
          ? allSensitive.every(value => copied.includes(value))
          : allSensitive.every(value => !copied.includes(value)) && copied.includes('<redacted>'),
        controls,
        noPeripheralLeak,
        shellAndJsonCorrect,
        structuredCorrect,
        toggle: toggle.checked === ${includeSensitive},
        yamlCorrect
      }
    })()`)
  const credentialClip = await evaluate(`(() => {
    const targets = [
      document.querySelector('.sensitive-export-control'),
      document.querySelector('#panel-json')
    ].filter(Boolean)
    const rects = targets.map(target => target.getBoundingClientRect())
    const padding = 12
    const left = Math.max(0, Math.min(...rects.map(rect => rect.left + scrollX)) - padding)
    const top = Math.max(0, Math.min(...rects.map(rect => rect.top + scrollY)) - padding)
    const right = Math.max(...rects.map(rect => rect.right + scrollX)) + padding
    const bottom = Math.max(...rects.map(rect => rect.bottom + scrollY)) + padding
    return { x: left, y: top, width: right - left, height: bottom - top, scale: 1 }
  })()`)
  const captureCredentialState = async (label, includeSensitive) => {
    const proof = await proveCredentialState(includeSensitive)
    assert(
      Object.values(proof).every(Boolean),
      `credential ${label} DOM/clipboard proof failed: ${JSON.stringify(proof)}`
    )
    const path = join(screenshotDirectory, `credentials-${label}.png`)
    let previous
    for (let attempt = 0; attempt < 5; attempt++) {
      await evaluate(
        'document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))'
      )
      const shot = await command('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true,
        fromSurface: true,
        clip: credentialClip
      })
      const bytes = Buffer.from(shot.data, 'base64')
      const hash = createHash('sha256').update(bytes).digest('hex')
      if (hash === previous?.hash) {
        await writeFile(path, bytes)
        return { hash, path }
      }
      previous = { bytes, hash }
    }
    throw new Error(`credential ${label} screenshot did not reach a stable pixel hash`)
  }
  const credentialWarmup = await proveCredentialState(true)
  assert(
    Object.values(credentialWarmup).every(Boolean),
    `credential screenshot state warmup failed: ${JSON.stringify(credentialWarmup)}`
  )
  const credentialScreenshots = {
    default: await captureCredentialState('default-redacted', false),
    optIn: await captureCredentialState('opt-in-revealed', true),
    optOut: await captureCredentialState('opt-out-redacted', false)
  }
  assert(
    credentialScreenshots.default.hash === credentialScreenshots.optOut.hash &&
      credentialScreenshots.optIn.hash !== credentialScreenshots.default.hash,
    `credential screenshot pixel hashes are incorrect: ${JSON.stringify({
      default: credentialScreenshots.default.hash,
      optIn: credentialScreenshots.optIn.hash,
      optOut: credentialScreenshots.optOut.hash
    })}`
  )
  console.log(
    `credential screenshot hashes: ${JSON.stringify({
      default: credentialScreenshots.default.hash,
      optIn: credentialScreenshots.optIn.hash,
      optOut: credentialScreenshots.optOut.hash
    })}`
  )
  await evaluate(`(() => {
    const set = (field, value) => {
      const input = document.querySelector(\`[data-field=\${field}]\`)
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set('MAKER_PRIVATE_KEY', '0x' + 'a'.repeat(64))
    set('BETTERSTACK_SOURCE_TOKEN', '')
    set('BETTERSTACK_INGESTING_HOST', '')
    set('BETTERSTACK_HEARTBEAT_URL', '')
    set('RPC_URL', 'https://base-rpc.example')
    set('REFERENCE_RPC_URL', 'https://base-archive-rpc.example')
  })()`)

  const previewIsolationProof = await evaluate(`(async () => {
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const copied = []
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { copied.push(value) } }, configurable: true })
    const reference = document.querySelector('#preview-reference')
    const exportBaseline = [...document.querySelectorAll('#export-yaml,#export-shell,#export-json')].map(output => output.value)
    const baselineRedacted = exportBaseline.every(payload => payload.includes('<redacted>')) &&
      exportBaseline.every(payload => !payload.includes('browser-secret-source-token') && !payload.includes('rpc-password') && !payload.includes('archive-password'))
    const prove = async value => {
      reference.value = value
      reference.dispatchEvent(new Event('input', { bubbles: true }))
      await frame()
      const outputs = [...document.querySelectorAll('#export-yaml,#export-shell,#export-json')]
      const validExports = outputs.every((output, index) => output.dataset.invalid === 'false' && output.value === exportBaseline[index])
      const previewInvalid = document.querySelector('#ladder-status').dataset.status === 'error' && document.querySelector('.ladder-invalid[role=img]')?.getAttribute('aria-label')?.includes('Invalid ladder graphic') && document.querySelectorAll('.ladder-rung').length === 0
      const positiveError = value !== '0' && value !== '-1' || document.querySelector('.ladder-invalid[role=img]')?.getAttribute('aria-label')?.includes('referenceRateBps must be positive')
      const exportUiValid = document.querySelector('#validation-errors').hidden && !document.querySelector('#copy-export').disabled
      for (const id of ['tab-yaml', 'tab-shell', 'tab-json']) {
        document.querySelector('#' + id).click()
        await frame()
        document.querySelector('#copy-export').click()
        await frame()
      }
      const copiedPayloads = copied.splice(0)
      const clipboardExact = JSON.stringify(copiedPayloads) === JSON.stringify(exportBaseline)
      const clipboardIsolated = copiedPayloads.every(
        payload =>
          !payload.includes('preview-reference') &&
          !payload.includes('PREVIEW_REFERENCE') &&
          !payload.includes('browser-secret-source-token') &&
          !payload.includes('rpc-password') &&
          !payload.includes('archive-password')
      )
      return {
        validExports,
        previewInvalid,
        positiveError,
        exportUiValid,
        clipboardExact,
        clipboardIsolated
      }
    }
    const nonNumeric = await prove('not-a-number')
    const zero = await prove('0')
    const negative = await prove('-1')
    const hardRange = await prove('1000000000000000000000000000000000000')
    reference.value = '500'
    reference.dispatchEvent(new Event('input', { bubbles: true }))
    return { baselineRedacted, nonNumeric, zero, negative, hardRange }
  })()`)
  assert(
    previewIsolationProof.baselineRedacted &&
      Object.entries(previewIsolationProof)
        .filter(([key]) => key !== 'baselineRedacted')
        .every(([, result]) => Object.values(result).every(Boolean)),
    `preview/export isolation proof failed: ${JSON.stringify(previewIsolationProof)}`
  )

  const scalarParityProof = await evaluate(`(async () => {
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const set = (field, value) => {
      const input = document.querySelector(\`[data-field=\${field}]\`)
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set('NATIVE_RESERVE_WEI', '0')
    set('MAXIMUM_LEND_EXPOSURE_ASSETS', '0')
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { copied = value } }, configurable: true })
    const accepted = []
    for (const value of ['8453', '0008453', '  0008453  ']) {
      set('CHAIN_ID', value)
      await frame()
      const yaml = document.querySelector('#export-yaml').value
      const shell = document.querySelector('#export-shell').value
      const json = JSON.parse(document.querySelector('#export-json').value)
      const copies = []
      for (const tab of ['yaml', 'shell', 'json']) {
        document.querySelector('#tab-' + tab).click()
        await frame()
        document.querySelector('#copy-export').click()
        await frame()
        copies.push(copied)
      }
      accepted.push(
        [...document.querySelectorAll('#export-yaml,#export-shell,#export-json')].every(output => output.dataset.invalid === 'false') &&
        yaml.includes('  id: 8453\\n') && !yaml.includes('0008453') &&
        shell.includes("export CHAIN_ID='8453'") && !shell.includes('0008453') &&
        json.configuration.CHAIN_ID === '8453' &&
        copies[0] === yaml && copies[1] === shell && copies[2] === JSON.stringify(json, null, 2) + '\\n' &&
        copies.every(copy => !copy.includes('0008453')) &&
        document.querySelector('[data-field=CHAIN_ID]').value === value &&
        document.querySelector('#validation-errors').hidden && !document.querySelector('#copy-export').disabled &&
        document.querySelector('#ladder-status').dataset.status === 'ok' && document.querySelectorAll('.ladder-rung').length > 0
      )
    }
    const rejected = []
    for (const value of ['+8453', '8453.0', '8.453e3', '-8453', '0', '8454', '9007199254740992']) {
      set('CHAIN_ID', value)
      await frame()
      rejected.push(
        !document.querySelector('#validation-errors').hidden && document.querySelector('#copy-export').disabled &&
        document.querySelector('#ladder-status').dataset.status === 'error' &&
        [...document.querySelectorAll('#export-yaml,#export-shell,#export-json')].every(output => output.dataset.invalid === 'true')
      )
    }
    set('CHAIN_ID', '8453')
    return { accepted: accepted.every(Boolean), rejected: rejected.every(Boolean) }
  })()`)
  assert(
    Object.values(scalarParityProof).every(Boolean),
    `scalar parity browser proof failed: ${JSON.stringify(scalarParityProof)}`
  )

  const secondMarket = `0x${'6'.repeat(64)}`
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1024,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false
  })
  await evaluate(
    "document.querySelector('.market-card:has([data-field=quotePremiumBps]) [data-field=loopIntervalSeconds]').scrollIntoView({block:'center'})"
  )
  await evaluate(
    `(async () => {
      const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const input = document.querySelector('[data-field=MARKET_IDS]')
      if (!input.value.includes('${secondMarket}')) input.value += ',${secondMarket}'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const firstLadder = document.querySelector('.market-card:has([data-field=quotePremiumBps]) [data-field=loopIntervalSeconds]')
      firstLadder.value = '60'
      firstLadder.dispatchEvent(new Event('input', { bubbles: true }))
      await frame()
      ;[...document.querySelectorAll('button')].find(button => button.textContent === 'Add ladder market').click()
      await frame()
      const ladderCards = [...document.querySelectorAll('.market-card:has([data-field=quotePremiumBps])')]
      const added = ladderCards.at(-1)
      const input2 = added.querySelector('[data-field=marketId]')
      input2.value = '${secondMarket}'
      input2.dispatchEvent(new Event('input', { bubbles: true }))
      const interval2 = added.querySelector('[data-field=loopIntervalSeconds]')
      interval2.value = '30'
      interval2.dispatchEvent(new Event('input', { bubbles: true }))
      await frame()
      ;[...added.querySelectorAll('button')].find(button => button.textContent === 'Move up').click()
      await frame()
    })()`
  )
  assert(
    await evaluate(
      "(() => { const monitor=document.querySelector('.monitor-surface'); const style=getComputedStyle(monitor); return document.querySelectorAll('.ladder-market').length === 2 && Math.abs(monitor.getBoundingClientRect().top - parseFloat(style.top)) <= 2 && monitor.getBoundingClientRect().bottom <= innerHeight })()"
    ),
    'multiple ladder previews were not rendered inside the pinned monitor'
  )
  assert(
    await evaluate(
      `(() => {
        const markets = [...document.querySelectorAll('.ladder-market')]
        return markets.map(market => market.querySelector('.ladder-heading h3')?.id).join('|') === 'ladder-heading-0|ladder-heading-1' &&
          markets.map(market => market.querySelector('.ladder-heading code')?.textContent).join('|') === 'MARKET ID · ${secondMarket}|MARKET ID · 0x${'5'.repeat(64)}' &&
          markets.every((market, index) => market.querySelector('.ladder-graphic')?.getAttribute('aria-labelledby') === \`ladder-heading-\${index}\`)
      })()`
    ),
    'rendered ladder heading IDs did not exactly follow reordered DOM market order'
  )
  assert(
    await evaluate(
      `JSON.parse(document.querySelector('#export-json').value).configuration.LADDER_MARKETS[0].marketId === '${secondMarket}'`
    ),
    'ladder export did not preserve reordered market order'
  )
  const quickMarketProof = await evaluate(`(async () => {
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const select = document.querySelector('#quick-market-select')
    const firstIdentity = document.querySelector('[data-quick-field=marketId]').value === '${secondMarket}' &&
      document.querySelector('[data-quick-field=loopIntervalSeconds]').value === '30'
    const orderedOptions = [...select.options].map(option => option.textContent).join('|')
    const firstUiId = select.options[0].value
    const secondUiId = select.options[1].value
    select.value = secondUiId
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await frame()
    const switched = document.querySelector('#quick-market-select').value === secondUiId &&
      document.querySelector('[data-quick-field=marketId]').value === '0x${'5'.repeat(64)}' &&
      document.querySelector('[data-quick-field=loopIntervalSeconds]').value === '60'
    const currentSelect = document.querySelector('#quick-market-select')
    currentSelect.value = firstUiId
    currentSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await frame()
    return {
      firstIdentity,
      orderedOptions: orderedOptions.includes('Market 1 · ${secondMarket.slice(0, 10)}') &&
        orderedOptions.includes('Market 2 · 0x${'5'.repeat(8)}'),
      switched,
      restored: document.querySelector('[data-quick-field=marketId]').value === '${secondMarket}'
    }
  })()`)
  assert(
    Object.values(quickMarketProof).every(Boolean),
    `quick market selection/reorder identity failed: ${JSON.stringify(quickMarketProof)}`
  )
  assert(
    await evaluate(
      `(() => { const values=[...document.querySelectorAll('.ladder-market [data-parameter~="loopIntervalSeconds"].ladder-callout dd')].map(node=>node.textContent); return values.length===2 && values[0].startsWith('30s configured interval · 30s effective runtime cycle') && values[1].startsWith('60s configured interval · 30s effective runtime cycle') && values.every(value=>value.includes('minimum across configured markets') && value.includes('fresh stateless center unchanged')) })()`
    ),
    'multi-market configured intervals or minimum effective runtime cycle annotation is incorrect'
  )

  await evaluate(
    "(() => { const key=document.querySelector('[data-field=MAKER_PRIVATE_KEY]'); key.value='invalid'; key.dispatchEvent(new Event('input',{bubbles:true})); })()"
  )
  assert(
    await evaluate(
      "(() => { const monitor=document.querySelector('.monitor-surface'); const style=getComputedStyle(monitor); return !document.querySelector('#validation-errors').hidden && document.querySelector('#validation-errors').textContent.includes('MAKER_PRIVATE_KEY') && document.querySelector('#copy-export').disabled && document.querySelector('#ladder-status').dataset.status !== 'ok' && document.querySelectorAll('.ladder-rung').length === 0 && document.querySelector('.ladder-invalid[role=img]')?.textContent.includes('Invalid ladder graphic') && Math.abs(monitor.getBoundingClientRect().top - parseFloat(style.top)) <= 2 && monitor.getBoundingClientRect().bottom <= innerHeight })()"
    ),
    'invalid production configuration did not remain usable in the pinned monitor'
  )
  await evaluate(
    `(() => { const key=document.querySelector('[data-field=MAKER_PRIVATE_KEY]'); key.value='0x${'a'.repeat(64)}'; key.dispatchEvent(new Event('input',{bubbles:true})); })()`
  )
  assert(
    await evaluate(
      "document.querySelector('#ladder-status').dataset.status === 'ok' && document.querySelectorAll('.ladder-market').length === 2 && Math.abs(document.querySelector('.monitor-surface').getBoundingClientRect().top - parseFloat(getComputedStyle(document.querySelector('.monitor-surface')).top)) <= 2"
    ),
    'valid recovery did not restore both previews while the monitor stayed pinned'
  )

  await evaluate(
    "(() => { const token=document.querySelector('[data-field=BETTERSTACK_SOURCE_TOKEN]'); token.value='browser-warning-secret-token'; token.dispatchEvent(new Event('input',{bubbles:true})); const heartbeat=document.querySelector('[data-field=BETTERSTACK_HEARTBEAT_URL]'); heartbeat.value='javascript:https://secret.example/heartbeat-token'; heartbeat.dispatchEvent(new Event('input',{bubbles:true})); })()"
  )
  const observabilityWarningProof = await evaluate(`(async () => {
    const warning = document.querySelector('#observability-status')
    const yaml = document.querySelector('#export-yaml').value
    const shell = document.querySelector('#export-shell').value
    const json = document.querySelector('#export-json').value
    const exportsAvailable = [...document.querySelectorAll('#export-yaml,#export-shell,#export-json')].every(output => output.dataset.invalid === 'false')
    const warningAccessible = warning?.getAttribute('role') === 'status' && warning.textContent.includes('disabled at runtime') && warning.textContent.includes('Log shipping') && warning.textContent.includes('Heartbeat')
    const warningSafe = !warning.textContent.includes('browser-warning-secret-token') && !warning.textContent.includes('secret.example') && !warning.textContent.includes('heartbeat-token')
    const valuesCorrect = !yaml.includes('BETTERSTACK_') && !yaml.includes('browser-warning-secret-token') && !yaml.includes('heartbeat-token') && shell.includes("export BETTERSTACK_SOURCE_TOKEN='<redacted>'") && shell.includes("export BETTERSTACK_HEARTBEAT_URL='<redacted>'") && !json.includes('browser-warning-secret-token') && !json.includes('heartbeat-token') && JSON.parse(json).observability.BETTERSTACK_SOURCE_TOKEN === '<redacted>' && JSON.parse(json).observability.BETTERSTACK_HEARTBEAT_URL === '<redacted>'
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { copied = value } }, configurable: true })
    document.querySelector('#tab-json').click()
    document.querySelector('#copy-export').click()
    await new Promise(resolve => setTimeout(resolve, 0))
    const copyAvailableAndRedacted = copied.includes('<redacted>') && !copied.includes('browser-warning-secret-token') && !copied.includes('heartbeat-token')
    return { exportsAvailable, warningAccessible, warningSafe, valuesCorrect, copyAvailableAndRedacted, previewAvailable: document.querySelector('#ladder-status').dataset.status === 'ok' && document.querySelectorAll('.ladder-rung').length > 0, validationNonblocking: document.querySelector('#validation-errors').hidden && !document.querySelector('#copy-export').disabled }
  })()`)
  assert(
    Object.values(observabilityWarningProof).every(Boolean),
    `observability warnings did not remain accessible and nonblocking: ${JSON.stringify(observabilityWarningProof)}`
  )
  await evaluate(
    "(() => { const token=document.querySelector('[data-field=BETTERSTACK_SOURCE_TOKEN]'); token.value=''; token.dispatchEvent(new Event('input',{bubbles:true})); const heartbeat=document.querySelector('[data-field=BETTERSTACK_HEARTBEAT_URL]'); heartbeat.value=''; heartbeat.dispatchEvent(new Event('input',{bubbles:true})); })()"
  )

  await evaluate(
    "(() => { const step=document.querySelector('.market-card [data-field=stepBps]'); step.value='0'; step.dispatchEvent(new Event('input',{bubbles:true})); })()"
  )
  assert(
    await evaluate(
      "!document.querySelector('#validation-errors').hidden && document.querySelector('#validation-errors').getAttribute('role') === 'alert' && document.querySelector('#copy-export').disabled && document.querySelector('#export-yaml').dataset.invalid === 'true'"
    ),
    'invalid configuration was not exposed accessibly or export was not blocked'
  )

  await evaluate(
    "(() => { const step=document.querySelector('.market-card [data-field=stepBps]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(step,'100'); step.dispatchEvent(new Event('input',{bubbles:true})); Object.defineProperty(navigator, 'clipboard', {value: undefined, configurable: true}); document.execCommand=()=>false; document.querySelector('#copy-export').click() })()"
  )
  await waitForReadiness(async () => {
    if (
      !(await evaluate(
        "document.querySelector('#copy-status').textContent.includes('Copy was blocked')"
      ))
    )
      throw new Error('fallback status missing')
  }, uiReadiness('clipboard fallback status'))
  assert(
    await evaluate("document.querySelector('#copy-status').getAttribute('aria-live') === 'polite'"),
    'clipboard fallback is not announced in a live region'
  )

  const quickDeleteProof = await evaluate(`(async () => {
    const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    const firstCard = document.querySelector('.market-card:has([data-field=quotePremiumBps])')
    const step = firstCard.querySelector('[data-field=stepBps]')
    step.value = '100'
    step.dispatchEvent(new Event('input', { bubbles: true }))
    await frame()
    const remove = [...firstCard.querySelectorAll('button')].find(button => button.textContent === 'Remove ladder')
    remove.click()
    await frame()
    return {
      oneMarket: document.querySelectorAll('.market-card:has([data-field=quotePremiumBps])').length === 1 &&
        document.querySelectorAll('.ladder-market').length === 1,
      selectedFallback: document.querySelector('#quick-market-select').options.length === 1 &&
        document.querySelector('#quick-market-select').value === document.querySelector('#quick-market-select').options[0].value &&
        document.querySelector('[data-quick-field=marketId]').value === '0x${'5'.repeat(64)}',
      exportUpdated: JSON.parse(document.querySelector('#export-ladder-env').value).length === 1
    }
  })()`)
  assert(
    Object.values(quickDeleteProof).every(Boolean),
    `quick market delete fallback failed: ${JSON.stringify(quickDeleteProof)}`
  )
  const formBusActivity = await evaluate('globalThis.__formBusActivity')
  assert(
    formBusActivity.events.length === 0 &&
      formBusActivity.listeners.length === 0 &&
      formBusActivity.intervals.length === 0,
    `secret form changes touched a window bus/listener/interval: ${JSON.stringify(formBusActivity)}`
  )
  const persistenceInstrumentation = await evaluate('globalThis.__persistenceInstrumentation')
  const expectedPersistenceInstrumentation = [
    'Storage.getItem',
    'Storage.setItem',
    'Storage.removeItem',
    'Storage.clear',
    'Storage.key',
    'Storage.length',
    'Window.localStorage',
    'Window.sessionStorage',
    'Window.indexedDB',
    'IDBFactory.open',
    'IDBFactory.deleteDatabase',
    'IDBFactory.databases',
    'IDBFactory.cmp',
    'Window.caches',
    'CacheStorage.open',
    'CacheStorage.match',
    'CacheStorage.has',
    'CacheStorage.delete',
    'CacheStorage.keys',
    'Navigator.serviceWorker',
    'ServiceWorkerContainer.register',
    'ServiceWorkerContainer.getRegistration',
    'ServiceWorkerContainer.getRegistrations',
    'ServiceWorkerContainer.ready',
    'Document.cookie',
    'Window.cookieStore',
    'CookieStore.get',
    'CookieStore.getAll',
    'CookieStore.set',
    'CookieStore.delete',
    'Navigator.storage',
    'StorageManager.estimate',
    'StorageManager.persist',
    'StorageManager.persisted',
    'StorageManager.getDirectory',
    'Window.Worker',
    'Window.SharedWorker'
  ]
  assert(
    JSON.stringify(persistenceInstrumentation) ===
      JSON.stringify(expectedPersistenceInstrumentation),
    `persistence instrumentation coverage mismatch: ${JSON.stringify(persistenceInstrumentation)}`
  )
  const persistenceAccesses = await evaluate('globalThis.__persistenceAccesses')
  const securityProbeAccesses = await evaluate('globalThis.__securityProbeAccesses')
  assert(
    JSON.stringify(securityProbeAccesses) ===
      JSON.stringify([
        'Window.Worker.construct',
        'Window.Worker.construct',
        'Window.Worker.construct'
      ]),
    `security probe instrumentation was not scoped exactly: ${JSON.stringify(securityProbeAccesses)}`
  )
  assert(
    Array.isArray(persistenceAccesses) && persistenceAccesses.length === 0,
    `playground accessed persistence APIs: ${JSON.stringify(persistenceAccesses)}`
  )

  const unexpected = networkRequestEvents
    .filter(({ requestId }) => !cspBlockedRequestIds.has(requestId))
    .map(({ url }) => url)
    .filter(url => !url.startsWith(`http://127.0.0.1:${port}/`) && !url.startsWith('data:'))
  const outsideBasePath = requests.filter(url => {
    if (!url.startsWith(`http://127.0.0.1:${port}/`)) return false
    return !new URL(url).pathname.startsWith(basePath)
  })
  const expectedLocalUrls = await evaluate(`(() => {
    const isLocal = url => url.startsWith(location.origin + '/')
    return {
      document: location.href,
      scripts: [...document.scripts].map(script => script.src).filter(isLocal),
      stylesheets: [...document.querySelectorAll('link[rel="stylesheet"]')]
        .map(link => link.href)
        .filter(isLocal)
    }
  })()`)
  const localResponses = networkResponses.filter(({ url }) =>
    url.startsWith(`http://127.0.0.1:${port}/`)
  )
  const hashedAssets = [...expectedLocalUrls.scripts, ...expectedLocalUrls.stylesheets].map(
    url => new URL(url).pathname
  )
  assert(
    hashedAssets.length === 2 &&
      hashedAssets.every(path => /\/index\.[0-9a-f]{12}\.(?:css|js)$/.test(path)),
    `HTML did not request exact content-hashed JS/CSS assets: ${JSON.stringify(hashedAssets)}`
  )
  const actualLocalResources = localResponses
    .map(({ status, type, url }) => `${status} ${type} ${url}`)
    .sort()
  const expectedLocalResources = [
    `200 Document ${expectedLocalUrls.document}`,
    ...expectedLocalUrls.scripts.map(url => `200 Script ${url}`),
    ...expectedLocalUrls.stylesheets.map(url => `200 Stylesheet ${url}`)
  ].sort()
  assert(
    JSON.stringify(actualLocalResources) === JSON.stringify(expectedLocalResources),
    `local document/JS/CSS responses were not exact: ${JSON.stringify({ actualLocalResources, expectedLocalResources })}`
  )
  const securityTranscript = [...requests, ...consoleMessages].join('\n')
  for (const marker of [
    'rpc-password',
    'query-secret',
    'archive-password',
    'archive-secret',
    'browser-secret-source-token',
    'heartbeat-password',
    'heartbeat-query-secret',
    'heartbeat-fragment-secret',
    `0x${'9'.repeat(64)}`
  ]) {
    assert(
      !securityTranscript.includes(marker),
      `credential leaked to browser request/log output: ${marker}`
    )
  }
  assert(unexpected.length === 0, `unexpected network requests: ${unexpected.join(', ')}`)
  assert(
    outsideBasePath.length === 0,
    `local requests escaped ${basePath}: ${outsideBasePath.join(', ')}`
  )
  const delayedImportUnmountProof = await evaluate(`(async () => {
    const status = document.querySelector('#ladder-import-status')
    const output = document.querySelector('#export-ladder-env')
    const statusBefore = { text: status.textContent, kind: status.dataset.status }
    const outputBefore = output.value
    let finishRead
    const delayed = new File(['{}'], 'delayed-unmount.json', { type: 'application/json' })
    Object.defineProperty(delayed, 'text', {
      value: () => new Promise(resolve => { finishRead = resolve })
    })
    const input = document.querySelector('#ladder-import-file')
    Object.defineProperty(input, 'files', { value: [delayed], configurable: true })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
    globalThis.__unmountPlaygroundForSmoke()
    finishRead(outputBefore)
    await Promise.resolve()
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return {
      outputUnchanged: output.value === outputBefore,
      readyRemoved: document.documentElement.dataset.playgroundReady === undefined,
      rootEmpty: document.querySelector('#root').childElementCount === 0,
      rootMarkerRemoved: document.querySelector('#root').dataset.reactMounted === undefined,
      statusUnchanged: status.textContent === statusBefore.text && status.dataset.status === statusBefore.kind
    }
  })()`)
  assert(
    Object.values(delayedImportUnmountProof).every(Boolean),
    `delayed import wrote after root unmount: ${JSON.stringify(delayedImportUnmountProof)}`
  )
  assert(consoleErrors.length === 0, `browser console errors: ${consoleErrors.join('; ')}`)
  assert(
    describeHttpFailures(networkResponses).length === 0,
    `HTTP failures (status resource-type URL): ${describeHttpFailures(networkResponses).join('; ')}`
  )
  console.log(`browser smoke: PASS (${requests.length} local requests, 0 unexpected requests)`)
} finally {
  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
  await cleanup()
}
