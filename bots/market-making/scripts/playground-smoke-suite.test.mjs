import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const scriptsDirectory = fileURLToPath(new URL('.', import.meta.url))

const readJson = async path => JSON.parse(await readFile(path, 'utf8'))

test('CI keeps real-browser tests out of Bun discovery and runs them explicitly after Bun', async () => {
  const [rootPackage, marketMakingPackage, workflow, scriptNames] = await Promise.all([
    readJson(join(root, 'package.json')),
    readJson(join(root, 'bots/market-making/package.json')),
    readFile(join(root, '.github/workflows/checks.yml'), 'utf8'),
    readdir(scriptsDirectory)
  ])

  assert.equal(rootPackage.scripts.test, 'bun test')
  assert.equal(
    rootPackage.scripts['test:browser'],
    'bun run --filter @morpho-org/market-making-bot playground:smoke:test'
  )
  assert.equal(
    marketMakingPackage.scripts['playground:smoke:test'],
    'node --test scripts/playground-smoke.browser.mjs'
  )

  const unitStep = workflow.indexOf('- name: Run unit tests\n        run: bun test')
  const browserStep = workflow.indexOf(
    '- name: Run browser smoke tests\n        run: bun test:browser'
  )
  assert.notEqual(unitStep, -1)
  assert.ok(browserStep > unitStep, 'browser smoke command must run after the Bun suite')

  const bunDiscoveredTests = scriptNames.filter(
    name => /\.test\.[cm]?[jt]s$/.test(name) && name !== 'playground-smoke-suite.test.mjs'
  )
  const bunSources = await Promise.all(
    bunDiscoveredTests.map(name => readFile(join(scriptsDirectory, name), 'utf8'))
  )
  for (const source of bunSources) {
    assert.doesNotMatch(source, /after Chromium readiness/)
    assert.doesNotMatch(source, /two complete smoke runs/)
    assert.doesNotMatch(source, /test\.skip/)
  }

  const browserSource = await readFile(
    join(scriptsDirectory, 'playground-smoke.browser.mjs'),
    'utf8'
  )
  assert.match(browserSource, /from 'node:test'/)
  assert.match(browserSource, /\['SIGTERM', 'SIGINT'\]/)
  assert.match(browserSource, /\$\{signal\} after Chromium readiness/)
  assert.match(browserSource, /two complete smoke runs/)
})

test('browser lifecycle uses separate bounded build, startup, body, UI, CDP, and cleanup budgets', async () => {
  const [smokeSource, browserSource] = await Promise.all([
    readFile(join(scriptsDirectory, 'playground-smoke.mjs'), 'utf8'),
    readFile(join(scriptsDirectory, 'playground-smoke.browser.mjs'), 'utf8')
  ])

  assert.match(smokeSource, /smokeBudgets\(process\.env\)/)
  assert.match(smokeSource, /runBounded\([\s\S]*fresh playground build/)
  assert.match(smokeSource, /const startupDeadline = performance\.now\(\) \+ startupTimeout/)
  assert.match(smokeSource, /disposeResult: openedSocket => openedSocket\.close\(\)/)
  assert.match(smokeSource, /createCdpClient\(socket/)
  assert.match(smokeSource, /\/json\/new\?about:blank/)
  assert.doesNotMatch(smokeSource, /\/json\/new\?http:\/\/127\.0\.0\.1/)
  assert.match(smokeSource, /phaseDeadline = performance\.now\(\) \+ bodyTimeout/)
  assert.match(smokeSource, /uiReadiness\('clipboard fallback status'\)/)
  assert.match(smokeSource, /description: 'smoke cleanup'/)
  assert.doesNotMatch(smokeSource, /browserReadiness\('clipboard fallback status'\)/)
  assert.match(browserSource, /smokeBudgets\(process\.env\)/)
  assert.match(browserSource, /timeoutMs: outerReadinessTimeout/)
  assert.match(browserSource, /timeout: browserTestTimeout/g)
  assert.match(browserSource, /signalSmokeEntrypoint\(run, 'SIGTERM'\)/)
  assert.doesNotMatch(browserSource, /smoke\.kill\('SIGKILL'\)/)
})
