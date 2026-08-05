import { mkdtempSync } from 'node:fs'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  closeOwnedProcessTreeGracefully,
  createCdpClient,
  discoverChromium,
  openWebSocket,
  prepareFreshDist,
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
const ownedDirectories = new Set([join(root, 'playground/dist')])
const children = new Set()
let server
let cleanupPromise
let terminatingSignal
let browser
let browserSocket
let browserClient
let browserReady = false

const stopChild = child => terminateOwnedProcessTree(child)
const trackChild = child => {
  children.add(child)
  const release = () => children.delete(child)
  child.once('close', release)
  return release
}
const stopOwnedChild = async child => {
  if (child === browser && browserReady && browserSocket?.readyState === WebSocket.OPEN) {
    try {
      await closeOwnedProcessTreeGracefully(child, () => {
        browserSocket.send(JSON.stringify({ id: 0, method: 'Browser.close' }))
      })
      return
    } catch (error) {
      console.error(`Graceful Chromium shutdown failed; escalating: ${error.message}`)
      // Fall through to bounded direct-parent/deepest-first termination.
    }
  }
  await stopChild(child)
}
const cleanup = () =>
  (cleanupPromise ??= runBounded(
    async () => {
      browserClient?.dispose(new Error('Smoke cleanup started'))
      const childResults = await Promise.allSettled([...children].map(stopOwnedChild))
      const resourceResults = await Promise.allSettled([
        ...(server ? [server.close()] : []),
        ...[...ownedDirectories].map(directory =>
          rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
        )
      ])
      const failure = [...childResults, ...resourceResults].find(
        ({ status }) => status === 'rejected'
      )
      if (failure) throw failure.reason
    },
    { description: 'smoke cleanup', timeoutMs: cleanupTimeout }
  ))
