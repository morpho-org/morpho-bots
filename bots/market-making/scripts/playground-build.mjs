import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { productionPlaygroundBuildArguments } from './playground-build-arguments.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const argumentsList = process.argv.slice(2)
const outdirIndex = argumentsList.indexOf('--outdir')
if (outdirIndex >= 0 && !argumentsList[outdirIndex + 1]) {
  throw new Error('--outdir requires a directory')
}
const requestedOutdir = outdirIndex >= 0 ? argumentsList[outdirIndex + 1] : 'playground/dist'
const outdir = isAbsolute(requestedOutdir) ? requestedOutdir : resolve(packageRoot, requestedOutdir)

if (!argumentsList.includes('--no-clean')) {
  await rm(outdir, { recursive: true, force: true })
}

const bun = process.env.BUN_EXE || 'bun'
const buildArguments = productionPlaygroundBuildArguments(outdir)

const child = spawn(bun, buildArguments, {
  cwd: packageRoot,
  env: process.env,
  shell: false,
  stdio: 'inherit',
  windowsHide: true
})
let terminatingSignal
const forwardSignal = signal => {
  if (terminatingSignal) return
  terminatingSignal = signal
  child.kill(signal)
}
process.once('SIGINT', forwardSignal)
process.once('SIGTERM', forwardSignal)
const result = await new Promise((resolveResult, reject) => {
  child.once('error', reject)
  child.once('close', (code, signal) => resolveResult({ code, signal }))
})
process.off('SIGINT', forwardSignal)
process.off('SIGTERM', forwardSignal)
if (!terminatingSignal && result.code !== 0) {
  const status = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`
  throw new Error(`Production playground build failed with ${status}`)
}
