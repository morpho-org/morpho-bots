import { chmod, glob, lstat, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { runPortableProcess } from './playground-process.mjs'

const requiredDependencies = ['viem', '@repo/bot-kit']
const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1'])

const escapesRoot = path => path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)

const workspacePatterns = manifest => {
  if (Array.isArray(manifest.workspaces)) return manifest.workspaces
  if (Array.isArray(manifest.workspaces?.packages)) return manifest.workspaces.packages
  return []
}

const binTargets = manifest => {
  if (typeof manifest.bin === 'string') return [manifest.bin]
  if (!manifest.bin || typeof manifest.bin !== 'object' || Array.isArray(manifest.bin)) return []
  return Object.values(manifest.bin).filter(target => typeof target === 'string')
}

const readManifest = async path => JSON.parse(await readFile(path, 'utf8'))

const snapshotWorkspaceBinModes = async (
  repoRoot,
  { packageRoot, platform = process.platform } = {}
) => {
  if (platform === 'win32') return []

  const canonicalRepoRoot = await realpath(repoRoot)
  const rootManifestPath = join(canonicalRepoRoot, 'package.json')
  let rootManifest = {}
  const manifestPaths = new Set()
  try {
    rootManifest = await readManifest(rootManifestPath)
    manifestPaths.add(rootManifestPath)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (packageRoot) {
    try {
      const canonicalPackageManifest = await realpath(join(packageRoot, 'package.json'))
      if (!escapesRoot(relative(canonicalRepoRoot, canonicalPackageManifest))) {
        manifestPaths.add(canonicalPackageManifest)
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
    }
  }
  for (const pattern of workspacePatterns(rootManifest)) {
    if (typeof pattern !== 'string' || pattern.length === 0 || isAbsolute(pattern)) continue
    for await (const match of glob(pattern, {
      cwd: canonicalRepoRoot,
      exclude: ['**/node_modules/**'],
      withFileTypes: false
    })) {
      const packageRoot = resolve(canonicalRepoRoot, match)
      if (escapesRoot(relative(canonicalRepoRoot, packageRoot))) continue
      const manifestPath = join(packageRoot, 'package.json')
      try {
        const canonicalManifest = await realpath(manifestPath)
        if (!escapesRoot(relative(canonicalRepoRoot, canonicalManifest))) {
          manifestPaths.add(canonicalManifest)
        }
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      }
    }
  }

  const snapshots = new Map()
  for (const manifestPath of manifestPaths) {
    const packageRoot = await realpath(resolve(manifestPath, '..'))
    if (escapesRoot(relative(canonicalRepoRoot, packageRoot))) continue
    const manifest = await readManifest(manifestPath)
    for (const target of binTargets(manifest)) {
      if (target.length === 0 || isAbsolute(target)) continue
      const targetPath = resolve(packageRoot, target)
      if (escapesRoot(relative(packageRoot, targetPath))) continue
      try {
        const metadata = await lstat(targetPath)
        if (!metadata.isFile() || metadata.isSymbolicLink()) continue
        const canonicalTarget = await realpath(targetPath)
        if (escapesRoot(relative(packageRoot, canonicalTarget))) continue
        snapshots.set(canonicalTarget, metadata.mode & 0o7777)
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error
      }
    }
  }
  return [...snapshots].map(([path, mode]) => ({ path, mode }))
}

const restoreWorkspaceBinModes = async (snapshots, chmodFile) => {
  const results = await Promise.allSettled(
    snapshots.map(async ({ path, mode }) => {
      const metadata = await lstat(path)
      if (!metadata.isFile() || metadata.isSymbolicLink() || (await realpath(path)) !== path) {
        throw new Error('declared bin target is no longer the same regular file')
      }
      await chmodFile(path, mode)
    })
  )
  return results
    .map((result, index) =>
      result.status === 'rejected'
        ? new Error(
            `Could not restore permissions ${snapshots[index].mode.toString(8)} on ${snapshots[index].path}: ${result.reason?.message ?? result.reason}`,
            { cause: result.reason }
          )
        : undefined
    )
    .filter(Boolean)
}

const parsePort = value => {
  if (!/^\d+$/.test(value)) throw new Error(`Invalid port: ${value}`)
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}; expected an integer from 0 to 65535`)
  }
  return port
}

const parseHost = value => {
  const normalized = value === '[::1]' ? '::1' : value
  if (!loopbackHosts.has(normalized)) {
    throw new Error(
      `Invalid host: ${value}; playground must listen on loopback (localhost, 127.0.0.1, or ::1)`
    )
  }
  return normalized
}

export const parseServeOptions = (args, env = process.env) => {
  let host = parseHost(env.HOST ?? '127.0.0.1')
  let port = parsePort(env.PORT ?? '4173')
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--host' || argument === '--port') {
      const value = args[++index]
      if (value === undefined) throw new Error(`Missing value for ${argument}`)
      if (argument === '--host') host = parseHost(value)
      else port = parsePort(value)
      continue
    }
    if (argument.startsWith('--host=')) {
      host = parseHost(argument.slice('--host='.length))
      continue
    }
    if (argument.startsWith('--port=')) {
      port = parsePort(argument.slice('--port='.length))
      continue
    }
    throw new Error(`Unknown option: ${argument}`)
  }
  return { host, port }
}

const unresolvedDependencies = packageRoot => {
  const resolve = createRequire(join(packageRoot, 'package.json')).resolve
  return requiredDependencies.filter(dependency => {
    try {
      resolve(dependency)
      return false
    } catch {
      return true
    }
  })
}

export const ensureFrozenDependencies = async ({
  repoRoot,
  packageRoot,
  executable = 'bun',
  env = process.env,
  chmodFile = chmod,
  platform = process.platform,
  processRunner = runPortableProcess,
  signal
}) => {
  if (signal?.aborted) throw signal.reason
  const snapshots = await snapshotWorkspaceBinModes(repoRoot, { packageRoot, platform })
  let installError
  try {
    console.log('Checking workspace dependencies with bun install --frozen-lockfile...')
    const result = await processRunner({
      executable,
      args: ['install', '--frozen-lockfile'],
      cwd: repoRoot,
      env,
      signal,
      stdio: 'inherit'
    })
    if (signal?.aborted) throw signal.reason
    if (result?.error) {
      throw new Error(
        `Failed to start ${executable} install --frozen-lockfile: ${result.error.message}`
      )
    }
    if (result?.code !== 0) {
      throw new Error(
        `${executable} install --frozen-lockfile failed with ${result?.signal ? `signal ${result.signal}` : `exit code ${result?.code}`}`
      )
    }
    const unresolved = unresolvedDependencies(packageRoot)
    if (unresolved.length > 0) {
      throw new Error(
        `Frozen install completed but required dependencies remain unresolved from ${packageRoot}: ${unresolved.join(', ')}`
      )
    }
  } catch (error) {
    installError = error
  } finally {
    const restorationErrors = await restoreWorkspaceBinModes(snapshots, chmodFile)
    if (restorationErrors.length > 0) {
      throw new AggregateError(
        installError ? [installError, ...restorationErrors] : restorationErrors,
        `Frozen install permission restoration failed (${restorationErrors.length} error(s))`
      )
    }
  }
  if (installError) throw installError
  return true
}

export const cleanupOwnedResources = ({ server, prepared } = {}) => {
  let cleanupPromise
  return () =>
    (cleanupPromise ??= (async () => {
      const operations = []
      if (server) operations.push(server.close())
      if (prepared) operations.push(prepared.cleanup())
      const results = await Promise.allSettled(operations)
      const errors = results
        .filter(result => result.status === 'rejected')
        .map(result => result.reason)
      if (errors.length > 0) {
        throw new AggregateError(errors, `Playground cleanup failed (${errors.length} error(s))`)
      }
    })())
}

export const isSuccessfulSignalShutdown = ({ cleanupError, error, signal }) =>
  signal.aborted && error === signal.reason && cleanupError === undefined
