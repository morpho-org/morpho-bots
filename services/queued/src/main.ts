#!/usr/bin/env bun
import type { Logger } from '@repo/bot-kit'
import type { Address, LocalAccount } from 'viem'

import { createLogger } from '@repo/bot-kit'
import {
  acquireLock,
  botsHome,
  ConfigError,
  queuedLockFile,
  releaseLock,
  warnOnLooseSecrets
} from '@repo/home'
import { createAgentAccount } from '@repo/signer'
import { Command, CommanderError } from 'commander'
import { unlinkSync } from 'node:fs'
import { connect } from 'node:net'
import { isAddressEqual } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { QueuedConfig, QueuedOpts } from './config'

import { mergedQueuedEnv, resolveChainId, resolveConfig } from './config'
import { resolveChain } from './domains'
import { createEngine } from './engine'
import { createQueuedServer } from './server'

type Env = Record<string, string | undefined>

// A pre-logger structured error line on stderr (config validation runs before the log level is known).
function fail(event: string, error: unknown): void {
  console.error(JSON.stringify({ level: 'error', event, error: (error as Error).message }))
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
// account plus an optional agent re-verifier for the reconcile drift check.
async function resolveAccount(
  config: QueuedConfig
): Promise<{ account: LocalAccount; reverify?: () => Promise<Address> }> {
  const backend = config.signer
  if (!backend) throw new ConfigError('resolveAccount called while disarmed')
  if (backend.kind === 'agent') {
    const socketPath = backend.socketPath
    const account = await createAgentAccount({ socketPath })
    const expected = backend.expectedAddress
    if (expected && !isAddressEqual(account.address, expected)) {
      throw new ConfigError(
        `signing agent address (${account.address}) does not match LIQUIDATOR_ADDRESS (${expected}) — the daemon would sign for the wrong wallet`
      )
    }
    return { account, reverify: async () => (await createAgentAccount({ socketPath })).address }
  }
  return { account: privateKeyToAccount(backend.privateKey) }
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
    warnOnLooseSecrets(home)
    const chainId = resolveChainId(opts)
    env = mergedQueuedEnv({ home, chainId })
    const chain = await resolveChain(Number(chainId))
    config = resolveConfig({ env, chain, chainId, opts, home })
  } catch (error) {
    fail('startup.error', error)
    return error instanceof ConfigError ? 2 : 1
  }

  const logger: Logger = createLogger(config.logLevel)
  // In agent mode a still-set LIQUIDATOR_PRIVATE_KEY is dead weight the operator opted out of.
  if (config.signer?.kind === 'agent' && env.LIQUIDATOR_PRIVATE_KEY) {
    logger.warn('queued.key_ignored', {
      chainId: config.chainId,
      detail:
        'SIGNER_SOCKET is set, so LIQUIDATOR_PRIVATE_KEY is ignored — remove it from the queued env'
    })
  }

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

  let account: LocalAccount | null = null
  let reverify: (() => Promise<Address>) | undefined
  if (config.signer) {
    try {
      ;({ account, reverify } = await resolveAccount(config))
    } catch (error) {
      fail('startup.error', error)
      releaseLock(lockPath)
      return error instanceof ConfigError ? 2 : 1
    }
  }

  // Wired after `triggerShutdown` exists (below); the engine calls it on a fatal reconcile drift.
  let fatalTrigger: ((code: number) => void) | null = null
  const engine = createEngine({
    config,
    account,
    logger,
    home,
    reverifyAddress: reverify,
    onFatal: code => fatalTrigger?.(code)
  })

  try {
    await engine.start()
  } catch (error) {
    fail('startup.error', error)
    releaseLock(lockPath)
    return error instanceof ConfigError ? 2 : 1
  }

  const server = createQueuedServer({ socketPath: config.socketPath, engine, log: logger })
  try {
    await server.listen()
  } catch (error) {
    fail('queued.bind_error', error)
    await engine.shutdown()
    releaseLock(lockPath)
    return 1
  }

  logger.info('queued.listening', {
    socket: config.socketPath,
    chainId: config.chainId,
    address: account?.address ?? null,
    armed: account !== null,
    dryRun: config.dryRun
  })

  return new Promise<number>(resolve => {
    let shuttingDown = false
    const triggerShutdown = async (signal: string, code: number): Promise<void> => {
      if (shuttingDown) return
      shuttingDown = true
      logger.info('queued.shutdown', { signal, code })
      await engine.shutdown()
      await server.close()
      releaseLock(lockPath)
      resolve(code)
    }
    fatalTrigger = code => void triggerShutdown('fatal', code)
    process.once('SIGTERM', () => void triggerShutdown('SIGTERM', 0))
    process.once('SIGINT', () => void triggerShutdown('SIGINT', 0))
  })
}

const program = new Command('morpho-queued')
  .description(
    'The per-chain, domain-agnostic transaction-queue daemon. Long-lived: any bot pipes tx/outcome ' +
      'records to it over a Unix socket; it owns dedupe, backoff, re-sim, fees, nonce, submit, and ' +
      'continuous settlement/RBF. Terminal outcomes append to <home>/queued/outcomes-<chain>.jsonl; ' +
      'all logs go to stderr. Config/state live under ~/.morpho-bots (MORPHO_BOTS_HOME overrides).'
  )
  .option('--chain <id>', 'chain id to serve (required; else CHAIN_ID env)')
  .option(
    '--socket <path>',
    'unix socket path (default: QUEUED_SOCKET env, or <home>/queued-<chain>.sock)'
  )
  .option(
    '--dry-run',
    'disarmed: run the full pipeline and emit would_submit, never touching a signer'
  )
  .exitOverride()
  .action(async (opts: QueuedOpts) => {
    process.exitCode = await runQueued(opts)
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
