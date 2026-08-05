import { createRequire } from 'node:module'
import { join } from 'node:path'

import { runPortableProcess } from './playground-process.mjs'

const requiredDependencies = ['viem', '@repo/bot-kit']
const loopbackHosts = new Set(['localhost', '127.0.0.1', '::1'])

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
  processRunner = runPortableProcess,
  signal
}) => {
  if (signal?.aborted) throw signal.reason
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