const onSignal = signal => {
  if (terminatingSignal) return
  terminatingSignal = signal
  shutdown.abort(new Error(`Smoke test interrupted by ${signal}`))
  void cleanup().then(
    () => {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      try {
        process.kill(process.pid, signal)
      } catch {
        process.exit(signal === 'SIGINT' ? 130 : 143)
      }
    },
    error => {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      console.error(`Smoke cleanup failed before ${signal} could be re-signalled: ${error.message}`)
      process.exitCode = 1
    }
  )
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
    const response = await fetch(
      `http://127.0.0.1:${debuggingPort}/json/new?http://127.0.0.1:${port}`,
      {
        method: 'PUT',
        signal
      }
    )
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
  const responseUrls = []
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
      if (message.method === 'Network.responseReceived')
        responseUrls.push(message.params.response.url)
      if (message.method === 'Runtime.exceptionThrown')
        consoleErrors.push(message.params.exceptionDetails.text)
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
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    })
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
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false
  })
  await command('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const accesses = []
      const instrumented = []
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
      const record = name => accesses.push(name)
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
    })()`
  })
  await command('Page.navigate', { url: `http://127.0.0.1:${port}${basePath}` })
  await waitForReadiness(async () => {
    if (!(await evaluate("document.documentElement.dataset.playgroundReady === 'true'"))) {
      throw new Error('playground not ready')
    }
  }, browserReadiness('playground page readiness'))
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

  assert(
    await evaluate(
      `document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content.includes("connect-src 'none'") === true`
    ),
    "playground CSP does not block network connections with connect-src 'none'"
  )
  assert(
    consoleErrors.length === 0,
    `browser errors before CSP probes: ${consoleErrors.join('; ')}`
  )
  const cspRequestOffset = networkRequestEvents.length
  const cspProof = await evaluate(`(async () => {
    const violations = []
    const errors = []
    const rejections = []
    const recordViolation = event => violations.push({
      blockedURI: event.blockedURI,
      effectiveDirective: event.effectiveDirective
    })
    document.addEventListener('securitypolicyviolation', recordViolation)
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
    await new Promise(resolve => setTimeout(resolve, 0))
    document.removeEventListener('securitypolicyviolation', recordViolation)
    return { violations, errors, rejections }
  })()`)
  const cspDirectives = cspProof.violations.map(({ effectiveDirective }) => effectiveDirective)
  assert(
    cspDirectives.filter(directive => directive === 'connect-src').length >= 2 &&
      cspDirectives.some(
        directive => directive === 'script-src-elem' || directive === 'script-src'
      ) &&
      cspProof.errors.includes('websocket') &&
      cspProof.errors.includes('script') &&
      cspProof.rejections.some(({ source }) => source === 'fetch'),
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
  const cspExternalResponses = responseUrls.filter(
    url =>
      url.startsWith('https://csp-probe.invalid/') || url.startsWith('wss://csp-probe.invalid/')
  )
  assert(
    cspExternalRequests.every(({ requestId }) => cspBlockedRequestIds.has(requestId)) &&
      cspExternalResponses.length === 0,
    `CSP probes escaped before network: ${JSON.stringify({ cspExternalRequests, cspExternalResponses })}`
  )
  console.log(`browser CSP: PASS (${cspProof.violations.length} violations, 0 external responses)`)
  consoleErrors.length = 0
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
      "document.querySelector('#include-sensitive-values')?.checked === false && document.querySelector('#include-sensitive-warning')?.textContent.includes('complete RPC URLs')"
    ),
    'sensitive export opt-in is not explicit, unchecked, and warned'
  )
  assert(
    await evaluate(
      "document.querySelector('.ladder-scroll') && document.querySelector('.rung-table:not([hidden])') && getComputedStyle(document.querySelector('.rung-table')).display !== 'none' && document.querySelectorAll('.rung-table tbody tr').length === 6 && [...document.querySelectorAll('.rung-table thead th')].map(cell => cell.textContent).join('|') === 'Side|Rate (BPS)|Allocation (assets)|Offer maxAssets (assets)'"
    ),
    'exact allocation and offer maxAssets enumeration is unavailable to assistive technology'
  )
  assert(
    await evaluate(
      "document.querySelector('.ladder-graphic svg[role=img] title')?.textContent.includes('allocation, and offer maxAssets') && document.querySelector('.ladder-graphic svg desc')?.textContent.includes('outlined offer maxAssets bar') && document.querySelector('.ladder-graphic svg desc')?.textContent.includes('nested allocation fill')"
    ),
    'ladder SVG is missing an accessible title or description'
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
    const area = document.querySelector('#ladder-import')
    const drop = document.querySelector('#ladder-import-drop')
    const file = document.querySelector('#ladder-import-file')
    const text = document.querySelector('#ladder-import-text')
    const apply = document.querySelector('#apply-ladder-import')
    const status = document.querySelector('#ladder-import-status')
    const envTab = document.querySelector('#tab-ladder-env')
    const envOutput = document.querySelector('#export-ladder-env')
    const initial = envOutput?.value
    const accessible = Boolean(
      area && drop && file && text && apply && status && envTab && envOutput &&
      file.accept.includes('.json') && text.getAttribute('aria-describedby')?.includes('ladder-import-help') &&
      status.getAttribute('role') === 'status' && drop.tabIndex === 0
    )
    const documentedCopy = area.textContent
    const documentedShapes = documentedCopy.includes('LADDER_MARKETS array') &&
      documentedCopy.includes('one exact ladder object') &&
      documentedCopy.includes('JSON string literal') &&
      documentedCopy.includes('either') &&
      !documentedCopy.includes('full playground JSON export')
    text.value = initial
    apply.click()
    await new Promise(resolve => requestAnimationFrame(resolve))
    const pasteApplied = status.dataset.status === 'ok' && status.textContent.includes('1 ladder') &&
      document.querySelectorAll('#controls .market-card:has([data-field=quotePremiumBps])').length === 1 &&
      document.querySelectorAll('.ladder-market').length === 1 &&
      document.querySelector('#quick-market-select').options.length === 1 &&
      document.querySelector('[data-quick-field=marketId]').value === JSON.parse(initial)[0].marketId
    text.value = JSON.stringify(initial)
    apply.click()
    const stringLiteralApplied = status.dataset.status === 'ok' && envOutput.value === initial
    const beforeShapeFailure = envOutput.value
    text.value = JSON.stringify({ LADDER_MARKETS: JSON.parse(initial) })
    apply.click()
    const wrapperRejected = status.dataset.status === 'error' && envOutput.value === beforeShapeFailure
    const originalGraphic = document.querySelector('.ladder-graphic svg')?.outerHTML
    const modified = JSON.parse(initial)
    modified[0].quotePremiumBps = '25'
    text.value = JSON.stringify(modified)
    apply.click()
    const previewUpdated = envOutput.value === JSON.stringify(modified) &&
      document.querySelector('.ladder-graphic svg')?.outerHTML !== originalGraphic &&
      document.querySelector('[data-quick-field=quotePremiumBps]').value === '25' &&
      getComputedStyle(document.querySelector('.monitor-surface')).position === 'sticky'
    text.value = initial
    apply.click()
    const roundTripRestored = envOutput.value === initial &&
      document.querySelector('.ladder-graphic svg')?.outerHTML === originalGraphic
    const beforeFailure = envOutput.value
    const beforeGraphic = document.querySelector('.ladder-graphic svg')?.outerHTML
    const duplicate = initial.replace('{', '{"marketId":"0x' + '5'.repeat(64) + '",')
    text.value = duplicate
    apply.click()
    const duplicatePasteRejected = status.dataset.status === 'error' &&
      status.textContent === 'Import contains duplicate JSON member names' &&
      envOutput.value === beforeFailure && document.querySelector('.ladder-graphic svg')?.outerHTML === beforeGraphic
    text.value = JSON.stringify([{ marketId: '0x' + '5'.repeat(64), rungCount: '0' }])
    apply.click()
    const atomicFailure = status.dataset.status === 'error' && status.textContent.includes('ladder[0]') &&
      envOutput.value === beforeFailure && document.querySelector('.ladder-graphic svg')?.outerHTML === beforeGraphic
    text.value = 'x'.repeat(131073)
    apply.click()
    const oversizedRejected = status.dataset.status === 'error' && status.textContent.includes('128 KiB') &&
      envOutput.value === beforeFailure
    const dropFiles = files => {
      const transfer = new DataTransfer()
      for (const candidate of files) transfer.items.add(candidate)
      drop.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }
    drop.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }))
    const dragStateVisible = drop.classList.contains('is-dragging')
    drop.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true }))
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
    text.value = initial
    apply.click()
    envTab.click()
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { copied = value } }, configurable: true })
    document.querySelector('#copy-export').click()
    await new Promise(resolve => setTimeout(resolve, 0))
    const exactCopy = copied === initial && !copied.includes('\\n') && !copied.startsWith('LADDER_MARKETS=')
    document.querySelector('#tab-yaml').click()
    return {
      accessible,
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
      mimeRejected,
      multipleRejected,
      exactCopy
    }
  })()`)
  assert(
    Object.values(ladderJsonIo).every(Boolean),
    `ladder JSON import/export failed: ${JSON.stringify(ladderJsonIo)}`
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
  await captureImportViewport('/tmp/morpho-bots-pr122-ladder-jsonio-desktop.png')
  await command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true
  })
  await captureImportViewport(
    '/tmp/morpho-bots-pr122-ladder-jsonio-mobile-drop.png',
    '#ladder-import-drop',
    'center'
  )
  await captureImportViewport(
    '/tmp/morpho-bots-pr122-ladder-jsonio-mobile.png',
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

  const stickyGeometryAt = async ({ width, height, mobile }) => {
    await command('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile
    })
    return evaluate(`(async () => {
      const monitor = document.querySelector('.monitor-surface')
      const representativeControls = selector => {
        const controls = [...document.querySelectorAll(selector)]
        return [controls[0], controls[Math.floor(controls.length / 2)], controls.at(-1)]
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
      const css = getComputedStyle(monitor)
      const stickyTop = Number.parseFloat(css.top)
      const ancestors = []
      for (let ancestor = monitor.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor)
        ancestors.push({ tag: ancestor.tagName, className: ancestor.className, overflow: style.overflow, overflowY: style.overflowY })
      }
      for (const [index, target] of targets.entries()) {
        target.focus({ preventScroll: true })
        target.scrollIntoView({ block: ${mobile ? "'center'" : "'nearest'"} })
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        const before = monitor.getBoundingClientRect()
        const focusedBefore = target.getBoundingClientRect()
        const scrollBefore = scrollY
        const spread = document.querySelector('.market-card:has([data-field=quotePremiumBps]) [data-field=spreadBps]')
        const oldLabel = document.querySelector('.spread-gap-label')?.textContent
        const oldValue = spread.value
        spread.value = oldValue === '180' ? '200' : '180'
        spread.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise(resolve => requestAnimationFrame(resolve))
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
          focusedVisible: focusedAfter.top >= Math.max(0, ${mobile} ? after.bottom : 0) - 1 && focusedAfter.bottom <= innerHeight + 1,
          focusRetained: document.activeElement === target,
          monitorStable: Math.abs(after.top - before.top) <= 2,
          graphicChanged: document.querySelector('.spread-gap-label')?.textContent !== oldLabel,
          horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
          focusedBefore: { top: focusedBefore.top, bottom: focusedBefore.bottom },
          focusedAfter: { top: focusedAfter.top, bottom: focusedAfter.bottom }
        })
      }
      const ladderScroll = document.querySelector('.ladder-scroll')
      const exportButton = document.querySelector('#copy-export')
      exportButton.scrollIntoView({ block: 'center' })
      await new Promise(resolve => requestAnimationFrame(resolve))
      const exportRect = exportButton.getBoundingClientRect()
      return {
        width: ${width},
        height: ${height},
        mobile: ${mobile},
        cssPosition: css.position,
        cssMaxHeight: css.maxHeight,
        monitorParent: monitor.parentElement?.className,
        domOrderLogical: Boolean(monitor.compareDocumentPosition(document.querySelector('#controls')) & Node.DOCUMENT_POSITION_FOLLOWING),
        ancestors,
        measurements,
        ladderIndependent: Boolean(ladderScroll) && ['auto', 'scroll'].includes(getComputedStyle(ladderScroll).overflowY),
        exportAccessible: exportRect.top >= 0 && exportRect.bottom <= innerHeight && document.elementFromPoint(exportRect.left + 4, exportRect.top + 4)?.closest('#copy-export') === exportButton,
        documentWidth: document.documentElement.scrollWidth
      }
    })()`)
  }
  const stickyMatrix = []
  for (const viewport of [
    { width: 1440, height: 900, mobile: false },
    { width: 1024, height: 768, mobile: false },
    { width: 390, height: 844, mobile: true }
  ])
    stickyMatrix.push(await stickyGeometryAt(viewport))
  assert(
    stickyMatrix.every(
      result =>
        result.cssPosition === 'sticky' &&
        result.monitorParent.includes('workbench') &&
        result.domOrderLogical &&
        result.ladderIndependent &&
        result.documentWidth <= result.width &&
        result.ancestors.every(
          ancestor => !['auto', 'scroll', 'hidden', 'clip'].includes(ancestor.overflowY)
        ) &&
        result.measurements.every(
          measurement =>
            measurement.pageScroll > 0 &&
            Math.abs(measurement.top - measurement.stickyTop) <= 2 &&
            measurement.bottom <= result.height + 1 &&
            measurement.height < result.height &&
            Math.abs(measurement.pageJump) <= 2 &&
            measurement.focusedVisible &&
            measurement.focusRetained &&
            measurement.monitorStable &&
            measurement.graphicChanged &&
            measurement.horizontalOverflow <= 0
        ) &&
        result.exportAccessible
    ),
    `sticky workbench geometry failed: ${JSON.stringify(stickyMatrix)}`
  )
  console.log(`sticky geometry: ${JSON.stringify(stickyMatrix)}`)

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
      width: 1440,
      height: 900,
      mobile: false,
      path: '/tmp/morpho-bots-pr122-sticky-1440x900.png'
    },
    {
      width: 1024,
      height: 768,
      mobile: false,
      path: '/tmp/morpho-bots-pr122-sticky-1024x768.png'
    },
    {
      width: 390,
      height: 844,
      mobile: true,
      path: '/tmp/morpho-bots-pr122-sticky-390x844.png'
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
    '/tmp/morpho-bots-pr122-quick-edit-desktop.png',
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
    '/tmp/morpho-bots-pr122-quick-edit-mobile.png',
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
  await capture('/tmp/morpho-bots-pr122-ladder-default-desktop.png')

  const parameterProof = await evaluate(`(() => {
    const result = {}
    const input = field => document.querySelector(\`.market-card:has([data-field=quotePremiumBps]) [data-field=\${field}]\`)
    const set = (field, value) => {
      const element = input(field)
      element.value = value
      element.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const callout = field => document.querySelector(\`[data-parameter~=\${field}].ladder-callout dd\`)?.textContent ?? ''
    set('minimumRateBps', '0')
    set('maximumRateBps', '2000')
    const allowlist = document.querySelector('[data-field=MARKET_IDS]')
    const secondMarket = '0x' + '6'.repeat(64)
    allowlist.value += ',' + secondMarket
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
    result.groupMode = callout('groupMode').includes('side-wide shared cap') && callout('groupMode').includes('Reduce-only 10,000,000,000') && callout('groupMode').includes('Lend 10,000,000,000') && perBookCaps.map(rung => rung.getAttribute('width')).join('|') !== sharedCapWidths && perBookCaps.every(rung => rung.dataset.offerMaxAssets === '10000000000') && perBookCaps.map(rung => rung.dataset.allocationAssets).join('|') === '3333333334|3333333333|3333333333|3333333333|3333333333|3333333334' && [...document.querySelectorAll('.rung-table tbody tr')].every(row => row.cells[2]?.textContent && row.cells[3]?.textContent === '10000000000')
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
    reference.value = '510'
    reference.dispatchEvent(new Event('input', { bubbles: true }))
    result.referenceRateBps = document.querySelector('.reference-label')?.textContent === 'REFERENCE 510'
    reference.value = '500'
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
      element.value = value
      element.dispatchEvent(new Event('input', { bubbles: true }))
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
    input.value = ''
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
    const set = (field, value) => { const element=input(field); element.value=String(value); element.dispatchEvent(new Event('input',{bubbles:true})) }
    const results = []
    for (const power of [100, 308, 400]) {
      const unit = BigInt('1' + '0'.repeat(power))
      set('minimumRateBps', '0')
      set('maximumRateBps', String(unit * 8n))
      set('spreadBps', String(unit * 2n))
      set('stepBps', String(unit))
      const reference=document.querySelector('#preview-reference'); reference.value=String(unit * 4n); reference.dispatchEvent(new Event('input',{bubbles:true}))
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
    const practicalReference=document.querySelector('#preview-reference'); practicalReference.value='4'; practicalReference.dispatchEvent(new Event('input',{bubbles:true}))
    const practicalInvalid = document.querySelector('.ladder-invalid[role=img]')?.getAttribute('aria-label')?.includes('32768px practical plot-height limit') && document.querySelector('#ladder-status').dataset.status==='error' && document.querySelector('#validation-errors').hidden && !document.querySelector('#copy-export').disabled && [...document.querySelectorAll('#export-yaml,#export-shell,#export-json')].every(output => output.dataset.invalid==='false' && !output.value.match(/NaN|Infinity/))
    set('spreadBps', '200'); set('stepBps', '100'); set('minimumRateBps', '200'); set('maximumRateBps', '800')
    const reference=document.querySelector('#preview-reference'); reference.value='500'; reference.dispatchEvent(new Event('input',{bubbles:true}))
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
    const set = (field, value) => { const element=input(field); element.value=String(value); element.dispatchEvent(new Event('input',{bubbles:true})) }
    set('minimumRateBps', '200')
    set('maximumRateBps', '800')
    set('groupMode', 'per-book')
  })()`)
  await capture('/tmp/morpho-bots-pr122-perbook-default-desktop.png')

  const configureDensity = async rungCount =>
    evaluate(`(() => {
      const input = field => document.querySelector(\`.market-card:has([data-field=quotePremiumBps]) [data-field=\${field}]\`)
      const set = (field, value) => { const element=input(field); element.value=String(value); element.dispatchEvent(new Event('input',{bubbles:true})) }
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
        svgWidth:document.querySelector('.ladder-scroll svg').getBoundingClientRect().width
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
  await capture('/tmp/morpho-bots-pr122-ladder-32-desktop.png')

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
      mobileLayout.monitorBounded,
    `mobile layout overflows its viewport or quick controls are unusable: ${JSON.stringify(mobileLayout)}`
  )
  assert(
    density32Mobile.minGap >= 28 &&
      density32Mobile.minimumLabelPx >= 11 &&
      density32Mobile.svgWidth >= 1120,
    `32-rung mobile density is unreadable: ${JSON.stringify(density32Mobile)}`
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
      density512Mobile.contentHeight > density512Mobile.viewportHeight,
    '512-rung chart is not a bounded readable scroll viewport'
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
      density512Desktop.minimumLabelPx >= 11,
    `512-rung desktop density is unreadable: ${JSON.stringify(density512Desktop)}`
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
  await capture('/tmp/morpho-bots-pr122-ladder-default-mobile.png')
  await evaluate(
    `(() => { const input=document.querySelector('.market-card:has([data-field=quotePremiumBps]) [data-field=groupMode]'); input.value='per-book'; input.dispatchEvent(new Event('input',{bubbles:true})) })()`
  )
  assert(
    await evaluate(
      "[...document.querySelectorAll('.offer-cap-bar')].every(rung => rung.dataset.offerMaxAssets === '10000000000')"
    ),
    'per-book mobile screenshot state does not preserve side-wide maxAssets semantics'
  )
  await capture('/tmp/morpho-bots-pr122-perbook-default-mobile.png')
  await command('Emulation.clearDeviceMetricsOverride')
  console.log(
    `density 32 desktop/mobile: ${JSON.stringify({ desktop: density32Desktop, mobile: density32Mobile })}`
  )
  console.log(
    `density 512 desktop/mobile: ${JSON.stringify({ desktop: density512Desktop, mobile: density512Mobile })}`
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

  const secretProof = await evaluate(`(async () => {
    const values = {
      MAKER_PRIVATE_KEY: '0x' + '9'.repeat(64),
      BETTERSTACK_SOURCE_TOKEN: 'browser-secret-source-token',
      RPC_URL: 'https://rpc-user:rpc-password@rpc.example.test/path?api_key=query-secret#fragment',
      REFERENCE_RPC_URL: 'https://archive-user:archive-password@archive.example.test/path?token=archive-secret'
    }
    const set = (field, value) => {
      const input = document.querySelector(\`[data-field=\${field}]\`)
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    for (const [field, value] of Object.entries(values)) set(field, value)
    set('BETTERSTACK_INGESTING_HOST', 'logs.example.test')
    const outputs = () => [...document.querySelectorAll('[role=tabpanel] textarea')].map(output => output.value).join('\\n')
    const credentials = Object.values(values)
    const defaultRedacted = credentials.every(value => !outputs().includes(value)) && outputs().includes('<redacted>')
    const noGraphicOrWarningLeak = ![...document.querySelectorAll('.ladder-market *,#observability-status *,#ladder-status')].some(element => element.textContent && credentials.some(value => element.textContent.includes(value)) || [...element.attributes].some(attribute => credentials.some(value => attribute.value.includes(value))))
    const passwordInputs = Object.keys(values).every(field => document.querySelector(\`[data-field=\${field}]\`)?.type === 'password')
    const toggle = document.querySelector('#include-sensitive-values')
    toggle.checked = true
    toggle.dispatchEvent(new Event('change', { bubbles: true }))
    const deliberatelyRevealed = Object.keys(values).every(field => document.querySelector(\`[data-field=\${field}]\`)?.type === 'text' && document.querySelector(\`[data-field=\${field}]\`)?.value === values[field])
    const yaml = document.querySelector('#export-yaml').value
    const shell = document.querySelector('#export-shell').value
    const json = document.querySelector('#export-json').value
    const included = [values.MAKER_PRIVATE_KEY, values.RPC_URL, values.REFERENCE_RPC_URL].every(value => yaml.includes(value)) && credentials.every(value => shell.includes(value) && json.includes(value))
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { copied = value } }, configurable: true })
    document.querySelector('#tab-json').click()
    document.querySelector('#copy-export').click()
    await new Promise(resolve => setTimeout(resolve, 0))
    const clipboardIncluded = credentials.every(value => copied.includes(value))
    toggle.checked = false
    toggle.dispatchEvent(new Event('change', { bubbles: true }))
    document.querySelector('#copy-export').click()
    await new Promise(resolve => setTimeout(resolve, 0))
    const reRedacted = credentials.every(value => !outputs().includes(value) && !copied.includes(value)) && copied.includes('<redacted>')
    const hiddenAgain = Object.keys(values).every(field => document.querySelector(\`[data-field=\${field}]\`)?.type === 'password' && document.querySelector(\`[data-field=\${field}]\`)?.value === values[field])
    set('MAKER_PRIVATE_KEY', '0x' + 'a'.repeat(64))
    set('BETTERSTACK_SOURCE_TOKEN', '')
    set('BETTERSTACK_INGESTING_HOST', '')
    set('RPC_URL', 'https://base-rpc.example')
    set('REFERENCE_RPC_URL', 'https://base-archive-rpc.example')
    return { defaultRedacted, noGraphicOrWarningLeak, passwordInputs, deliberatelyRevealed, included, clipboardIncluded, reRedacted, hiddenAgain }
  })()`)
  assert(
    Object.values(secretProof).every(Boolean),
    `sensitive export proof failed: ${JSON.stringify(secretProof)}`
  )

  const previewIsolationProof = await evaluate(`(async () => {
    const copied = []
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { copied.push(value) } }, configurable: true })
    const reference = document.querySelector('#preview-reference')
    const exportBaseline = [...document.querySelectorAll('#export-yaml,#export-shell,#export-json')].map(output => output.value)
    const baselineRedacted = exportBaseline.every(payload => payload.includes('<redacted>')) &&
      exportBaseline.every(payload => !payload.includes('browser-secret-source-token') && !payload.includes('rpc-password') && !payload.includes('archive-password'))
    const prove = async value => {
      reference.value = value
      reference.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
      const outputs = [...document.querySelectorAll('#export-yaml,#export-shell,#export-json')]
      const validExports = outputs.every((output, index) => output.dataset.invalid === 'false' && output.value === exportBaseline[index])
      const previewInvalid = document.querySelector('#ladder-status').dataset.status === 'error' && document.querySelector('.ladder-invalid[role=img]')?.getAttribute('aria-label')?.includes('Invalid ladder graphic') && document.querySelectorAll('.ladder-rung').length === 0
      const positiveError = value !== '0' && value !== '-1' || document.querySelector('.ladder-invalid[role=img]')?.getAttribute('aria-label')?.includes('referenceRateBps must be positive')
      const exportUiValid = document.querySelector('#validation-errors').hidden && !document.querySelector('#copy-export').disabled
      for (const id of ['tab-yaml', 'tab-shell', 'tab-json']) {
        document.querySelector('#' + id).click()
        document.querySelector('#copy-export').click()
        await new Promise(resolve => setTimeout(resolve, 0))
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
    const set = (field, value) => {
      const input = document.querySelector(\`[data-field=\${field}]\`)
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set('CHAIN_ID', '  8453  ')
    set('NATIVE_RESERVE_WEI', '0')
    set('MAXIMUM_LEND_EXPOSURE_ASSETS', '0')
    await new Promise(resolve => setTimeout(resolve, 0))
    const yaml = document.querySelector('#export-yaml').value
    const shell = document.querySelector('#export-shell').value
    const json = JSON.parse(document.querySelector('#export-json').value)
    const exportState = [...document.querySelectorAll('#export-yaml,#export-shell,#export-json')].every(output => output.dataset.invalid === 'false') && yaml.includes('  id: 8453\\n') && yaml.includes('  nativeReserveWei: "0"\\n') && yaml.includes('  maximumLendExposureAssets: "0"\\n') && shell.includes("export CHAIN_ID='8453'") && json.configuration.CHAIN_ID === '8453' && json.configuration.NATIVE_RESERVE_WEI === '0' && json.configuration.MAXIMUM_LEND_EXPOSURE_ASSETS === '0'
    const uiState = document.querySelector('[data-field=CHAIN_ID]').value === '  8453  ' && document.querySelector('[data-field=NATIVE_RESERVE_WEI]').value === '0' && document.querySelector('[data-field=MAXIMUM_LEND_EXPOSURE_ASSETS]').value === '0' && document.querySelector('#validation-errors').hidden && !document.querySelector('#copy-export').disabled && document.querySelector('#ladder-status').dataset.status === 'ok' && document.querySelectorAll('.ladder-rung').length > 0
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { copied = value } }, configurable: true })
    document.querySelector('#tab-json').click()
    document.querySelector('#copy-export').click()
    await new Promise(resolve => setTimeout(resolve, 0))
    const copyState = JSON.parse(copied).configuration.CHAIN_ID === '8453'
    return { exportState, uiState, copyState }
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
    `(() => { const input=document.querySelector('[data-field=MARKET_IDS]'); if (!input.value.includes('${secondMarket}')) input.value += ',${secondMarket}'; input.dispatchEvent(new Event('input',{bubbles:true})); const firstLadder=document.querySelector('.market-card:has([data-field=quotePremiumBps]) [data-field=loopIntervalSeconds]'); firstLadder.value='60'; firstLadder.dispatchEvent(new Event('input',{bubbles:true})); [...document.querySelectorAll('button')].find(button=>button.textContent==='Add ladder market').click(); const ladderCards=[...document.querySelectorAll('.market-card:has([data-field=quotePremiumBps])')]; const added=ladderCards.at(-1); const input2=added.querySelector('[data-field=marketId]'); input2.value='${secondMarket}'; input2.dispatchEvent(new Event('input',{bubbles:true})); const interval2=added.querySelector('[data-field=loopIntervalSeconds]'); interval2.value='30'; interval2.dispatchEvent(new Event('input',{bubbles:true})); [...added.querySelectorAll('button')].find(button=>button.textContent==='Move up').click(); })()`
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
  const quickMarketProof = await evaluate(`(() => {
    const select = document.querySelector('#quick-market-select')
    const firstIdentity = document.querySelector('[data-quick-field=marketId]').value === '${secondMarket}' &&
      document.querySelector('[data-quick-field=loopIntervalSeconds]').value === '30'
    const orderedOptions = [...select.options].map(option => option.textContent).join('|')
    select.value = '1'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    const switched = document.querySelector('#quick-market-select').value === '1' &&
      document.querySelector('[data-quick-field=marketId]').value === '0x${'5'.repeat(64)}' &&
      document.querySelector('[data-quick-field=loopIntervalSeconds]').value === '60'
    const currentSelect = document.querySelector('#quick-market-select')
    currentSelect.value = '0'
    currentSelect.dispatchEvent(new Event('change', { bubbles: true }))
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
    const valuesCorrect = !yaml.includes('BETTERSTACK_') && !yaml.includes('browser-warning-secret-token') && shell.includes("export BETTERSTACK_SOURCE_TOKEN='<redacted>'") && shell.includes("export BETTERSTACK_HEARTBEAT_URL='javascript:https://secret.example/heartbeat-token'") && !json.includes('browser-warning-secret-token') && JSON.parse(json).observability.BETTERSTACK_SOURCE_TOKEN === '<redacted>'
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { copied = value } }, configurable: true })
    document.querySelector('#tab-json').click()
    document.querySelector('#copy-export').click()
    await new Promise(resolve => setTimeout(resolve, 0))
    const copyAvailableAndRedacted = copied.includes('<redacted>') && !copied.includes('browser-warning-secret-token')
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
    "Object.defineProperty(navigator, 'clipboard', {value: undefined, configurable: true}); document.execCommand=()=>false; document.querySelector('#copy-export').disabled=false; document.querySelector('#copy-export').click()"
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

  const quickDeleteProof = await evaluate(`(() => {
    const firstCard = document.querySelector('.market-card:has([data-field=quotePremiumBps])')
    const step = firstCard.querySelector('[data-field=stepBps]')
    step.value = '100'
    step.dispatchEvent(new Event('input', { bubbles: true }))
    const remove = [...firstCard.querySelectorAll('button')].find(button => button.textContent === 'Remove ladder')
    remove.click()
    return {
      oneMarket: document.querySelectorAll('.market-card:has([data-field=quotePremiumBps])').length === 1 &&
        document.querySelectorAll('.ladder-market').length === 1,
      selectedFallback: document.querySelector('#quick-market-select').options.length === 1 &&
        document.querySelector('#quick-market-select').value === '0' &&
        document.querySelector('[data-quick-field=marketId]').value === '0x${'5'.repeat(64)}',
      exportUpdated: JSON.parse(document.querySelector('#export-ladder-env').value).length === 1
    }
  })()`)
  assert(
    Object.values(quickDeleteProof).every(Boolean),
    `quick market delete fallback failed: ${JSON.stringify(quickDeleteProof)}`
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
    'Document.cookie'
  ]
  assert(
    JSON.stringify(persistenceInstrumentation) ===
      JSON.stringify(expectedPersistenceInstrumentation),
    `persistence instrumentation coverage mismatch: ${JSON.stringify(persistenceInstrumentation)}`
  )
  const persistenceAccesses = await evaluate('globalThis.__persistenceAccesses')
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
  const securityTranscript = [...requests, ...consoleMessages].join('\n')
  for (const marker of [
    'rpc-password',
    'query-secret',
    'archive-password',
    'archive-secret',
    'browser-secret-source-token',
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
  assert(consoleErrors.length === 0, `browser console errors: ${consoleErrors.join('; ')}`)
  console.log(`browser smoke: PASS (${requests.length} local requests, 0 unexpected requests)`)
} finally {
  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
  await cleanup()
}
