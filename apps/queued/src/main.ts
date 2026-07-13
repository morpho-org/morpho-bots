#!/usr/bin/env bun
import type { Logger } from '@repo/evm-kit'
import type { RemoteSigner } from '@repo/signer-client'

import { createLogger } from '@repo/evm-kit'
import { acquireLock, botsHome, ConfigError, queuedLockFile, releaseLock } from '@repo/home'
import { createRemoteSigner } from '@repo/signer-client'
import { ensureError } from '@repo/utils'
import { Command, CommanderError } from 'commander'
import { unlinkSync } from 'node:fs'
import { connect } from 'node:net'
import { isAddressEqual } from 'viem'

import type { QueuedConfig, QueuedOpts } from './config'

import { resolveChain, resolveChainId, resolveConfig } from './config'
import { createEngine } from './engine'
import { createQueuedServer } from './server'

type Env = Record<string, string | undefined>

// A pre-logger structured error line on stderr (config validation runs before the log level is known).
function fail(event: string, error: unknown): void {
  console.error(JSON.stringify({ level: 'error', event, error: ensureError(error).message }))
}

// Distinguish a stale socket file (a prior daemon died without unlinking) from a live one. A connect
// that succeeds means another daemon owns the socket → refuse (exit 2). Nobody-listening errors
// (`ECONNREFUSED`; or `ENOENT` — macOS/Bun report this for a stale socket file whose owner died) →
// clear the leftover file so `listen` can rebind. Any other error is a genuine problem → propagate.
function probeStaleSocket(socketPath: string): Promise<void> {
  const clearToBind = (resolve: () => void): void => {
    try {
      unlinkSync(socketPath)
    } catch {
      // Already gone (or raced with another unlink) — either way we are clear to bind.
    }
    resolve()
  }
  return new Promise<void>((resolve, reject) => {
    const socket = connect(socketPath)
    socket.setTimeout(1_000, () => {
      socket.destroy()
      reject(new ConfigError(`the socket at ${socketPath} did not respond to a probe within 1s`))
    })
    socket.on('connect', () => {
      socket.destroy()
      reject(new ConfigError(`a queue daemon is already listening on ${socketPath}`))
    })
    socket.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ECONNREFUSED' || code === 'ENOENT') {
        clearToBind(resolve)
      } else {
        reject(error)
      }
    })
  })
}

// Resolves the signing account from the config's signer backend (armed only). Agent mode: the
// handshake fetches the agent's address (a dead socket throws a plain error → transient exit 1), and
// an address disagreeing with LIQUIDATOR_ADDRESS is misconfig → ConfigError (exit 2). Returns the
// remote signer after verifying that the agent owns the configured liquidator address.
async function resolveRemoteSigner(config: QueuedConfig): Promise<RemoteSigner> {
  const backend = config.signer
  if (!backend) throw new ConfigError('resolveAccount called while disarmed')
  const socketPath = backend.socketPath
  const signer = await createRemoteSigner({ socketPath })
  if (!isAddressEqual(signer.address, config.liquidatorAddress)) {
    throw new ConfigError(
      `signing agent address (${signer.address}) does not match LIQUIDATOR_ADDRESS (${config.liquidatorAddress})`
    )
  }
  return signer
}

/**
 * `morpho-queued`: the per-chain, domain-agnostic transaction-queue daemon. Resolves config (chain is
 * explicit via `--chain`/`CHAIN_ID`; any operator-fixable problem → ConfigError → exit 2), takes the
 * per-chain lock and a stale-socket steal, (armed) handshakes the signer, restores state, then listens
 * on the Unix socket and blocks until SIGTERM/SIGINT — on which it drains, persists, unlinks, and
 * resolves 0. Exit codes: 2 for ConfigError / lock-held-by-live-pid / agent-address mismatch; 1 for a
 * bind failure, a signer down at startup, or another startup transient; 0 for a clean shutdown.
 */
