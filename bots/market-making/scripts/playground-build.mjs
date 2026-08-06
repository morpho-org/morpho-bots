import { transform } from 'esbuild'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CANONICAL_STAGING_MARKER,
  publishCanonicalPlayground,
  removeOwnedCanonicalStaging
} from './playground-atomic-publish.mjs'
import { productionPlaygroundBuildArguments } from './playground-build-arguments.mjs'
import { revalidatePlaygroundOutdir, validatePlaygroundOutdir } from './playground-outdir.mjs'

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
const validatedOutdir = await validatePlaygroundOutdir({ packageRoot, requestedOutdir })
const { canonical, outdir } = validatedOutdir

const finalizeContentHashedAssets = async directory => {
  let entries = await readdir(directory, { recursive: true, withFileTypes: true })
  const assetEntries = entries.filter(
    entry => entry.isFile() && ['.css', '.js'].includes(extname(entry.name))
  )
  for (const entry of assetEntries.filter(entry => extname(entry.name) === '.js')) {
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
  }

  const renames = []
  for (const entry of assetEntries) {
    const path = join(entry.parentPath, entry.name)
    const contents = await readFile(path)
    const extension = extname(entry.name)
    const unhashedStem = basename(entry.name, extension).replace(
      /(?:-[a-z0-9]{8}|\.[0-9a-f]{12})$/,
      ''
    )
    const hash = createHash('sha256').update(contents).digest('hex').slice(0, 12)
    const hashedName = `${unhashedStem}.${hash}${extension}`
    renames.push({ entry, hashedName })
  }

  for (const { entry, hashedName } of renames) {
    if (entry.name !== hashedName) {
      await rename(join(entry.parentPath, entry.name), join(entry.parentPath, hashedName))
    }
  }

  entries = await readdir(directory, { recursive: true, withFileTypes: true })
  const htmlEntries = entries.filter(entry => entry.isFile() && extname(entry.name) === '.html')
  for (const htmlEntry of htmlEntries) {
    const htmlPath = join(htmlEntry.parentPath, htmlEntry.name)
    let html = await readFile(htmlPath, 'utf8')
    for (const { entry, hashedName } of renames) html = html.replaceAll(entry.name, hashedName)
    await writeFile(htmlPath, html)
  }
}

let buildOutdir = outdir
let canonicalStagingIdentity
if (canonical) {
  buildOutdir = await mkdtemp(
    join(dirname(outdir), `.${basename(outdir)}${CANONICAL_STAGING_MARKER}`)
  )
  const created = await lstat(buildOutdir)
  canonicalStagingIdentity = { dev: Number(created.dev), ino: Number(created.ino) }
} else {
  // Callers own custom cleanup. This is deliberately the final await before spawn so replacement,
  // permission, symlink, and non-empty races are rejected as close to Bun execution as possible.
  await revalidatePlaygroundOutdir(validatedOutdir)
}

try {
  const bun = process.env.BUN_EXE || 'bun'
  const buildArguments = productionPlaygroundBuildArguments(buildOutdir)
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
    if (!terminatingSignal) {
      await finalizeContentHashedAssets(buildOutdir)
      if (canonical) {
        await publishCanonicalPlayground({ canonical: outdir, staging: buildOutdir })
      }
    }
  } finally {
    process.off('SIGINT', forwardSignal)
    process.off('SIGTERM', forwardSignal)
  }
} finally {
  if (canonicalStagingIdentity) {
    await removeOwnedCanonicalStaging(buildOutdir, canonicalStagingIdentity)
  }
}
