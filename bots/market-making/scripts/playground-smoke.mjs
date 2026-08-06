import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cp, mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createCdpClient,
  discoverChromium,
  openWebSocket,
  prepareFreshDist,
  waitForReadiness
} from './playground-smoke-support.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const basePath = process.env.PLAYGROUND_SMOKE_BASE_PATH ?? '/'
if (!/^\/(?:[A-Za-z0-9._-]+\/)*$/.test(basePath))
  throw new Error('Invalid PLAYGROUND_SMOKE_BASE_PATH')
const mobile = process.env.PLAYGROUND_SMOKE_VIEWPORT === 'mobile'
const owned = []
let browser
let server
let client
let socket
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const temp = async prefix => {
  const path = await mkdtemp(join(tmpdir(), prefix))
  owned.push(path)
  return path
}

try {
  const prepared = await prepareFreshDist({ root })
  owned.push(prepared.dist)
  let served = prepared.dist
  if (basePath !== '/') {
    served = await temp('playground-smoke-site-')
    const mounted = join(served, ...basePath.split('/').filter(Boolean))
    await mkdir(mounted, { recursive: true })
    await cp(prepared.dist, mounted, { recursive: true })
  }
  server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      if (!relative || relative.endsWith('/')) relative += 'index.html'
      const path = normalize(join(served, relative))
      if (!path.startsWith(`${served}/`)) throw new Error('outside root')
      const body = await readFile(path)
      response.writeHead(200, {
        'content-type': mime[extname(path)] ?? 'application/octet-stream',
        'cache-control': 'no-store'
      })
      response.end(body)
    } catch {
      response.writeHead(404).end('not found')
    }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const debugProbe = createServer()
  await new Promise(resolve => debugProbe.listen(0, '127.0.0.1', resolve))
  const debugPort = debugProbe.address().port
  await new Promise(resolve => debugProbe.close(resolve))
  const userData = await temp('playground-smoke-browser-')
  browser = spawn(
    await discoverChromium(),
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${userData}`,
      'about:blank'
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  let browserErrors = ''
  browser.stderr.on('data', chunk => {
    browserErrors += chunk
  })
  const targets = await waitForReadiness(
    async signal => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json`, { signal })
      if (!response.ok) throw new Error(`CDP ${response.status}`)
      const values = await response.json()
      const page = values.find(value => value.type === 'page')
      if (!page) throw new Error('No page target')
      return page
    },
    { description: 'Chromium CDP target', timeoutMs: 30_000, pollIntervalMs: 50 }
  )
  socket = await openWebSocket(targets.webSocketDebuggerUrl)
  const exceptions = []
  const requests = []
  client = createCdpClient(socket, {
    commandTimeoutMs: 10_000,
    onMessage: message => {
      if (message.method === 'Runtime.exceptionThrown')
        exceptions.push(message.params.exceptionDetails.text)
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error')
        exceptions.push(message.params.entry.text)
      if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url)
    }
  })
  const command = (method, params = {}) => client.command(method, params)
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
    width: mobile ? 390 : 1440,
    height: mobile ? 844 : 1000,
    deviceScaleFactor: 1,
    mobile
  })
  await command('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
    Object.defineProperty(globalThis, '__smoke', { value: { replacements: 0, copied: [], storage: [], cookies: [] } });
    const replace = history.replaceState.bind(history);
    history.replaceState = (...args) => { __smoke.replacements++; return replace(...args); };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { __smoke.copied.push(value); } } });
    for (const name of ['localStorage','sessionStorage','indexedDB','caches']) {
      try { Object.defineProperty(globalThis, name, { configurable: true, get() { __smoke.storage.push(name); throw new Error(name + ' forbidden'); } }); } catch {}
    }
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    if (cookie) Object.defineProperty(Document.prototype, 'cookie', { configurable: true, get() { __smoke.cookies.push('get'); return ''; }, set() { __smoke.cookies.push('set'); } });
  })()`
  })
  const pageUrl = `http://127.0.0.1:${port}${basePath}`
  await command('Page.navigate', { url: pageUrl })
  await waitForReadiness(
    async () => {
      assert.equal(await evaluate('document.documentElement.dataset.playgroundReady'), 'true')
    },
    { description: 'playground readiness', timeoutMs: 20_000, pollIntervalMs: 50 }
  )

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
  assert.deepEqual(baseline.storage, [])
  assert.deepEqual(baseline.cookies, [])
  assert.match(baseline.href, new RegExp(`${basePath.replaceAll('/', '\\/')}#`))

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

  const importAtomic = await evaluate(`(async () => {
    const area = document.querySelector('#collection-import'); const apply = document.querySelector('#apply-import');
    const set = value => { const old = area.value; const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; setter.call(area, value); area._valueTracker?.setValue(old); area.dispatchEvent(new Event('input', { bubbles: true })); area.dispatchEvent(new Event('change', { bubbles: true })); };
    const before = location.hash;
    set('[{"marketId":"x"},42]'); apply.click(); await new Promise(r => setTimeout(r, 20)); const mixed = location.hash === before && document.querySelector('#import-status').dataset.status === 'error';
    set('{"bootstrap":[],"bootstrap":[]}'); apply.click(); await new Promise(r => setTimeout(r, 20)); const duplicate = location.hash === before && document.querySelector('#import-status').dataset.status === 'error';
    set('42'); apply.click(); await new Promise(r => setTimeout(r, 20)); const primitive = location.hash === before && document.querySelector('#import-status').dataset.status === 'error';
    const bootstrap = JSON.parse(document.querySelector('[aria-label="Bootstrap JSON output"]').value);
    const ladder = JSON.parse(document.querySelector('[aria-label="Ladder JSON output"]').value);
    const secondId = '0x' + '6'.repeat(64);
    bootstrap.push({ ...bootstrap[0], marketId: secondId });
    ladder.push({ ...ladder[0], marketId: secondId });
    set(JSON.stringify({ bootstrap, ladder })); apply.click(); await new Promise(r => setTimeout(r, 50));
    const valid = document.querySelector('#import-status').dataset.status === 'ok' && document.querySelectorAll('[data-preview=bootstrap]').length === 2 && document.querySelectorAll('[data-preview=ladder]').length === 2;
    document.querySelectorAll('[data-market-kind=ladder]')[1].querySelector('button').click(); await new Promise(r => setTimeout(r, 50));
    const reordered = JSON.parse(document.querySelector('[aria-label="Ladder JSON output"]').value).map(x => x.marketId);
    const focus = document.activeElement.id;
    return { mixed, duplicate, primitive, valid, reordered, focus };
  })()`)
  assert.equal(importAtomic.mixed, true)
  assert.equal(importAtomic.duplicate, true)
  assert.equal(importAtomic.primitive, true)
  assert.equal(importAtomic.valid, true)
  assert.equal(importAtomic.reordered[0], `0x${'6'.repeat(64)}`)
  assert.equal(importAtomic.focus, 'ladder-0-marketId')

  const copyTabs = await evaluate(`(async () => {
    const tabs=[...document.querySelectorAll('[role=tab]')];
    for (const tab of tabs) { tab.click(); await new Promise(r=>setTimeout(r,0)); document.querySelector('[role=tabpanel]:not([hidden]) button').click(); await new Promise(r=>setTimeout(r,0)); }
    document.querySelector('#copy-share-url').click(); await new Promise(r=>setTimeout(r,0));
    tabs[0].focus(); tabs[0].dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true})); await new Promise(r=>setTimeout(r,30));
    return { copied: __smoke.copied, outputs: [...document.querySelectorAll('.exports textarea')].map(x=>x.value), selected: document.activeElement.id, active: document.querySelector('[role=tab][aria-selected=true]').id, panels: document.querySelectorAll('[role=tabpanel]').length };
  })()`)
  assert.equal(copyTabs.copied.length, 5)
  assert.equal(copyTabs.panels, 4)
  assert.equal(copyTabs.active, 'tab-ladder-string')
  assert.equal(copyTabs.selected, 'tab-ladder-string')

  const shareUrl = copyTabs.copied.at(-1)
  await command('Page.navigate', { url: shareUrl })
  await waitForReadiness(async () => assert.equal(await evaluate('location.href'), shareUrl), {
    description: 'share URL navigation',
    timeoutMs: 20_000,
    pollIntervalMs: 50
  })
  await command('Page.reload', { ignoreCache: true })
  await waitForReadiness(
    async () =>
      assert.equal(await evaluate('document.documentElement.dataset.playgroundReady'), 'true'),
    { description: 'share URL reload', timeoutMs: 20_000, pollIntervalMs: 50 }
  )
  assert.deepEqual(
    await evaluate("[...document.querySelectorAll('.exports textarea')].map(x=>x.value)"),
    copyTabs.outputs
  )

  await command('Page.navigate', { url: `${pageUrl}#%7Bbad` })
  await waitForReadiness(async () => assert.equal(await evaluate('location.hash'), '#%7Bbad'), {
    description: 'malformed URL navigation',
    timeoutMs: 20_000,
    pollIntervalMs: 50
  })
  await command('Page.reload', { ignoreCache: true })
  await waitForReadiness(
    async () =>
      assert.match(
        await evaluate("document.querySelector('#url-status')?.textContent || ''"),
        /ignored/i
      ),
    { description: 'malformed fallback', timeoutMs: 20_000, pollIntervalMs: 50 }
  )
  assert.equal(await evaluate("document.querySelectorAll('[data-preview=bootstrap]').length"), 1)

  const oversizedHash = `#${'x'.repeat(140_000)}`
  await command('Page.navigate', { url: `${pageUrl}${oversizedHash}` })
  await waitForReadiness(
    async () => assert.equal(await evaluate('location.hash.length'), oversizedHash.length),
    {
      description: 'oversized URL navigation',
      timeoutMs: 20_000,
      pollIntervalMs: 50
    }
  )
  await command('Page.reload', { ignoreCache: true })
  await waitForReadiness(
    async () =>
      assert.match(
        await evaluate("document.querySelector('#url-status')?.textContent || ''"),
        /size limit/i
      ),
    { description: 'oversized fallback', timeoutMs: 20_000, pollIntervalMs: 50 }
  )
  assert.equal(await evaluate("document.querySelectorAll('[data-preview=ladder]').length"), 1)

  const unexpected = requests.filter(
    url =>
      !url.startsWith(`http://127.0.0.1:${port}`) &&
      !url.startsWith('data:') &&
      url !== 'about:blank'
  )
  assert.deepEqual(unexpected, [])
  assert.deepEqual(exceptions, [], `${exceptions.join('\n')}\n${browserErrors}`)
  console.log(JSON.stringify({ basePath, mobile, checks: 'passed', requests: requests.length }))
} finally {
  try {
    client?.dispose()
    socket?.close()
  } catch {}
  if (browser && browser.exitCode === null) {
    browser.kill('SIGTERM')
    await Promise.race([new Promise(resolve => browser.once('close', resolve)), delay(3000)])
    if (browser.exitCode === null) browser.kill('SIGKILL')
  }
  if (server) await new Promise(resolve => server.close(resolve))
  await Promise.all(owned.map(path => rm(path, { recursive: true, force: true })))
}