export async function runQueued(opts: QueuedOpts): Promise<number> {
  const home = botsHome()

  let env: Env
  let config: QueuedConfig
  try {
    const chainId = resolveChainId(opts)
    env = { ...process.env, CHAIN_ID: chainId }
    const chain = resolveChain(chainId, env)
    config = resolveConfig({ env, chain, chainId, opts, home })
  } catch (error) {
    fail('startup.error', error)
    return error instanceof ConfigError ? 2 : 1
  }

  const logger: Logger = createLogger(config.logLevel)
  // The per-chain lock: a live holder is a second daemon on the same chain — misconfig, exit 2.
  const lockPath = queuedLockFile(home, String(config.chainId))
  const lock = acquireLock(lockPath)
  if (!lock.acquired) {
    fail(
      'queued.lock_held',
      new Error(`chain ${config.chainId} lock held by pid ${lock.holderPid}`)
    )
    return 2
  }
  if (lock.stolen) logger.warn('lock.stolen', { chainId: config.chainId, lockPath })

  try {
    await probeStaleSocket(config.socketPath)
  } catch (error) {
    fail('startup.error', error)
    releaseLock(lockPath)
    return error instanceof ConfigError ? 2 : 1
  }

  let remoteSigner: RemoteSigner | null = null
  if (config.signer) {
    try {
      remoteSigner = await resolveRemoteSigner(config)
    } catch (error) {
      fail('startup.error', error)
      releaseLock(lockPath)
      return error instanceof ConfigError ? 2 : 1
    }
  }

  let fatalTrigger: ((code: number) => void) | null = null
  const engine = createEngine({
    config,
    remoteSigner,
    logger,
    home,
    onFatal: code => fatalTrigger?.(code)
  })

  try {
    await engine.start()
  } catch (error) {
    fail('startup.error', error)
    releaseLock(lockPath)
    return error instanceof ConfigError ? 2 : 1
  }

  const server = createQueuedServer({
    socketPath: config.socketPath,
    chainId: config.chainId,
    engine,
    log: logger
  })

  let shutdownRequested: { signal: string; code: number } | null = null
  let triggerShutdown: ((signal: string, code: number) => void) | null = null
  const requestShutdown = (signal: string, code = 0) => {
    if (triggerShutdown) triggerShutdown(signal, code)
    else shutdownRequested = { signal, code }
  }
  const onSigterm = () => requestShutdown('SIGTERM')
  const onSigint = () => requestShutdown('SIGINT')
  process.once('SIGTERM', onSigterm)
  process.once('SIGINT', onSigint)

  try {
    await server.listen()
  } catch (error) {
    process.removeListener('SIGTERM', onSigterm)
    process.removeListener('SIGINT', onSigint)
    fail('queued.bind_error', error)
    await engine.shutdown()
    releaseLock(lockPath)
    return 1
  }

  logger.info('queued.listening', {
    socket: config.socketPath,
    chainId: config.chainId,
    address: remoteSigner?.address ?? null,
    armed: remoteSigner !== null,
    dryRun: config.dryRun
  })

  return new Promise<number>(resolve => {
    let shuttingDown = false
    const shutdown = async (signal: string, code: number): Promise<void> => {
      if (shuttingDown) return
      shuttingDown = true
      logger.info('queued.shutdown', { signal, code })
      await engine.shutdown()
      await server.close()
      releaseLock(lockPath)
      resolve(code)
    }
    triggerShutdown = (signal, code) => void shutdown(signal, code)
    fatalTrigger = code => requestShutdown('fatal', code)
    if (shutdownRequested) triggerShutdown(shutdownRequested.signal, shutdownRequested.code)
  })
}

const program = new Command('morpho-queued')
  .description(
    'The per-chain transaction-queue daemon. Long-lived: bots pipe transaction records to it over ' +
      'a Unix socket; it owns dedupe, re-sim, fees, nonce, submit, and ' +
      'continuous settlement/RBF. Terminal outcomes append to <home>/queued/outcomes-<chain>.jsonl; ' +
      'all logs go to stderr. Config/state live under ~/.morpho-bots (MORPHO_BOTS_HOME overrides).'
  )
  .exitOverride()

program
  .command('serve')
  .description('run the long-lived per-chain transaction lifecycle daemon')
  .option('--chain <id>', 'chain id to serve (required; else CHAIN_ID env)')
  .option(
    '--socket <path>',
    'unix socket path (default: QUEUED_SOCKET env, or <home>/queued-<chain>.sock)'
  )
  .option(
    '--dry-run',
    'disarmed: run the full pipeline and emit would_submit, never touching a signer'
  )
  .action(async (opts: QueuedOpts) => {
    process.exitCode = await runQueued(opts)
  })

program
  .command('submit')
  .description('stream transaction JSONL from stdin to the per-chain daemon')
  .option('--chain <id>', 'chain id to submit to (required; else CHAIN_ID env)')
  .action(async (opts: { chain?: string }) => {
    const { runSubmit } = await import('./submit')
    process.exitCode = await runSubmit(opts)
  })

try {
  await program.parseAsync()
} catch (error) {
  if (error instanceof CommanderError) {
    process.exitCode =
      error.code === 'commander.helpDisplayed' || error.code === 'commander.version' ? 0 : 2
  } else {
    throw error
  }
}
