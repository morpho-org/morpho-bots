import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const browserTest = fileURLToPath(new URL('./playground-smoke.browser.mjs', import.meta.url))
const markerCount = (output, marker) => output.split(marker).length - 1
const diagnostics = output => output.slice(-8000)

const result = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--test', browserTest], {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => {
    stdout += chunk
  })
  child.stderr.on('data', chunk => {
    stderr += chunk
  })
  child.once('error', reject)
  child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
})

assert.deepEqual(
  { code: result.code, signal: result.signal },
  { code: 0, signal: null },
  `explicit browser test failed\nstdout (tail):\n${diagnostics(result.stdout)}\nstderr (tail):\n${diagnostics(result.stderr)}`
)
const output = `${result.stdout}\n${result.stderr}`
assert.equal(markerCount(output, 'browser CSP: PASS'), 1, 'browser CSP marker count')
assert.equal(markerCount(output, 'browser smoke: PASS'), 1, 'browser smoke marker count')
assert.match(output, /ℹ tests 3/)
assert.match(output, /ℹ pass 3/)
assert.match(output, /ℹ fail 0/)
assert.match(output, /ℹ skipped 0/)
console.log('explicit browser suite: exit=0, pass=3, skip=0, fail=0, CSP=1, smoke=1')
