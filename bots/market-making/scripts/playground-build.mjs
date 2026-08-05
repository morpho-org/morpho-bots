import { transform } from 'esbuild'
import { spawn } from 'node:child_process'
import { readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { productionPlaygroundBuildArguments } from './playground-build-arguments.mjs'
import { acquireProductionBuildLock } from './playground-build-lock.mjs'
import { cleanCanonicalPlaygroundOutdir, validatePlaygroundOutdir } from './playground-outdir.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const argumentsList = process.argv.slice(2)
const outdirIndexes = argumentsList.flatMap((argument, index) =>
  argument === '--outdir' ? [index] : []
)
if (outdirIndexes.length > 1) throw new Error('--outdir may be provided only once')
const outdirIndex = outdirIndexes[0] ?? -1
if (outdirIndex >= 0 && !argumentsList[outdirIndex + 1]) {
  throw new Error('--outdir requires a directory')
}
const requestedOutdir = outdirIndex >= 0 ? argumentsList[outdirIndex + 1] : 'playground/dist'
const { canonical, outdir } = await validatePlaygroundOutdir({ packageRoot, requestedOutdir })
const releaseBuildLock = await acquireProductionBuildLock(packageRoot)

const deterministicallyMinifyJavaScript = async directory => {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  const htmlFiles = entries.filter(entry => entry.isFile() && entry.name.endsWith('.html'))
  for (const entry of entries.filter(entry => entry.isFile() && entry.name.endsWith('.js'))) {
    const path = join(entry.parentPath, entry.name)
    const source = await readFile(path, 'utf8')
    const result = await transform(source, {
      format: 'esm',
      legalComments: 'none',
      minify: true,
      target: 'es2022'
    })
    if (!result.code) throw new Error(`esbuild produced no JavaScript for ${path}`)
    await writeFile(path, result.code)
    const stableName = entry.name.replace(/-[a-z0-9]{8}(?=\.js$)/, '')
    if (stableName === entry.name) continue
    await rename(path, join(entry.parentPath, stableName))
    await Promise.all(
      htmlFiles.map(async htmlEntry => {
        const htmlPath = join(htmlEntry.parentPath, htmlEntry.name)
        const html = await readFile(htmlPath, 'utf8')
        await writeFile(htmlPath, html.replaceAll(entry.name, stableName))
      })
    )
  }
}

try {
  if (canonical && !argumentsList.includes('--no-clean')) {
    await cleanCanonicalPlaygroundOutdir(outdir)
  }

  const bun = process.env.BUN_EXE || 'bun'
  const buildArguments = productionPlaygroundBuildArguments(outdir)
  const child = spawn(bun, buildArguments, {
    cwd: packageRoot,
    env: { ...process.env, NODE_ENV: 'production' },
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
  try {
    const result = await new Promise((resolveResult, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolveResult({ code, signal }))
    })
    if (!terminatingSignal && result.code !== 0) {
      const status = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`
      throw new Error(`Production playground build failed with ${status}`)
    }
    if (!terminatingSignal) await deterministicallyMinifyJavaScript(outdir)
  } finally {
    process.off('SIGINT', forwardSignal)
    process.off('SIGTERM', forwardSignal)
  }
} finally {
  await releaseBuildLock()
}
