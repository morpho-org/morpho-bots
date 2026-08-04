import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { discoverChromium } from './playground-smoke-support.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const smokeTest = fileURLToPath(new URL('./playground-smoke.test.mjs', import.meta.url))
const bun = process.env.BUN_EXECUTABLE ?? 'bun'
const missingChromium = '/definitely/missing/chromium'
const markerCount = (output, marker) => output.split(marker).length - 1
const diagnostics = output => output.slice(-8000)

const runParentTest = chromiumPath =>
  new Promise((resolve, reject) => {
    const child = spawn(bun, ['test', smokeTest], {
      cwd: root,
      env: { ...process.env, CHROMIUM_PATH: chromiumPath },
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

const assertRun = ({ name, result, pass, skip, cspMarkers, smokeMarkers }) => {
  assert.deepEqual(
    { code: result.code, signal: result.signal },
    { code: 0, signal: null },
    `${name} parent bun test failed\nstdout (tail):\n${diagnostics(result.stdout)}\nstderr (tail):\n${diagnostics(result.stderr)}`
  )
  const output = `${result.stdout}\n${result.stderr}`
  assert.equal(markerCount(output, 'browser CSP: PASS'), cspMarkers, `${name} CSP marker count`)
  assert.equal(
    markerCount(output, 'browser smoke: PASS'),
    smokeMarkers,
    `${name} smoke marker count`
  )
  assert.match(output, new RegExp(`\\n\\s*${pass} pass\\n`), `${name} pass count`)
  if (skip === 0) assert.doesNotMatch(output, /\n\s*\d+ skip\n/, `${name} unexpected skips`)
  else assert.match(output, new RegExp(`\\n\\s*${skip} skip\\n`), `${name} skip count`)
  assert.match(output, /\n\s*0 fail\n/, `${name} failure count`)
  assert.match(output, /Ran 17 tests across 1 file\./, `${name} result count`)
  return `${name}: exit=0, pass=${pass}, skip=${skip}, fail=0, CSP=${cspMarkers}, smoke=${smokeMarkers}`
}

const chromiumPath = await discoverChromium()
const present = await runParentTest(chromiumPath)
const absent = await runParentTest(missingChromium)

console.log(
  assertRun({
    name: 'browser present',
    result: present,
    pass: 17,
    skip: 0,
    cspMarkers: 1,
    smokeMarkers: 1
  })
)
console.log(
  assertRun({
    name: 'browser absent',
    result: absent,
    pass: 14,
    skip: 3,
    cspMarkers: 0,
    smokeMarkers: 0
  })
)
