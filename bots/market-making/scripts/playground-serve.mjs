import { fileURLToPath } from 'node:url'

import { runPortableProcess } from './playground-process.mjs'
import {
  cleanupOwnedResources,
  ensureFrozenDependencies,
  isSuccessfulSignalShutdown,
  parseServeOptions
} from './playground-serve-support.mjs'
import { prepareFreshDist, startStaticServer } from './playground-smoke-support.mjs'

const botRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const shutdown = new AbortController()
let terminating = false
let prepared
let server
let cleanupPromise

const cleanup = () => (cleanupPromise ??= cleanupOwnedResources({ prepared, server })())

const stop = signal => {
  if (terminating) return
  terminating = true
  shutdown.abort(new Error(`Playground stopped by ${signal}`))
}

const errorMessages = error => {
  if (error instanceof AggregateError) return error.errors.flatMap(errorMessages)
  return [error?.message ?? String(error)]
}

process.once('SIGINT', stop)
process.once('SIGTERM', stop)

try {
  const options = parseServeOptions(process.argv.slice(2))
  await ensureFrozenDependencies({
    repoRoot,
    packageRoot: botRoot,
    processRunner: runPortableProcess,
    signal: shutdown.signal
  })
  if (shutdown.signal.aborted) throw shutdown.signal.reason

  prepared = await prepareFreshDist({
    root: botRoot,
    processRunner: runPortableProcess,
    signal: shutdown.signal
  })
  if (shutdown.signal.aborted) throw shutdown.signal.reason

  server = await startStaticServer(prepared.dist, options)
  if (shutdown.signal.aborted) throw shutdown.signal.reason
  console.log(`Playground ready: ${server.url}`)
  console.log('Press Ctrl-C to stop.')

  await new Promise(resolve => {
    if (shutdown.signal.aborted) resolve()
    else shutdown.signal.addEventListener('abort', resolve, { once: true })
  })
  await cleanup()
  process.exitCode = 0
} catch (error) {
  let cleanupError
  try {
    await cleanup()
  } catch (caught) {
    cleanupError = caught
  }
  if (cleanupError) {
    for (const message of errorMessages(cleanupError)) {
      console.error(`Playground cleanup failed: ${message}`)
    }
  }
  if (isSuccessfulSignalShutdown({ cleanupError, error, signal: shutdown.signal })) {
    process.exitCode = 0
  } else {
    if (error !== shutdown.signal.reason) {
      for (const message of errorMessages(error)) console.error(`Playground failed: ${message}`)
    }
    process.exitCode = 1
  }
} finally {
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
}
