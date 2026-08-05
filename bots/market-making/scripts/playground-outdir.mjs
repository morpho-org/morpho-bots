import { lstat, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const CUSTOM_OUTDIR_PREFIX = 'market-making-playground-dist-'

const isWithin = (parent, child) => {
  const path = relative(parent, child)
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

const rejectProtectedPath = (path, packageRoot) => {
  const protectedPaths = [
    packageRoot,
    join(packageRoot, 'playground'),
    join(packageRoot, 'playground', 'src')
  ]
  if (
    protectedPaths.some(protectedPath => path === protectedPath) ||
    isWithin(join(packageRoot, 'playground', 'src'), path)
  ) {
    throw new Error(`Refusing protected playground output path: ${path}`)
  }
}

export const validatePlaygroundOutdir = async ({ packageRoot, requestedOutdir }) => {
  const root = await realpath(packageRoot)
  const requested = isAbsolute(requestedOutdir)
    ? resolve(requestedOutdir)
    : resolve(root, requestedOutdir)
  const canonical = join(root, 'playground', 'dist')
  rejectProtectedPath(requested, root)

  if (requested === canonical) {
    try {
      const entry = await lstat(canonical)
      if (entry.isSymbolicLink())
        throw new Error(`Canonical output must not be a symlink: ${canonical}`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    return { canonical: true, outdir: canonical }
  }

  const allowedRoot = await realpath(tmpdir())
  if (dirname(requested) !== allowedRoot || !basename(requested).startsWith(CUSTOM_OUTDIR_PREFIX)) {
    throw new Error(
      `Custom output must be a direct ${CUSTOM_OUTDIR_PREFIX}* directory under ${allowedRoot}`
    )
  }
  if (basename(requested) === CUSTOM_OUTDIR_PREFIX) {
    throw new Error('Custom output prefix requires a unique suffix')
  }
  const entry = await lstat(requested).catch(error => {
    if (error?.code === 'ENOENT') throw new Error(`Custom output must be pre-created: ${requested}`)
    throw error
  })
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Custom output must be a non-symlink directory: ${requested}`)
  }
  if (typeof process.getuid === 'function' && entry.uid !== process.getuid()) {
    throw new Error(`Custom output must be owned by uid ${process.getuid()}: ${requested}`)
  }
  const actual = await realpath(requested)
  if (actual !== requested || dirname(actual) !== allowedRoot) {
    throw new Error(`Custom output resolves outside the allowed temporary root: ${requested}`)
  }
  const rootEntry = await stat(allowedRoot)
  if (!rootEntry.isDirectory()) throw new Error(`Temporary root is not a directory: ${allowedRoot}`)
  return { canonical: false, outdir: requested }
}

export const cleanCanonicalPlaygroundOutdir = async outdir => {
  const entry = await lstat(outdir).catch(error => {
    if (error?.code === 'ENOENT') return undefined
    throw error
  })
  if (entry?.isSymbolicLink()) throw new Error(`Refusing to clean symlink output: ${outdir}`)
  await rm(outdir, { recursive: true, force: true })
}
