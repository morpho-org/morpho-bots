import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const dist = join(root, 'playground/dist')
const port = 4173
const debuggingPort = 9333
const userDataDir = await mkdtemp(join(tmpdir(), 'market-making-playground-'))
const server = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], {
  cwd: dist,
  stdio: 'ignore'
})
const browser = spawn(
  '/usr/bin/chromium',
  [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    `--remote-debugging-port=${debuggingPort}`,
    `--user-data-dir=${userDataDir}`,
    'about:blank'
  ],
  { stdio: 'ignore' }
)

const waitFor = async operation => {
  let lastError
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await operation()
    } catch (error) {
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
  await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}`)
    if (!response.ok) throw new Error('server not ready')
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
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let id = 0
  const pending = new Map()
  const requests = []
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url)
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
  await command('Network.enable')
  await command('Page.navigate', { url: `http://127.0.0.1:${port}` })
  await waitFor(async () => {
    if (!(await evaluate("document.documentElement.dataset.playgroundReady === 'true'"))) {
      throw new Error('playground not ready')
    }
  })

  assert(
    await evaluate("document.querySelectorAll('.ladder-market').length === 1"),
    'initial ladder was not rendered immediately'
  )
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

  const secondMarket = `0x${'6'.repeat(64)}`
  await evaluate(
    `(() => { const input=document.querySelector('[data-field=MARKET_IDS]'); input.value += ',${secondMarket}'; input.dispatchEvent(new Event('input',{bubbles:true})); [...document.querySelectorAll('button')].find(button=>button.textContent==='Add ladder market').click(); const markets=[...document.querySelectorAll('.market-card [data-field=marketId]')]; const input2=markets.at(-1); input2.value='${secondMarket}'; input2.dispatchEvent(new Event('input',{bubbles:true})); const cards=[...document.querySelectorAll('.market-card')]; [...cards.at(-1).querySelectorAll('button')].find(button=>button.textContent==='Move up').click(); })()`
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
      "!document.querySelector('#validation-errors').hidden && document.querySelector('#validation-errors').textContent.includes('MAKER_PRIVATE_KEY') && document.querySelector('#copy-export').disabled && document.querySelector('#ladder-status').dataset.status !== 'ok' && document.querySelectorAll('.ladder-market').length === 0"
    ),
    'invalid production configuration did not invalidate every synthetic ladder preview'
  )
  await evaluate(
    `(() => { const key=document.querySelector('[data-field=MAKER_PRIVATE_KEY]'); key.value='0x${'a'.repeat(64)}'; key.dispatchEvent(new Event('input',{bubbles:true})); })()`
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
  socket.close()
  console.log(`browser smoke: PASS (${requests.length} local requests, 0 unexpected requests)`)
} finally {
  server.kill('SIGTERM')
  browser.kill('SIGTERM')
  const exited = process =>
    process.exitCode === null
      ? new Promise(resolve => process.once('exit', resolve))
      : Promise.resolve()
  await Promise.all([exited(server), exited(browser)])
  await rm(userDataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}
