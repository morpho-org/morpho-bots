import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const smoke = fileURLToPath(new URL('./playground-smoke.mjs', import.meta.url))
const run = env =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [smoke], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
    })
    child.stderr.on('data', chunk => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', code => {
      try {
        assert.equal(code, 0, `${stdout}\n${stderr}`)
        resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1)))
      } catch (error) {
        reject(error)
      }
    })
  })

test('desktop root playground smoke', { timeout: 120_000 }, async () => {
  const result = await run({
    PLAYGROUND_SMOKE_BASE_PATH: '/',
    PLAYGROUND_SMOKE_VIEWPORT: 'desktop'
  })
  assert.equal(result.basePath, '/')
  assert.equal(result.mobile, false)
  assert.equal(result.checks, 'passed')
  assert.ok(result.requests >= 3)
})

test('mobile GitHub Pages subpath playground smoke', { timeout: 120_000 }, async () => {
  const result = await run({
    PLAYGROUND_SMOKE_BASE_PATH: '/morpho-bots/',
    PLAYGROUND_SMOKE_VIEWPORT: 'mobile'
  })
  assert.equal(result.basePath, '/morpho-bots/')
  assert.equal(result.mobile, true)
  assert.equal(result.checks, 'passed')
  assert.ok(result.requests >= 3)
})
