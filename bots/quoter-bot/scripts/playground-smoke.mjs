import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PlaygroundSmokePersistenceError } from './playground-smoke-persistence.error.mjs'
import {
  closeOwnedProcessTreeGracefully,
  createCdpClient,
  describeHttpFailures,
  discoverChromium,
  inspectProcessTree,
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
const mobile = process.env.PLAYGROUND_SMOKE_VIEWPORT === 'mobile'
const disabledPersistencePatch = process.env.PLAYGROUND_SMOKE_MUTATION_DISABLE_PATCH ?? ''
const injectLateActivity = process.env.PLAYGROUND_SMOKE_MUTATION_LATE_ACTIVITY === 'all-documents'
const injectEarlyFormBusActivity =
  process.env.PLAYGROUND_SMOKE_MUTATION_EARLY_FORM_BUS_ACTIVITY ?? ''
const injectTerminalActivity =
  process.env.PLAYGROUND_SMOKE_MUTATION_TERMINAL_ACTIVITY === 'after-final-phase'
const buildCaptureBarrierFile = process.env.PLAYGROUND_SMOKE_BUILD_CAPTURE_BARRIER_FILE
const buildCaptureFile = process.env.PLAYGROUND_SMOKE_BUILD_CAPTURE_FILE
const expectedPersistencePhases = Object.freeze([
  'initial baseline',
  'collection edits',
  'invalid and valid edits',
  'preview edit',
  'share copy',
  'clipboard fallback',
  'runtime preview edits',
  'import',
  'export and before share navigation',
  'share document before reload',
  'share reload before malformed navigation',
  'malformed document before reload',
  'malformed reload before oversized navigation',
  'oversized document before reload',
  'final oversized reload'
])
const expectedPersistenceDocumentOrdinals = Object.freeze([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 2, 2, 3
])
const assertPersistencePhaseContract = snapshots => {
  assert.deepEqual(
    snapshots.map(({ phase }) => phase),
    expectedPersistencePhases,
    'persistence phases must match the exact ordered smoke contract'
  )
  const documentOrdinals = new Map()
  const observedOrdinals = snapshots.map(({ documentId }) => {
    if (!documentOrdinals.has(documentId)) documentOrdinals.set(documentId, documentOrdinals.size)
    return documentOrdinals.get(documentId)
  })
  assert.deepEqual(
    observedOrdinals,
    expectedPersistenceDocumentOrdinals,
    'persistence document transitions must match the exact four-document smoke contract'
  )
  assert.equal(documentOrdinals.size, 4)
}
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
let buildCapturePromise

if (Boolean(buildCaptureBarrierFile) !== Boolean(buildCaptureFile)) {
  throw new Error(
    'PLAYGROUND_SMOKE_BUILD_CAPTURE_BARRIER_FILE and PLAYGROUND_SMOKE_BUILD_CAPTURE_FILE must be set together'
  )
}

const stopChild = (child, cleanupOptions) => terminateOwnedProcessTree(child, cleanupOptions)
const trackChild = child => {
  children.add(child)
  const release = () => children.delete(child)
  child.once('close', release)
  return release
}
const captureBuildTree = async build => {
  const initialProcesses = await inspectProcessTree(build.pid)
  const root = initialProcesses.find(({ pid }) => pid === build.pid)
  assert.ok(root, `build process ${build.pid} disappeared before identity capture`)
  await waitForReadiness(() => readFile(buildCaptureBarrierFile), {
    child: build,
    childName: 'Fresh playground build',
    description: 'test-owned build process capture barrier',
    timeoutMs: cleanupTimeout,
    pollIntervalMs: 1
  })
  const descendants = (await inspectProcessTree(build.pid)).filter(({ pid }) => pid !== build.pid)
  await writeFile(
    buildCaptureFile,
    JSON.stringify({
      kind: 'quoter-bot-playground-build-process-tree',
      processes: [root, ...descendants],
      rootPid: build.pid
    })
  )
}
const trackBuildProcess = build => {
  const release = trackChild(build)
  if (buildCaptureFile) {
    buildCapturePromise = captureBuildTree(build)
    void buildCapturePromise.catch(() => {})
  }
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
      const captureResults = buildCapturePromise
        ? await Promise.allSettled([buildCapturePromise])
        : []
      const cleanupOptions = { deadline, signal }
      const childResults = await Promise.allSettled(
        [...children].map(child => stopOwnedChild(child, cleanupOptions))
      )
      if (signal.aborted) {
        const failures = [...captureResults, ...childResults].flatMap(result =>
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
      const failures = [...captureResults, ...childResults, ...resourceResults].flatMap(result =>
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

const createOwnedTempDirectory = async (prefix, parent = tmpdir()) => {
  const directory = mkdtempSync(join(parent, prefix))
  ownedDirectories.add(directory)
  if (!shutdown.signal.aborted) return directory
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  throw shutdown.signal.reason
}

try {
  const chromiumPath = await discoverChromium()
  const runTemporaryRoot = await createOwnedTempDirectory(
    'quoter-bot-smoke-',
    process.platform === 'win32' ? tmpdir() : '/tmp'
  )
  const preparedDist = await runBounded(
    signal =>
      prepareFreshDist({
        root,
        onDistCreated: directory => ownedDirectories.add(directory),
        onBuildProcess: trackBuildProcess,
        signal: AbortSignal.any([shutdown.signal, signal])
      }),
    { description: 'fresh playground build', timeoutMs: buildTimeout }
  )
  const dist = preparedDist.dist
  let servedRoot = dist
  if (basePath !== '/') {
    servedRoot = await createOwnedTempDirectory('site-', runTemporaryRoot)
    const mountedDist = join(servedRoot, ...basePath.split('/').filter(Boolean))
    await mkdir(mountedDist, { recursive: true })
    await cp(dist, mountedDist, { recursive: true })
  }
  const userDataDir = await createOwnedTempDirectory('profile-', runTemporaryRoot)
  const screenshotDirectory = await createOwnedTempDirectory('screenshots-', runTemporaryRoot)
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
    {
      env: { ...process.env, TMPDIR: runTemporaryRoot },
      stdio: ['ignore', 'ignore', 'pipe']
    }
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
  let startupPhase = true
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
  const persistenceActivity = []
  const documentSnapshots = []
  const mutationProofs = []
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
      if (
        message.method === 'Runtime.bindingCalled' &&
        message.params.name === '__recordSmokeActivity'
      ) {
        persistenceActivity.push(JSON.parse(message.params.payload))
      }
    }
  })
  const command = (method, params = {}) =>
    browserClient.command(method, params, {
      deadline: phaseDeadline,
      usePhaseDeadline: startupPhase
    })
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
  await command('Runtime.addBinding', { name: '__recordSmokeActivity' })
  await command('Emulation.setDeviceMetricsOverride', {
    width: mobile ? 390 : 1440,
    height: mobile ? 844 : 1000,
    deviceScaleFactor: 1,
    mobile
  })
  await command('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const PersistenceError = (${PlaygroundSmokePersistenceError.toString()})
      Object.defineProperty(globalThis, '__playgroundSmoke', { value: true })
      Object.defineProperty(globalThis, '__smoke', {
        value: { replacements: 0, copied: [], storage: [], cookies: [] }
      })
      if (location.hash === '#%7Bbad') {
        const observer = new MutationObserver(() => {
          const button = document.querySelector('#copy-share-url')
          if (!button) return
          observer.disconnect()
          button.click()
        })
        observer.observe(document, { childList: true, subtree: true })
      }
      const replaceState = history.replaceState.bind(history)
      history.replaceState = (...args) => {
        assertCleanBeforeTransition('history.replaceState')
        __smoke.replacements++
        return replaceState(...args)
      }
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: async value => { __smoke.copied.push(value) } }
      })
      const accesses = []
      const securityProbeAccesses = []
      const instrumented = []
      const expectedInstrumentation = []
      const formBusActivity = { events: [], listeners: [], intervals: [] }
      const disabledPatch = ${JSON.stringify(disabledPersistencePatch)}
      const reportActivity = (kind, name) => {
        try { globalThis.__recordSmokeActivity(JSON.stringify({ kind, name })) } catch {}
      }
      Object.defineProperty(globalThis, '__persistenceDocumentId', {
        value: crypto.randomUUID(), configurable: false, enumerable: false, writable: false
      })
      Object.defineProperty(globalThis, '__formBusActivity', {
        value: formBusActivity,
        configurable: false,
        enumerable: false,
        writable: false
      })
      const nativeWindowDispatchEvent = Window.prototype.dispatchEvent
      Window.prototype.dispatchEvent = function (event) {
        if (event instanceof CustomEvent) {
          formBusActivity.events.push(event.type)
          reportActivity('form-bus event', event.type)
        }
        return Reflect.apply(nativeWindowDispatchEvent, this, [event])
      }
      const nativeWindowAddEventListener = Window.prototype.addEventListener
      Window.prototype.addEventListener = function (type, listener, options) {
        if (/tanstack|form|devtools|connect/i.test(String(type))) {
          formBusActivity.listeners.push(String(type))
          reportActivity('form-bus listener', String(type))
        }
        return Reflect.apply(nativeWindowAddEventListener, this, [type, listener, options])
      }
      const nativeSetInterval = globalThis.setInterval
      globalThis.setInterval = function (...args) {
        formBusActivity.intervals.push(String(args[0]))
        reportActivity('form-bus interval', String(args[0]))
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
      Object.defineProperty(globalThis, '__expectedPersistenceInstrumentation', {
        value: expectedInstrumentation,
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
      __smoke.storage = accesses
      __smoke.cookies = accesses
      const record = name => {
        if (globalThis.__securityProbeActive) securityProbeAccesses.push(name)
        else {
          accesses.push(name)
          reportActivity('persistence access', name)
        }
      }
      const expected = (label, available, mandatory = false) => {
        expectedInstrumentation.push({ label, available, mandatory })
        return available
      }
      const shouldDisable = label => disabledPatch === label || disabledPatch === 'all-supported'
      const wrapMethod = (prototype, key, label, mandatory = false) => {
        const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, key)
        if (!expected(label, Boolean(descriptor && typeof descriptor.value === 'function'), mandatory)) return
        if (shouldDisable(label)) return
        try {
          Object.defineProperty(prototype, key, {
            ...descriptor,
            value: function (...args) {
              record(label)
              return Reflect.apply(descriptor.value, this, args)
            }
          })
          instrumented.push(label)
        } catch {}
      }
      const wrapAccessor = (prototype, key, label, mandatory = false) => {
        const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, key)
        if (!expected(label, Boolean(descriptor && (descriptor.get || descriptor.set)), mandatory)) return
        if (shouldDisable(label)) return
        try {
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
          instrumented.push(label)
        } catch {}
      }
      const wrapConstructor = (prototype, key, label) => {
        const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, key)
        if (!expected(label, Boolean(descriptor && typeof descriptor.value === 'function'))) return
        if (shouldDisable(label)) return
        try {
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
          instrumented.push(label)
        } catch {}
      }
      for (const key of ['getItem', 'setItem', 'removeItem', 'clear', 'key']) {
        wrapMethod(globalThis.Storage?.prototype, key, 'Storage.' + key)
      }
      wrapAccessor(globalThis.Storage?.prototype, 'length', 'Storage.length')
      wrapAccessor(globalThis, 'localStorage', 'Window.localStorage', true)
      wrapAccessor(globalThis, 'sessionStorage', 'Window.sessionStorage', true)
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
      wrapAccessor(globalThis.Document?.prototype, 'cookie', 'Document.cookie', true)
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
      const assertCleanBeforeTransition = transition => {
        const activity = accesses.length + formBusActivity.events.length + formBusActivity.listeners.length + formBusActivity.intervals.length
        if (activity) throw new PersistenceError('persistence access or form-bus activity before ' + transition)
      }
      if (${JSON.stringify(injectLateActivity || injectTerminalActivity)}) {
        const runCanaries = () => {
          const safely = operation => { try { return operation() } catch {} }
          const settle = value => value?.catch?.(() => {})
          safely(() => localStorage.setItem('__smoke_canary', '1')); safely(() => localStorage.getItem('__smoke_canary'))
          safely(() => localStorage.removeItem('__smoke_canary')); safely(() => localStorage.key(0))
          safely(() => localStorage.length); safely(() => localStorage.clear())
          safely(() => sessionStorage.setItem('__smoke_canary', '1')); safely(() => sessionStorage.getItem('__smoke_canary'))
          safely(() => sessionStorage.removeItem('__smoke_canary')); safely(() => sessionStorage.key(0))
          safely(() => sessionStorage.length); safely(() => sessionStorage.clear())
          safely(() => { document.cookie = '__smoke_canary=1; SameSite=Strict' }); safely(() => document.cookie)
          safely(() => { document.cookie = '__smoke_canary=; Max-Age=0; SameSite=Strict' })
          safely(() => indexedDB.cmp('a', 'b')); settle(safely(() => indexedDB.databases()))
          safely(() => indexedDB.open('__smoke_canary')); safely(() => indexedDB.deleteDatabase('__smoke_canary'))
          settle(safely(() => caches.keys())); settle(safely(() => caches.match('/__smoke_canary')))
          settle(safely(() => caches.has('__smoke_canary'))); settle(safely(() => caches.delete('__smoke_canary')))
          settle(safely(() => caches.open('__smoke_canary')))
          settle(safely(() => navigator.serviceWorker.getRegistration()))
          settle(safely(() => navigator.serviceWorker.getRegistrations()))
          settle(safely(() => navigator.serviceWorker.register('data:text/javascript,')))
          safely(() => navigator.serviceWorker.ready)
          settle(safely(() => cookieStore.get('__smoke_canary'))); settle(safely(() => cookieStore.getAll('__smoke_canary')))
          settle(safely(() => cookieStore.set('__smoke_canary', '1'))); settle(safely(() => cookieStore.delete('__smoke_canary')))
          settle(safely(() => navigator.storage.estimate())); settle(safely(() => navigator.storage.persist()))
          settle(safely(() => navigator.storage.persisted())); settle(safely(() => navigator.storage.getDirectory()))
          safely(() => Worker('data:text/javascript,')); safely(() => SharedWorker('data:text/javascript,'))
          dispatchEvent(new CustomEvent('tanstack-form-smoke-canary'))
          addEventListener('tanstack-form-smoke-canary', () => {})
          const interval = setInterval(() => {}, 60_000); clearInterval(interval)
        }
        Object.defineProperty(globalThis, '__runPersistenceCanaries', {
          value: runCanaries, configurable: false, enumerable: false, writable: false
        })
      }
    })()`
  })
  const pageUrl = `http://127.0.0.1:${port}${basePath}`
  await command('Page.navigate', { url: pageUrl })
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
    await evaluate("document.querySelector('#root')?.childElementCount > 0"),
    'Playground root did not commit before the ready contract'
  )
  console.log(
    `smoke environment: appPort=${port} chromiumDebugPort=${debuggingPort} smokeTemporaryRoot=${runTemporaryRoot} chromium=${chromiumPath}`
  )
  startupPhase = false
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
  const assertDocumentPersistenceClean = async (phase, { recordPhase = true } = {}) => {
    if (injectLateActivity && recordPhase) await evaluate('__runPersistenceCanaries()')
    if (injectEarlyFormBusActivity === phase) {
      await evaluate("dispatchEvent(new CustomEvent('tanstack-form-early-mutation'))")
    }
    await evaluate(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    )
    await new Promise(resolve => setImmediate(resolve))
    const snapshot = await evaluate(`({
      documentId: __persistenceDocumentId,
      expected: __expectedPersistenceInstrumentation,
      formBus: __formBusActivity,
      instrumented: __persistenceInstrumentation,
      persistenceAccesses: __persistenceAccesses
    })`)
    if (recordPhase) documentSnapshots.push({ ...snapshot, phase })
    const missing = snapshot.expected
      .filter(({ available, mandatory }) => (mandatory ? !available : false))
      .map(({ label }) => label + ' (mandatory API unavailable)')
      .concat(
        snapshot.expected
          .filter(({ available, label }) => available && !snapshot.instrumented.includes(label))
          .map(({ label }) => label)
      )
    if (missing.length) {
      throw new PlaygroundSmokePersistenceError(
        `persistence instrumentation missing during ${phase}: ${missing.join(', ')}`
      )
    }
    if (injectLateActivity && recordPhase) {
      const unobserved = snapshot.expected
        .filter(({ available }) => available)
        .map(({ label }) => label)
        .filter(label => !snapshot.persistenceAccesses.some(access => access.startsWith(label)))
      if (unobserved.length) {
        throw new PlaygroundSmokePersistenceError(
          `persistence mutation canaries did not exercise during ${phase}: ${unobserved.join(', ')}`
        )
      }
      const formBusEntries = [
        ...snapshot.formBus.events,
        ...snapshot.formBus.listeners,
        ...snapshot.formBus.intervals
      ]
      if (formBusEntries.length !== 3 || persistenceActivity.length === 0) {
        throw new PlaygroundSmokePersistenceError(
          `form-bus activity mutation canaries were incomplete during ${phase}`
        )
      }
      mutationProofs.push({ documentId: snapshot.documentId, phase })
      await evaluate(`(() => {
        __persistenceAccesses.length = 0
        __formBusActivity.events.length = 0
        __formBusActivity.listeners.length = 0
        __formBusActivity.intervals.length = 0
      })()`)
      persistenceActivity.length = 0
      return
    }
    if (snapshot.persistenceAccesses.length) {
      throw new PlaygroundSmokePersistenceError(
        `persistence access detected during ${phase}: ${snapshot.persistenceAccesses.join(', ')}`
      )
    }
    const formBusEntries = [
      ...snapshot.formBus.events,
      ...snapshot.formBus.listeners,
      ...snapshot.formBus.intervals
    ]
    if (formBusEntries.length) {
      throw new PlaygroundSmokePersistenceError(
        `form-bus activity detected during ${phase}: ${formBusEntries.join(', ')}`
      )
    }
    if (persistenceActivity.length) {
      throw new PlaygroundSmokePersistenceError(
        `cross-document persistence access or form-bus activity detected during ${phase}: ${persistenceActivity.map(({ kind, name }) => `${kind}:${name}`).join(', ')}`
      )
    }
  }

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
  requests.length = 0
  networkResponses.length = 0

  const baseline = await evaluate(`(() => ({
    title: document.title,
    bootstrap: document.querySelectorAll('[data-preview=bootstrap]').length,
    ladder: document.querySelectorAll('[data-preview=ladder]').length,
    tabs: [...document.querySelectorAll('[role=tab]')].map(x => x.textContent.trim()),
    fileInputs: document.querySelectorAll('input[type=file]').length,
    oldText: /Runtime & setup|Observability|Shell-safe ENV|Choose .*file|Drop one/.test(document.body.innerText),
    href: location.href,
    outputs: [...document.querySelectorAll('.exports textarea')].map(x => x.value),
    sticky: getComputedStyle(document.querySelector('.monitor')).position,
    storage: __smoke.storage,
    cookies: __smoke.cookies
  }))()`)
  assert.equal(baseline.title, 'Bootstrap & ladder playground')
  assert.equal(baseline.bootstrap, 1)
  assert.equal(baseline.ladder, 1)
  assert.deepEqual(baseline.tabs, [
    'Bootstrap JSON',
    'Bootstrap JSON string',
    'Ladder JSON',
    'Ladder JSON string'
  ])
  assert.equal(baseline.fileInputs, 0)
  assert.equal(baseline.oldText, false)
  assert.equal(baseline.sticky, 'sticky')
  await assertDocumentPersistenceClean('initial baseline')
  assert.match(baseline.href, new RegExp(`${basePath.replaceAll('/', '\\/')}#`))
  const accessibilityTree = await command('Accessibility.getFullAXTree')
  const accessibleTabs = accessibilityTree.nodes
    .filter(node => node.role?.value === 'tab')
    .map(node => node.name?.value)
  assert.deepEqual(accessibleTabs, baseline.tabs)

  const collectionActions = await evaluate(`(async () => {
    document.querySelector('#add-bootstrap').click(); document.querySelector('#add-ladder').click(); await new Promise(r => setTimeout(r, 60));
    const added = { bootstrap: document.querySelectorAll('[data-preview=bootstrap]').length, ladder: document.querySelectorAll('[data-preview=ladder]').length, status: document.querySelector('#url-status').dataset.status };
    document.querySelectorAll('[data-market-kind=bootstrap]')[1].querySelectorAll('button')[2].click();
    document.querySelectorAll('[data-market-kind=ladder]')[1].querySelectorAll('button')[2].click(); await new Promise(r => setTimeout(r, 60));
    return { added, bootstrap: document.querySelectorAll('[data-preview=bootstrap]').length, ladder: document.querySelectorAll('[data-preview=ladder]').length, focus: document.activeElement.id };
  })()`)
  assert.deepEqual(collectionActions, {
    added: { bootstrap: 2, ladder: 2, status: 'ok' },
    bootstrap: 1,
    ladder: 1,
    focus: 'add-ladder'
  })
  await assertDocumentPersistenceClean('collection edits')

  const invalidSync = await evaluate(`(async () => {
    const input = document.querySelector('#ladder-0-stepBps');
    const set = value => { const old = input.value; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(input, value); input._valueTracker?.setValue(old); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); };
    const validHash = location.hash; const before = __smoke.replacements;
    set('0'); await new Promise(r => setTimeout(r, 30)); const invalidHash = location.hash; const afterFirst = __smoke.replacements;
    const independentExports = [...document.querySelectorAll('.exports textarea')].map(x => x.dataset.invalid);
    for (let i=0;i<20;i++) { set(i % 2 ? '0' : '-1'); await new Promise(r => setTimeout(r, 2)); }
    const afterSustained = __smoke.replacements;
    set('100'); await new Promise(r => setTimeout(r, 100));
    return { validHash, invalidHash, finalHash: location.hash, before, afterFirst, afterSustained, independentExports, status: document.querySelector('#url-status').textContent };
  })()`)
  assert.equal(invalidSync.invalidHash, invalidSync.validHash)
  assert.equal(invalidSync.afterFirst, invalidSync.afterSustained)
  assert.deepEqual(invalidSync.independentExports, ['false', 'false', 'true', 'true'])
  assert.notEqual(invalidSync.finalHash, '')
  assert.match(invalidSync.status, /synchronized/i)
  await assertDocumentPersistenceClean('invalid and valid edits')

  const markerPositions = await evaluate(`(async () => {
    const input = document.querySelector('#ladder-0-quotePremiumBps');
    const old = input.value;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '100');
    input._valueTracker?.setValue(old);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 30));
    const reference = document.querySelector('.ladder-reference-marker');
    const center = document.querySelector('.ladder-center-marker');
    return {
      referenceTop: reference?.style.top,
      centerTop: center?.style.top,
      referenceLabel: reference?.textContent.trim(),
      centerLabel: center?.textContent.trim()
    };
  })()`)
  assert.deepEqual(markerPositions, {
    referenceTop: '66.66%',
    centerTop: '50%',
    referenceLabel: 'Reference 400 BPS',
    centerLabel: 'Center 500 BPS'
  })
  await assertDocumentPersistenceClean('preview edit')

  const immediateShare = await evaluate(`(async () => {
    const input = document.querySelector('#bootstrap-0-creditTarget');
    const old = input.value;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '10000000001');
    input._valueTracker?.setValue(old);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#copy-share-url').click();
    await new Promise(r => setTimeout(r, 0));
    const bootstrap = JSON.parse(document.querySelector('[aria-label="Bootstrap JSON output"]').value);
    bootstrap[0].creditTarget = '10000000001';
    const ladder = JSON.parse(document.querySelector('[aria-label="Ladder JSON output"]').value);
    const fragment = '#' + encodeURIComponent(JSON.stringify({ version: 1, bootstrap, ladder }));
    return { copied: __smoke.copied.at(-1), expected: location.origin + location.pathname + location.search + fragment };
  })()`)
  assert.equal(immediateShare.copied, immediateShare.expected)
  await assertDocumentPersistenceClean('share copy')

  const clipboardFallback = await evaluate(`(async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('forced rejection'); } } });
    const button = document.querySelector('#copy-share-url');
    button.click();
    await new Promise(r => setTimeout(r, 30));
    const control = document.querySelector('#share-url-output');
    const result = {
      focused: document.activeElement === control,
      selected: control.selectionStart === 0 && control.selectionEnd === control.value.length,
      message: document.querySelector('#copy-status').textContent.trim()
    };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { __smoke.copied.push(value); } } });
    return result;
  })()`)
  assert.deepEqual(clipboardFallback, {
    focused: true,
    selected: true,
    message: 'Copy blocked; Share URL selected. Press Ctrl/Cmd+C.'
  })
  await waitForReadiness(async () => {
    assert.match(
      await evaluate("document.querySelector('#copy-status')?.textContent || ''"),
      /Copy blocked/
    )
  }, uiReadiness('clipboard fallback status'))
  await assertDocumentPersistenceClean('clipboard fallback')

  const runtimePreviewParity = await evaluate(`(async () => {
    const set = (selector, value) => {
      const input = document.querySelector(selector);
      const old = input.value;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input._valueTracker?.setValue(old);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('#bootstrap-0-premiumBps', '-1000');
    set('#ladder-0-quotePremiumBps', '-1000');
    await new Promise(r => setTimeout(r, 30));
    const invalid = [...document.querySelectorAll('.exports textarea')].map(x => x.dataset.invalid);
    const previewErrors = document.querySelectorAll('[data-preview-error]').length;
    const shareDisabled = document.querySelector('#copy-share-url').disabled;
    document.querySelector('#copy-share-url').click();
    await new Promise(r => setTimeout(r, 0));
    const copied = __smoke.copied.at(-1);
    const displayed = document.querySelector('#share-url-output').value;
    set('#bootstrap-0-premiumBps', '-50');
    set('#ladder-0-quotePremiumBps', '100');
    await new Promise(r => setTimeout(r, 30));
    return { invalid, previewErrors, shareDisabled, copiedMatchesDisplayed: copied === displayed };
  })()`)
  assert.deepEqual(runtimePreviewParity, {
    invalid: ['false', 'false', 'false', 'false'],
    previewErrors: 2,
    shareDisabled: false,
    copiedMatchesDisplayed: true
  })
  await assertDocumentPersistenceClean('runtime preview edits')

  const importAtomic = await evaluate(`(async () => {
    const area = document.querySelector('#collection-import'); const apply = document.querySelector('#apply-import');
    const set = value => { const old = area.value; const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(area, value); area._valueTracker?.setValue(old); area.dispatchEvent(new Event('input', { bubbles: true })); area.dispatchEvent(new Event('change', { bubbles: true })); };
    const before = location.hash;
    set('[{"marketId":"x"},42]'); apply.click(); await new Promise(r => setTimeout(r, 20)); const mixed = location.hash === before && document.querySelector('#import-status').dataset.status === 'error';
    set('{"bootstrap":[],"bootstrap":[]}'); apply.click(); await new Promise(r => setTimeout(r, 20)); const duplicate = location.hash === before && document.querySelector('#import-status').dataset.status === 'error';
    set('42'); apply.click(); await new Promise(r => setTimeout(r, 20)); const primitive = location.hash === before && document.querySelector('#import-status').dataset.status === 'error';
    const beforeCanary = [...document.querySelectorAll('.exports textarea')].map(x => x.value);
    const canary = 'PRIVATE_CANARY_DO_NOT_ECHO';
    set(JSON.stringify({ bootstrap: JSON.parse(beforeCanary[0]), [canary]: true })); apply.click(); await new Promise(r => setTimeout(r, 20));
    const atomicNoEcho = JSON.stringify(beforeCanary) === JSON.stringify([...document.querySelectorAll('.exports textarea')].map(x => x.value)) && !document.querySelector('#import-status').textContent.includes(canary);
    const bootstrap = JSON.parse(document.querySelector('[aria-label="Bootstrap JSON output"]').value);
    const ladder = JSON.parse(document.querySelector('[aria-label="Ladder JSON output"]').value);
    const secondId = '0x' + '6'.repeat(64);
    bootstrap.push({ ...bootstrap[0], marketId: secondId });
    ladder.push({ ...ladder[0], marketId: secondId, maturityPremium: { shape: 'linear', premiumPerYearBps: '120' } });
    set(JSON.stringify({ bootstrap, ladder })); apply.click(); await new Promise(r => setTimeout(r, 50));
    const valid = document.querySelector('#import-status').dataset.status === 'ok' && document.querySelectorAll('[data-preview=bootstrap]').length === 2 && document.querySelectorAll('[data-preview=ladder]').length === 2;
    document.querySelectorAll('[data-market-kind=ladder]')[1].querySelector('button').click();
    return { mixed, duplicate, primitive, atomicNoEcho, valid };
  })()`)
  assert.equal(importAtomic.mixed, true)
  assert.equal(importAtomic.duplicate, true)
  assert.equal(importAtomic.primitive, true)
  assert.equal(importAtomic.atomicNoEcho, true)
  assert.equal(importAtomic.valid, true)
  const importState = await waitForReadiness(async () => {
    const state = await evaluate(`({
      focus: document.activeElement?.id,
      reordered: JSON.parse(document.querySelector('[aria-label="Ladder JSON output"]').value).map(x => x.marketId),
      premiums: JSON.parse(document.querySelector('[aria-label="Ladder JSON output"]').value).map(x => 'maturityPremium' in x ? x.maturityPremium.premiumPerYearBps : null)
    })`)
    assert.equal(state.focus, 'ladder-0-marketId')
    assert.equal(state.reordered[0], `0x${'6'.repeat(64)}`)
    return state
  }, uiReadiness('import reorder completion'))
  assert.equal(importState.focus, 'ladder-0-marketId')
  assert.equal(importState.reordered[0], `0x${'6'.repeat(64)}`)
  // Reordering must carry a configured maturityPremium with its item and must not materialize the
  // optional object onto a premium-free item; a partial object makes the whole collection invalid.
  assert.deepEqual(importState.premiums, ['120', null])
  await assertDocumentPersistenceClean('import')

  const copyTabs = await evaluate(`(async () => {
    const tabs=[...document.querySelectorAll('[role=tab]')];
    for (const tab of tabs) { tab.click(); await new Promise(r=>setTimeout(r,0)); document.querySelector('[role=tabpanel]:not([hidden]) button').click(); await new Promise(r=>setTimeout(r,0)); }
    document.querySelector('#copy-share-url').click(); await new Promise(r=>setTimeout(r,0));
    tabs[0].focus(); tabs[0].dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}));
    return { copied: __smoke.copied, outputs: [...document.querySelectorAll('.exports textarea')].map(x=>x.value), panels: document.querySelectorAll('[role=tabpanel]').length };
  })()`)
  const endKeyTabState = await waitForReadiness(async () => {
    const state = await evaluate(`({
      selected: document.activeElement?.id,
      active: document.querySelector('[role=tab][aria-selected=true]')?.id,
      panel: document.querySelector('[role=tabpanel]:not([hidden])')?.id
    })`)
    assert.deepEqual(state, {
      active: 'tab-ladder-string',
      selected: 'tab-ladder-string',
      panel: 'panel-ladder-string'
    })
    return state
  }, uiReadiness('End-key tab selection'))
  assert.equal(copyTabs.copied.length, 7)
  assert.equal(copyTabs.panels, 4)
  assert.equal(endKeyTabState.active, 'tab-ladder-string')
  assert.equal(endKeyTabState.selected, 'tab-ladder-string')
  await assertDocumentPersistenceClean('export and before share navigation')

  const shareUrl = copyTabs.copied.at(-1)
  await command('Page.navigate', { url: shareUrl })
  await waitForReadiness(async () => assert.equal(await evaluate('location.href'), shareUrl), {
    description: 'share URL navigation',
    timeoutMs: 20_000,
    pollIntervalMs: 50
  })
  await assertDocumentPersistenceClean('share document before reload')
  await command('Page.reload', { ignoreCache: true })
  await waitForReadiness(
    async () =>
      assert.equal(await evaluate('document.documentElement.dataset.playgroundReady'), 'true'),
    uiReadiness('share URL reload')
  )
  assert.deepEqual(
    await evaluate("[...document.querySelectorAll('.exports textarea')].map(x=>x.value)"),
    copyTabs.outputs
  )
  await assertDocumentPersistenceClean('share reload before malformed navigation')

  await command('Page.navigate', { url: `${pageUrl}#%7Bbad` })
  await waitForReadiness(
    async () => assert.equal(await evaluate('location.hash'), '#%7Bbad'),
    uiReadiness('malformed URL navigation')
  )
  await assertDocumentPersistenceClean('malformed document before reload')
  await command('Page.reload', { ignoreCache: true })
  await waitForReadiness(
    async () =>
      assert.match(
        await evaluate("document.querySelector('#url-status')?.textContent || ''"),
        /ignored/i
      ),
    uiReadiness('malformed fallback')
  )
  assert.equal(await evaluate("document.querySelectorAll('[data-preview=bootstrap]').length"), 1)
  const malformedFirstShare = await evaluate(`(() => {
    const bootstrap = JSON.parse(document.querySelector('[aria-label="Bootstrap JSON output"]').value);
    const ladder = JSON.parse(document.querySelector('[aria-label="Ladder JSON output"]').value);
    const fragment = '#' + encodeURIComponent(JSON.stringify({ version: 1, bootstrap, ladder }));
    return { copied: __smoke.copied[0], expected: location.origin + location.pathname + location.search + fragment };
  })()`)
  assert.equal(malformedFirstShare.copied, malformedFirstShare.expected)
  await assertDocumentPersistenceClean('malformed reload before oversized navigation')

  const oversizedHash = `#${'x'.repeat(140_000)}`
  await command('Page.navigate', { url: `${pageUrl}${oversizedHash}` })
  await waitForReadiness(
    async () => assert.equal(await evaluate('location.hash.length'), oversizedHash.length),
    uiReadiness('oversized URL navigation')
  )
  await assertDocumentPersistenceClean('oversized document before reload')
  await command('Page.reload', { ignoreCache: true })
  await waitForReadiness(
    async () =>
      assert.match(
        await evaluate("document.querySelector('#url-status')?.textContent || ''"),
        /size limit/i
      ),
    uiReadiness('oversized fallback')
  )
  assert.equal(await evaluate("document.querySelectorAll('[data-preview=ladder]').length"), 1)
  await assertDocumentPersistenceClean('final oversized reload')
  assertPersistencePhaseContract(documentSnapshots)
  if (injectLateActivity) assertPersistencePhaseContract(mutationProofs)

  const unexpected = requests.filter(
    url =>
      !url.startsWith(`http://127.0.0.1:${port}`) &&
      !url.startsWith('data:') &&
      url !== 'about:blank'
  )
  assert.deepEqual(unexpected, [])
  assert.deepEqual(consoleErrors, [], `${consoleErrors.join('\n')}\n${browserStderr}`)
  const screenshotPath = join(screenshotDirectory, mobile ? 'mobile.png' : 'desktop.png')
  const screenshot = await command('Page.captureScreenshot', { format: 'png' })
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
  assert.equal(describeHttpFailures(networkResponses).length, 0)
  const resultSummary = { basePath, mobile, checks: 'passed', requests: requests.length }
  if (injectTerminalActivity) await evaluate('__runPersistenceCanaries()')
  await assertDocumentPersistenceClean('terminal completion', { recordPhase: false })
  if (injectLateActivity) {
    throw new PlaygroundSmokePersistenceError(
      `persistence access and form-bus activity mutation proof covered ${mutationProofs.length} phases across 4 documents`
    )
  }
  console.log(`browser smoke: PASS (${requests.length} local requests, 0 unexpected requests)`)
  console.log(JSON.stringify(resultSummary))
} finally {
  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
  await cleanup()
}
