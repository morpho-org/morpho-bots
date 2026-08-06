import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

test('CI runs the dedicated root and Pages-subpath browser smoke after unit tests', async () => {
  const [rootPackage, botPackage, workflow, browser] = await Promise.all([
    readJson(`${root}/package.json`),
    readJson(`${root}/bots/market-making/package.json`),
    readFile(`${root}/.github/workflows/checks.yml`, 'utf8'),
    readFile(new URL('./playground-smoke.browser.mjs', import.meta.url), 'utf8')
  ])
  assert.equal(
    rootPackage.scripts['test:browser'],
    'bun run --filter @morpho-org/market-making-bot playground:smoke:test'
  )
  assert.equal(
    botPackage.scripts['playground:smoke:test'],
    'node --test scripts/playground-smoke.browser.mjs'
  )
  assert.ok(workflow.indexOf('run: bun test:browser') > workflow.indexOf('run: bun test'))
  assert.match(browser, /desktop root playground smoke/)
  assert.match(browser, /mobile GitHub Pages subpath playground smoke/)
  assert.match(browser, /PLAYGROUND_SMOKE_BASE_PATH/)
  assert.match(browser, /\/morpho-bots\//)
})
