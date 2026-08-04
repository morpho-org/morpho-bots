import { fileURLToPath } from 'node:url'

import { ensureFrozenDependencies, parseServeOptions } from './playground-serve-support.mjs'
import { prepareFreshDist, startStaticServer } from './playground-smoke-support.mjs'

const botRoot = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))
const shutdown = new AbortController()
let terminating = false
let prepared
let server
let cleanupPromise

const cleanup = () =>
  (cleanupPromise ??= (async () => {
    const results = await Promise.allSettled([
      ...(server ? [server.close()] : []),
      ...(prepared ? [prepared.cleanup()] : [])
    ])
    const failure = results.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
  })())

const stop = signal => {
  if (terminating) return
  terminating = true
  shutdown.abort(new Error(`Playground stopped by ${signal}`))
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

try {
  const options = parseServeOptions(process.argv.slice(2))
  await ensureFrozenDependencies({
    repoRoot,
    packageRoot: botRoot,
    signal: shutdown.signal
  })
  if (shutdown.signal.aborted) throw shutdown.signal.reason

  prepared = await prepareFreshDist({ root: botRoot, signal: shutdown.signal })
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
  await cleanup().catch(cleanupError => {
    console.error(`Playground cleanup failed: ${cleanupError.message}`)
  })
  if (shutdown.signal.aborted) {
    process.exitCode = 0
  } else {
    console.error(`Playground failed: ${error.message}`)
    process.exitCode = 1
  }
} finally {
  process.off('SIGINT', stop)
  process.off('SIGTERM', stop)
}
