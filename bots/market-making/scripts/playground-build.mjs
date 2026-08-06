import { transform } from 'esbuild'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  publishCanonicalPlayground,
  removeOwnedCanonicalStaging
} from './playground-atomic-publish.mjs'
import { productionPlaygroundBuildArguments } from './playground-build-arguments.mjs'
import {
  captureCanonicalPathIdentity,
  revalidateCanonicalPathIdentity
} from './playground-path-safety.mjs'

export const TEMPORARY_BUILD_PREFIX = 'market-making-playground-dist-'
export const CANONICAL_STAGING_PREFIX = 'market-making-playground-staging-'
export const BUILD_OUTPUT_KIND = 'market-making-playground-build'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const playground = join(packageRoot, 'playground')
const canonical = join(playground, 'dist')
const argumentsList = process.argv.slice(2)
if (
  argumentsList.length > 1 ||
  (argumentsList.length === 1 && argumentsList[0] !== '--temporary')
) {
  throw new Error('Usage: playground-build.mjs [--temporary]')
}
const temporary = argumentsList[0] === '--temporary'

const requireCanonicalDist = async () => {
  try {
    const entry = await lstat(canonical)
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Canonical output must be a non-symlink directory: ${canonical}`)
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

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
    renames.push({ entry, hashedName: `${unhashedStem}.${hash}${extension}` })
  }
  for (const { entry, hashedName } of renames) {
    if (entry.name !== hashedName) {
      await rename(join(entry.parentPath, entry.name), join(entry.parentPath, hashedName))
    }
  }

  entries = await readdir(directory, { recursive: true, withFileTypes: true })
  for (const htmlEntry of entries.filter(
    entry => entry.isFile() && extname(entry.name) === '.html'
  )) {
    const htmlPath = join(htmlEntry.parentPath, htmlEntry.name)
    let html = await readFile(htmlPath, 'utf8')
    for (const { entry, hashedName } of renames) html = html.replaceAll(entry.name, hashedName)
    await writeFile(htmlPath, html)
  }
}

const pathIdentity = await captureCanonicalPathIdentity({ packageRoot, playground, repoRoot })
if (!temporary) await requireCanonicalDist()
await revalidateCanonicalPathIdentity(pathIdentity)
const buildOutdir = await mkdtemp(
  join(tmpdir(), temporary ? TEMPORARY_BUILD_PREFIX : CANONICAL_STAGING_PREFIX)
)
if (process.platform !== 'win32') await chmod(buildOutdir, 0o700)
const created = await lstat(buildOutdir)
const buildIdentity = { dev: Number(created.dev), ino: Number(created.ino) }
let keepTemporary = false

try {
  const bun = process.env.BUN_EXE || 'bun'
  const child = spawn(bun, productionPlaygroundBuildArguments(buildOutdir), {
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
      if (temporary) {
        console.log(
          JSON.stringify({ kind: BUILD_OUTPUT_KIND, mode: 'temporary', path: buildOutdir })
        )
        keepTemporary = true
      } else {
        await revalidateCanonicalPathIdentity(pathIdentity)
        await requireCanonicalDist()
        await publishCanonicalPlayground({
          canonical,
          revalidateTrustedPath: () => revalidateCanonicalPathIdentity(pathIdentity),
          staging: buildOutdir
        })
      }
    }
  } finally {
    process.off('SIGINT', forwardSignal)
    process.off('SIGTERM', forwardSignal)
  }
} finally {
  if (!keepTemporary) await removeOwnedCanonicalStaging(buildOutdir, buildIdentity)
}
