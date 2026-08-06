import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink
} from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'

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

const captureDirectory = async (path, label) => {
  const value = await requireRealDirectory(path, label)
  return {
    dev: Number(value.dev),
    ino: Number(value.ino),
    path,
    realpath: await realpath(path)
  }
}

const revalidateDirectory = async (expected, label) => {
  let current
  try {
    current = await captureDirectory(expected.path, label)
  } catch (error) {
    throw new Error(`${label} identity was replaced: ${expected.path}`, { cause: error })
  }
  if (!sameIdentity(current, expected) || current.realpath !== expected.realpath) {
    throw new Error(`${label} identity was replaced: ${expected.path}`)
  }
  return expected
}

const ensureCanonicalDirectory = async canonical => {
  const current = await entry(canonical)
  if (!current) await mkdir(canonical)
  return captureDirectory(canonical, 'Canonical output')
}

const ensureCanonicalSubdirectory = async (
  canonicalIdentity,
  relativeDirectory,
  revalidateRoots
) => {
  if (!relativeDirectory || relativeDirectory === '.') return canonicalIdentity
  let current = canonicalIdentity
  for (const component of relativeDirectory.split(sep)) {
    await revalidateRoots()
    await revalidateDirectory(current, 'Canonical asset parent')
    const path = join(current.path, component)
    try {
      await mkdir(path)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    current = await captureDirectory(path, 'Canonical asset directory')
  }
  return current
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

const uniqueTemp = directory =>
  join(directory, `${CANONICAL_PUBLISH_TEMP_MARKER}${process.pid}-${randomUUID()}`)

const unlinkFromTrustedDirectory = async (temp, trustedDirectory) => {
  try {
    await revalidateDirectory(trustedDirectory, 'Publication temp parent')
  } catch {
    return
  }
  await unlink(temp).catch(error => {
    if (!missing(error)) throw error
  })
}

const writeSyncedTemp = async ({ afterStep, contents, kind, relativePath, trustedDirectory }) => {
  await revalidateDirectory(trustedDirectory, 'Publication temp parent')
  const temp = uniqueTemp(trustedDirectory.path)
  let handle
  try {
    handle = await open(temp, 'wx', 0o600)
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
    await unlinkFromTrustedDirectory(temp, trustedDirectory).catch(cleanupError => {
      error = new AggregateError([error, cleanupError], `Failed to clean publication temp ${temp}`)
    })
    throw error
  }
}

const readExistingRegularFile = async target => {
  const before = await lstat(target)
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`Canonical immutable asset must be a non-symlink regular file: ${target}`)
  }
  let handle
  try {
    const noFollowSupported =
      process.platform !== 'win32' && typeof constants.O_NOFOLLOW === 'number'
    if (noFollowSupported) {
      try {
        handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
      } catch (error) {
        if (!['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) throw error
        // Some filesystems expose O_NOFOLLOW but reject it. The fallback remains lstat/fstat pinned.
        handle = await open(target, constants.O_RDONLY)
      }
    } else {
      // Windows and runtimes without O_NOFOLLOW use identity-matched lstat/open/fstat.
      handle = await open(target, constants.O_RDONLY)
    }
    const opened = await handle.stat()
    if (!opened.isFile() || !sameIdentity(opened, before)) {
      throw new Error(`Canonical immutable asset changed while opening: ${target}`)
    }
    const after = await lstat(target)
    if (after.isSymbolicLink() || !after.isFile() || !sameIdentity(after, opened)) {
      throw new Error(`Canonical immutable asset was replaced while opening: ${target}`)
    }
    return await handle.readFile()
  } finally {
    await handle?.close()
  }
}

const publishImmutableAsset = async ({ afterStep, canonicalIdentity, file, revalidateRoots }) => {
  await revalidateRoots()
  const trustedDirectory = await ensureCanonicalSubdirectory(
    canonicalIdentity,
    dirname(file.relative),
    revalidateRoots
  )
  await revalidateRoots()
  await revalidateDirectory(trustedDirectory, 'Canonical asset directory')
  const target = join(canonicalIdentity.path, file.relative)
  const temp = await writeSyncedTemp({
    afterStep,
    contents: file.contents,
    kind: 'asset',
    relativePath: file.relative,
    trustedDirectory
  })
  try {
    await revalidateRoots()
    await revalidateDirectory(trustedDirectory, 'Canonical asset directory')
    try {
      // Hard-link creation is atomic and never replaces an existing immutable name.
      await link(temp, target)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const existing = await readExistingRegularFile(target)
      if (!existing.equals(file.contents)) {
        throw new Error(`Canonical immutable asset collision has different bytes: ${file.relative}`)
      }
    }
    await syncDirectory(trustedDirectory.path)
    await step(afterStep, 'asset-publish', { relativePath: file.relative, target })
  } finally {
    await unlinkFromTrustedDirectory(temp, trustedDirectory)
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
  revalidateTrustedPath = async () => {},
  staging
}) => {
  const generation = await validateAndReadStaging(staging)
  await revalidateTrustedPath()
  const parentIdentity = await captureDirectory(dirname(canonical), 'Canonical parent')
  await revalidateTrustedPath()
  const canonicalIdentity = await ensureCanonicalDirectory(canonical)
  const revalidateRoots = async () => {
    await revalidateTrustedPath()
    await revalidateDirectory(parentIdentity, 'Canonical parent')
    await revalidateDirectory(canonicalIdentity, 'Canonical output')
  }
  await step(afterStep, 'canonical-ready', { canonical })

  await revalidateRoots()
  for (const file of generation.assets) {
    await publishImmutableAsset({ afterStep, canonicalIdentity, file, revalidateRoots })
  }
  await step(afterStep, 'assets-ready', { canonical })

  await revalidateRoots()
  const target = join(canonical, 'index.html')
  const temp = await writeSyncedTemp({
    afterStep,
    contents: generation.index.contents,
    kind: 'index',
    relativePath: 'index.html',
    trustedDirectory: canonicalIdentity
  })
  try {
    await beforeIndexRename?.({ canonical, staging, temp })
    await step(afterStep, 'before-index-rename', { canonical, temp })
    await revalidateRoots()
    await rename(temp, target)
    await syncDirectory(canonical)
  } catch (error) {
    await unlinkFromTrustedDirectory(temp, canonicalIdentity).catch(cleanupError => {
      error = new AggregateError([error, cleanupError], `Failed to clean publication temp ${temp}`)
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
