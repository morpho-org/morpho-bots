import { mkdtempSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  closeOwnedProcessTreeGracefully,
  discoverChromium,
  prepareFreshDist,
  spawnOwnedProcess,
  startStaticServer,
  terminateOwnedProcessTree
} from './playground-smoke-support.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const shutdown = new AbortController()
const ownedDirectories = new Set([join(root, 'playground/dist')])
const children = new Set()
let server
let cleanupPromise
let terminatingSignal
let browser
let browserSocket
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
  (cleanupPromise ??= (async () => {
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
  })())
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

const waitFor = async operation => {
  let lastError
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (error.fatal) throw error
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  throw lastError
}

const assert = (condition, message) => {
  if (!condition) throw new Error(message)
}

try {
  const chromiumPath = await discoverChromium()
  const preparedDist = await prepareFreshDist({
    root,
    onDistCreated: directory => ownedDirectories.add(directory),
    onBuildProcess: trackChild,
    onTempCreated: waitAtTempCreationBoundary,
    signal: shutdown.signal
  })
  const dist = preparedDist.dist
  const userDataDir = await createOwnedTempDirectory('market-making-playground-')
  const startedServer = await startStaticServer(dist)
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

  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}`)
    if (!response.ok) throw new Error('server not ready')
  })
  const debuggingPort = await waitFor(async () => {
    if (browserSpawnError || browser.exitCode !== null) {
      const detail = browserSpawnError?.message ?? `exit code ${browser.exitCode}`
      const error = new Error(
        `Chromium failed before exposing its debugging port (${detail}). ${browserStderr.trim()}`
      )
      error.fatal = true
      throw error
    }
    const [portText] = (await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8')).split(
      /\r?\n/
    )
    const discoveredPort = Number(portText)
    if (!Number.isInteger(discoveredPort) || discoveredPort <= 0) {
      throw new Error(`invalid Chromium debugging port: ${portText}`)
    }
    return discoveredPort
  })
  const target = await waitFor(async () => {
    const response = await fetch(
      `http://127.0.0.1:${debuggingPort}/json/new?http://127.0.0.1:${port}`,
      {
        method: 'PUT'
      }
    )
    if (!response.ok) throw new Error('browser not ready')
    return response.json()
  })
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  browserSocket = socket
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  browserReady = true
  console.log(
    `smoke environment: appPort=${port} chromiumDebugPort=${debuggingPort} chromium=${chromiumPath}`
  )
  let id = 0
  const pending = new Map()
  const requests = []
  const consoleErrors = []
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url)
    if (message.method === 'Runtime.exceptionThrown')
      consoleErrors.push(message.params.exceptionDetails.text)
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error')
      consoleErrors.push(message.params.entry.text)
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    }
  })
  const command = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const messageId = ++id
      pending.set(messageId, { resolve, reject })
      socket.send(JSON.stringify({ id: messageId, method, params }))
    })
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
  await command('Page.navigate', { url: `http://127.0.0.1:${port}` })
  await waitFor(async () => {
    if (!(await evaluate("document.documentElement.dataset.playgroundReady === 'true'"))) {
      throw new Error('playground not ready')
    }
  })

  assert(
    await evaluate(
      `document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content.includes("connect-src 'none'") === true`
    ),
    "playground CSP does not block network connections with connect-src 'none'"
  )
  assert(
    await evaluate("document.querySelectorAll('.ladder-market').length === 1"),
    'initial ladder was not rendered immediately'
  )
  assert(
    await evaluate(
      "document.querySelector('main > .monitor-surface #ladders') && document.querySelector('main > .configure-surface #controls') && document.querySelector('.monitor-surface').getBoundingClientRect().width >= 1300"
    ),
    'monitor/configure hierarchy is missing or ladder monitor is not full-width'
  )
  assert(
    await evaluate(
      "document.querySelector('#include-sensitive-values')?.checked === false && document.querySelector('#include-sensitive-warning')?.textContent.includes('private credentials')"
    ),
    'sensitive export opt-in is not explicit, unchecked, and warned'
  )
  assert(
    await evaluate(
      "document.querySelector('.ladder-scroll') && document.querySelector('.rung-table:not([hidden])') && getComputedStyle(document.querySelector('.rung-table')).display !== 'none' && document.querySelectorAll('.rung-table tbody tr').length === 6"
    ),
    'exact semantic rung enumeration is unavailable to assistive technology'
  )
  assert(
    await evaluate(
      "document.querySelector('.ladder-graphic svg[role=img] title')?.textContent.includes('Ladder market 1') && document.querySelector('.ladder-graphic svg desc')?.textContent.includes('higher-rate lend')"
    ),
    'ladder SVG is missing an accessible title or description'
  )
  assert(
    await evaluate(
      "document.querySelectorAll('.ladder-rung').length === 6 && [...document.querySelectorAll('.ladder-rung')].every(rung => rung.dataset.rateBps && rung.dataset.assets && rung.dataset.side && Number.isFinite(Number(rung.getAttribute('y'))))"
    ),
    'ladder did not expose exact rung values and SVG geometry'
  )
  assert(
    await evaluate(
      "['marketId','quotePremiumBps','spreadBps','stepBps','rungCount','sizeSkewBps','lowerRateBudgetAssets','higherRateBudgetAssets','targetMarketExposureAssets','maximumTotalExposureAssets','minimumOfferAssets','groupMode','loopIntervalSeconds','movementToleranceBps','minimumRateBps','maximumRateBps','referenceRateBps'].every(key => document.querySelector(`[data-parameter~=${key}]`))"
    ),
    'not every ladder parameter is visibly mapped into the graphic'
  )
  assert(
    await evaluate(
      "document.querySelectorAll('.ladder-callout').length === 8 && document.querySelector('.ladder-legend').textContent.includes('not live offers')"
    ),
    'graphic callouts or stateless legend are missing'
  )
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
    const lowerAssets = document.querySelector('.ladder-rung[data-side=lower]')?.dataset.assets
    set('lowerRateBudgetAssets', '9000000000')
    result.lowerRateBudgetAssets = document.querySelector('.ladder-rung[data-side=lower]')?.dataset.assets !== lowerAssets
    set('lowerRateBudgetAssets', '10000000000')
    const higherAssets = document.querySelector('.ladder-rung[data-side=higher]')?.dataset.assets
    set('higherRateBudgetAssets', '9000000000')
    result.higherRateBudgetAssets = document.querySelector('.ladder-rung[data-side=higher]')?.dataset.assets !== higherAssets
    set('higherRateBudgetAssets', '10000000000')
    set('targetMarketExposureAssets', '9000000000')
    result.targetMarketExposureAssets = document.querySelector('.ladder-rung[data-side=higher]')?.dataset.assets !== higherAssets
    set('targetMarketExposureAssets', '20000000000')
    set('maximumTotalExposureAssets', '9000000000')
    result.maximumTotalExposureAssets = document.querySelector('.ladder-rung[data-side=lower]')?.dataset.assets !== lowerAssets
    set('maximumTotalExposureAssets', '30000000000')
    set('minimumOfferAssets', '4000000000')
    result.minimumOfferAssets = document.querySelectorAll('.ladder-rung').length < 6
    set('minimumOfferAssets', '101000000')
    set('groupMode', 'per-book')
    result.groupMode = callout('groupMode') === 'per-book'
    set('groupMode', 'shared-rung')
    set('loopIntervalSeconds', '30')
    result.loopIntervalSeconds = callout('loopIntervalSeconds').includes('30s loop')
    set('loopIntervalSeconds', '60')
    set('movementToleranceBps', '20')
    result.movementToleranceBps = callout('movementToleranceBps').includes('20 BPS deadband')
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
        minimumLabelPx:Math.min(...['.rung-rate','.rung-details','.axis-label','.spread-gap-label'].map(selector=>parseFloat(getComputedStyle(document.querySelector(selector)).fontSize))),
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
  assert(
    await evaluate(
      "document.documentElement.scrollWidth <= 390 && document.querySelector('.ladder-scroll').clientWidth <= 358"
    ),
    'mobile layout overflows its viewport'
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
    set('minimumOfferAssets','101000000'); set('minimumRateBps','200'); set('maximumRateBps','800')
    const reference=document.querySelector('#preview-reference');reference.value='500';reference.dispatchEvent(new Event('input',{bubbles:true}))
  })()`)
  await capture('/tmp/morpho-bots-pr122-ladder-default-mobile.png')
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
      "document.activeElement.id === 'tab-json' && document.querySelector('#tab-json').getAttribute('aria-selected') === 'true' && !document.querySelector('#panel-json').hidden && document.querySelector('#panel-yaml').hidden"
    ),
    'End key did not activate the final tab and hide inactive panels'
  )
  await evaluate(
    "document.querySelector('#tab-json').dispatchEvent(new KeyboardEvent('keydown', {key:'Home', bubbles:true}))"
  )
  assert(
    await evaluate("document.activeElement.id === 'tab-yaml'"),
    'Home key did not activate the first tab'
  )

  const secretProof = await evaluate(`(async () => {
    const privateKey = '0x' + '9'.repeat(64)
    const sourceToken = 'browser-secret-source-token'
    const set = (field, value) => {
      const input = document.querySelector(\`[data-field=\${field}]\`)
      input.value = value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    set('MAKER_PRIVATE_KEY', privateKey)
    set('BETTERSTACK_SOURCE_TOKEN', sourceToken)
    set('BETTERSTACK_INGESTING_HOST', 'logs.example.test')
    const outputs = () => [...document.querySelectorAll('[role=tabpanel] textarea')].map(output => output.value).join('\\n')
    const defaultRedacted = !outputs().includes(privateKey) && !outputs().includes(sourceToken) && outputs().includes('<redacted>')
    const noDomLeak = !document.body.textContent.includes(privateKey) && !document.body.textContent.includes(sourceToken) && ![...document.querySelectorAll('.ladder-market *')].some(element => [...element.attributes].some(attribute => attribute.value.includes(privateKey) || attribute.value.includes(sourceToken)))
    const passwordInputs = [...document.querySelectorAll('[data-field=MAKER_PRIVATE_KEY],[data-field=BETTERSTACK_SOURCE_TOKEN]')].every(input => input.type === 'password')
    const toggle = document.querySelector('#include-sensitive-values')
    toggle.checked = true
    toggle.dispatchEvent(new Event('change', { bubbles: true }))
    const included = [...document.querySelectorAll('#export-yaml,#export-shell,#export-json')].every((output, index) => index === 0 ? output.value.includes(privateKey) : output.value.includes(privateKey) && output.value.includes(sourceToken))
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { copied = value } }, configurable: true })
    document.querySelector('#copy-export').click()
    await new Promise(resolve => setTimeout(resolve, 0))
    const clipboardIncluded = copied.includes(privateKey)
    toggle.checked = false
    toggle.dispatchEvent(new Event('change', { bubbles: true }))
    document.querySelector('#copy-export').click()
    await new Promise(resolve => setTimeout(resolve, 0))
    const rerRedacted = !outputs().includes(privateKey) && !outputs().includes(sourceToken) && !copied.includes(privateKey) && copied.includes('<redacted>')
    set('MAKER_PRIVATE_KEY', '0x' + 'a'.repeat(64))
    set('BETTERSTACK_SOURCE_TOKEN', '')
    set('BETTERSTACK_INGESTING_HOST', '')
    return { defaultRedacted, noDomLeak, passwordInputs, included, clipboardIncluded, rerRedacted }
  })()`)
  assert(
    Object.values(secretProof).every(Boolean),
    `sensitive export proof failed: ${JSON.stringify(secretProof)}`
  )

  const previewIsolationProof = await evaluate(`(async () => {
    const copied = []
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { copied.push(value) } }, configurable: true })
    const reference = document.querySelector('#preview-reference')
    const prove = async value => {
      reference.value = value
      reference.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(resolve => setTimeout(resolve, 0))
      const outputs = [...document.querySelectorAll('#export-yaml,#export-shell,#export-json')]
      const validExports = outputs.every(output => output.dataset.invalid === 'false' && !output.value.includes(value))
      const previewInvalid = document.querySelector('#ladder-status').dataset.status === 'error' && document.querySelector('.ladder-invalid[role=img]')?.getAttribute('aria-label')?.includes('Invalid ladder graphic') && document.querySelectorAll('.ladder-rung').length === 0
      const exportUiValid = document.querySelector('#validation-errors').hidden && !document.querySelector('#copy-export').disabled
      for (const id of ['tab-yaml', 'tab-shell', 'tab-json']) {
        document.querySelector('#' + id).click()
        document.querySelector('#copy-export').click()
        await new Promise(resolve => setTimeout(resolve, 0))
      }
      return { validExports, previewInvalid, exportUiValid, copiedAll: copied.splice(0).length === 3 }
    }
    const nonNumeric = await prove('not-a-number')
    const hardRange = await prove('1000000000000000000000000000000000000')
    reference.value = '500'
    reference.dispatchEvent(new Event('input', { bubbles: true }))
    return { nonNumeric, hardRange }
  })()`)
  assert(
    Object.values(previewIsolationProof).every(result => Object.values(result).every(Boolean)),
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
  await evaluate(
    `(() => { const input=document.querySelector('[data-field=MARKET_IDS]'); if (!input.value.includes('${secondMarket}')) input.value += ',${secondMarket}'; input.dispatchEvent(new Event('input',{bubbles:true})); [...document.querySelectorAll('button')].find(button=>button.textContent==='Add ladder market').click(); const markets=[...document.querySelectorAll('.market-card [data-field=marketId]')]; const input2=markets.at(-1); input2.value='${secondMarket}'; input2.dispatchEvent(new Event('input',{bubbles:true})); const cards=[...document.querySelectorAll('.market-card')]; [...cards.at(-1).querySelectorAll('button')].find(button=>button.textContent==='Move up').click(); })()`
  )
  assert(
    await evaluate("document.querySelectorAll('.ladder-market').length === 2"),
    'multiple ladder previews were not rendered'
  )
  assert(
    await evaluate(
      `JSON.parse(document.querySelector('#export-json').value).configuration.LADDER_MARKETS[0].marketId === '${secondMarket}'`
    ),
    'ladder export did not preserve reordered market order'
  )

  await evaluate(
    "(() => { const key=document.querySelector('[data-field=MAKER_PRIVATE_KEY]'); key.value='invalid'; key.dispatchEvent(new Event('input',{bubbles:true})); })()"
  )
  assert(
    await evaluate(
      "!document.querySelector('#validation-errors').hidden && document.querySelector('#validation-errors').textContent.includes('MAKER_PRIVATE_KEY') && document.querySelector('#copy-export').disabled && document.querySelector('#ladder-status').dataset.status !== 'ok' && document.querySelectorAll('.ladder-rung').length === 0 && document.querySelector('.ladder-invalid[role=img]')?.textContent.includes('Invalid ladder graphic')"
    ),
    'invalid production configuration did not invalidate every synthetic ladder preview'
  )
  await evaluate(
    `(() => { const key=document.querySelector('[data-field=MAKER_PRIVATE_KEY]'); key.value='0x${'a'.repeat(64)}'; key.dispatchEvent(new Event('input',{bubbles:true})); })()`
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
  await waitFor(async () => {
    if (
      !(await evaluate(
        "document.querySelector('#copy-status').textContent.includes('Copy was blocked')"
      ))
    )
      throw new Error('fallback status missing')
  })
  assert(
    await evaluate("document.querySelector('#copy-status').getAttribute('aria-live') === 'polite'"),
    'clipboard fallback is not announced in a live region'
  )
  assert(
    await evaluate('localStorage.length === 0 && sessionStorage.length === 0'),
    'playground persisted data'
  )

  const unexpected = requests.filter(
    url => !url.startsWith(`http://127.0.0.1:${port}/`) && !url.startsWith('data:')
  )
  assert(unexpected.length === 0, `unexpected network requests: ${unexpected.join(', ')}`)
  assert(consoleErrors.length === 0, `browser console errors: ${consoleErrors.join('; ')}`)
  console.log(`browser smoke: PASS (${requests.length} local requests, 0 unexpected requests)`)
} finally {
  process.off('SIGINT', onSignal)
  process.off('SIGTERM', onSignal)
  await cleanup()
}
