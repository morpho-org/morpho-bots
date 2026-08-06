import { createHash, randomUUID } from 'node:crypto'
import { lstat, link, mkdir, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'

export const CANONICAL_STAGING_MARKER = '.staging-'
export const CANONICAL_PUBLISH_TEMP_MARKER = '.__publish-'

const missing = error => error?.code === 'ENOENT'
const sameIdentity = (left, right) =>
  left !== undefined &&
  right !== undefined &&
  Number(left.dev) === Number(right.dev) &&
  Number(left.ino) === Number(right.ino)
const step = async (afterStep, name, detail = {}) => afterStep?.(name, detail)

const entry = path =>
  lstat(path).catch(error => {
    if (missing(error)) return undefined
    throw error
  })

const requireRealDirectory = async (path, label) => {
  const value = await lstat(path)
  if (value.isSymbolicLink() || !value.isDirectory()) {
    throw new Error(`${label} must be a non-symlink directory: ${path}`)
  }
  return value
}

const ensureCanonicalDirectory = async canonical => {
  const current = await entry(canonical)
  if (!current) await mkdir(canonical, { recursive: true })
  return requireRealDirectory(canonical, 'Canonical output')
}

const ensureCanonicalSubdirectory = async (canonical, relativeDirectory) => {
  if (!relativeDirectory || relativeDirectory === '.') return
  let current = canonical
  for (const component of relativeDirectory.split(sep)) {
    current = join(current, component)
    try {
      await mkdir(current)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    await requireRealDirectory(current, 'Canonical asset directory')
  }
}

const listStagedFiles = async staging => {
  const entries = await readdir(staging, { recursive: true, withFileTypes: true })
  for (const value of entries) {
    if (!value.isFile() && !value.isDirectory()) {
      throw new Error(
        `Canonical staging may contain only regular files/directories: ${join(value.parentPath, value.name)}`
      )
    }
  }
  return entries
    .filter(value => value.isFile())
    .map(value => ({
      absolute: join(value.parentPath, value.name),
      relative: relative(staging, join(value.parentPath, value.name))
    }))
    .sort((left, right) => left.relative.localeCompare(right.relative))
}

const validateAndReadStaging = async staging => {
  await requireRealDirectory(staging, 'Canonical staging')
  const files = await listStagedFiles(staging)
  const index = files.find(file => file.relative === 'index.html')
  if (!index) throw new Error(`Canonical staging is missing index.html: ${staging}`)
  if (files.filter(file => file.relative === 'index.html').length !== 1) {
    throw new Error(`Canonical staging must contain exactly one root index.html: ${staging}`)
  }

  const assets = []
  for (const file of files.filter(candidate => candidate !== index)) {
    const contents = await readFile(file.absolute)
    const extension = extname(file.relative)
    if (extension === '.js' || extension === '.css') {
      const match = basename(file.relative).match(/\.([0-9a-f]{12,64})\.(?:js|css)$/)
      const digest = createHash('sha256').update(contents).digest('hex')
      if (!match || !digest.startsWith(match[1])) {
        throw new Error(
          `Canonical staging requires content-hashed JavaScript/CSS filenames: ${file.relative}`
        )
      }
    }
    assets.push({ ...file, contents })
  }
  return { assets, index: { ...index, contents: await readFile(index.absolute) } }
}

const syncDirectory = async path => {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

const uniqueTemp = target =>
  join(dirname(target), `${CANONICAL_PUBLISH_TEMP_MARKER}${process.pid}-${randomUUID()}`)

const writeSyncedTemp = async ({ afterStep, contents, kind, relativePath, target }) => {
  const temp = uniqueTemp(target)
  let handle
  try {
    handle = await open(temp, 'wx', 0o644)
    await step(afterStep, `${kind}-temp-open`, { relativePath, temp })
    await handle.writeFile(contents)
    await step(afterStep, `${kind}-write`, { relativePath, temp })
    await handle.sync()
    await step(afterStep, `${kind}-fsync`, { relativePath, temp })
    await handle.close()
    handle = undefined
    await step(afterStep, `${kind}-close`, { relativePath, temp })
    return temp
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await unlink(temp).catch(cleanupError => {
      if (!missing(cleanupError)) {
        error = new AggregateError(
          [error, cleanupError],
          `Failed to clean publication temp ${temp}`
        )
      }
    })
    throw error
  }
}

const publishImmutableAsset = async ({ afterStep, canonical, file }) => {
  const target = join(canonical, file.relative)
  await ensureCanonicalSubdirectory(canonical, dirname(file.relative))
  const temp = await writeSyncedTemp({
    afterStep,
    contents: file.contents,
    kind: 'asset',
    relativePath: file.relative,
    target
  })
  try {
    try {
      // Hard-link creation is atomic and, unlike rename, never replaces an existing immutable name.
      await link(temp, target)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const existing = await readFile(target)
      if (!existing.equals(file.contents)) {
        throw new Error(`Canonical immutable asset collision has different bytes: ${file.relative}`)
      }
    }
    await syncDirectory(dirname(target))
    await step(afterStep, 'asset-publish', { relativePath: file.relative, target })
  } finally {
    await unlink(temp)
  }
  await step(afterStep, 'asset-temp-remove', { relativePath: file.relative, temp })
}

/**
 * Gaplessly publishes a complete staged generation. Immutable content-addressed assets are made
 * canonical first and are never removed; index.html is the sole mutable commit point and is replaced
 * with one atomic file rename. Concurrent publishers can therefore race safely: the last index wins,
 * while assets for every index ever observed remain fetchable.
 */
export const publishCanonicalPlayground = async ({
  afterStep,
  beforeIndexRename,
  canonical,
  staging
}) => {
  // Read and validate the complete private tree before touching canonical output.
  const generation = await validateAndReadStaging(staging)
  await ensureCanonicalDirectory(canonical)
  await step(afterStep, 'canonical-ready', { canonical })

  for (const file of generation.assets) {
    await publishImmutableAsset({ afterStep, canonical, file })
  }
  await step(afterStep, 'assets-ready', { canonical })

  const target = join(canonical, 'index.html')
  const temp = await writeSyncedTemp({
    afterStep,
    contents: generation.index.contents,
    kind: 'index',
    relativePath: 'index.html',
    target
  })
  try {
    await beforeIndexRename?.({ canonical, staging, temp })
    await step(afterStep, 'before-index-rename', { canonical, temp })
    await rename(temp, target)
    await syncDirectory(canonical)
  } catch (error) {
    await unlink(temp).catch(cleanupError => {
      if (!missing(cleanupError)) {
        error = new AggregateError(
          [error, cleanupError],
          `Failed to clean publication temp ${temp}`
        )
      }
    })
    throw error
  }
}

export const removeOwnedCanonicalStaging = async (staging, stagingIdentity) => {
  const current = await entry(staging)
  if (!sameIdentity(current, stagingIdentity)) return false
  await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
  return true
}
