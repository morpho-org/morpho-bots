import type { LogLevel } from '@repo/bot-kit'
import type { Policy, SignerServer } from '@repo/signer'
import type { Hex, LocalAccount } from 'viem'

import { createLogger } from '@repo/bot-kit'
import { createSignerServer, parsePolicy, PolicyConfigError } from '@repo/signer'
import { readFileSync, unlinkSync } from 'node:fs'
import { connect } from 'node:net'
import { isHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { ConfigError, mergedSignerEnv, warnOnLooseSecrets } from '../config'
import { botsHome, signerPolicyFile, signerSocketFile } from '../home'
import { fail } from './shared'

type Env = Record<string, string | undefined>

// Same shape as each core's `resolvePrivateKey` validation, re-implemented here so the `signer`
// command stays lens-free (no core import): a 0x-prefixed 32-byte hex string.
const PRIVATE_KEY_HEX_LENGTH = 66 // '0x' + 32 bytes
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
// The kernel caps a Unix socket path (`sun_path`) at ~104 bytes on macOS / 108 on Linux; stay well
// under so the daemon fails loud with a clear message instead of a cryptic bind error.
const MAX_SUN_PATH_BYTES = 100

// The signing agent is the SOLE key holder: it reads its own `SIGNER_PRIVATE_KEY` and deliberately
// does NOT fall back to `LIQUIDATOR_PRIVATE_KEY` — the whole point is to move the key off the queue.
function resolveSignerKey(env: Env): Hex {
  const key = env.SIGNER_PRIVATE_KEY
  if (key === undefined || key.trim() === '') {
    throw new ConfigError(
      'SIGNER_PRIVATE_KEY is required for the signing agent. Move the signer key out of ' +
        'LIQUIDATOR_PRIVATE_KEY into SIGNER_PRIVATE_KEY — the agent is the sole key holder and the ' +
        'queue reads no key when SIGNER_SOCKET is set.'
    )
  }
  if (!isHex(key, { strict: true }) || key.length !== PRIVATE_KEY_HEX_LENGTH) {
    throw new ConfigError('SIGNER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
  }
  return key
}

// Read + parse + compile the policy file. Any failure (missing file, bad JSON, schema/module
// rejection) is operator misconfig → ConfigError → exit 2.
function loadPolicy(env: Env, home: string): Policy {
  const path = env.SIGNER_POLICY_PATH?.trim() || signerPolicyFile(home)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    throw new ConfigError(`cannot read signer policy ${path}: ${(error as Error).message}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ConfigError(`signer policy ${path} is not valid JSON: ${(error as Error).message}`)
  }
  try {
    return parsePolicy(parsed)
  } catch (error) {
    if (error instanceof PolicyConfigError) {
      throw new ConfigError(`invalid signer policy ${path}: ${error.message}`)
    }
    throw error
  }
}

function resolveSocketPath(opts: { socket?: string | undefined }, env: Env, home: string): string {
  const socketPath = opts.socket?.trim() || env.SIGNER_SOCKET?.trim() || signerSocketFile(home)
  const bytes = Buffer.byteLength(socketPath)
  if (bytes > MAX_SUN_PATH_BYTES) {
    throw new ConfigError(
      `signer socket path is ${bytes} bytes; a Unix socket path is capped at ~${MAX_SUN_PATH_BYTES}. ` +
        'Pass --socket or set SIGNER_SOCKET to a shorter path (or move MORPHO_BOTS_HOME closer to root).'
    )
  }
  return socketPath
}

// Distinguish a stale socket file (a prior daemon died without unlinking) from a live one. A
// connect that succeeds means another daemon owns the socket → refuse (exit 2). ECONNREFUSED (file
// present, nobody listening) → unlink so `listen` can rebind. ENOENT (no file) → nothing to do.
function probeStaleSocket(socketPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = connect(socketPath)
    // A hung daemon can accept-and-stall, leaving the probe neither connected nor errored; treat a
    // timed-out probe like a live socket (fail loud) rather than hanging startup forever.
    socket.setTimeout(1_000, () => {
      socket.destroy()
      reject(new ConfigError(`the socket at ${socketPath} did not respond to a probe within 1s`))
    })
    socket.on('connect', () => {
      socket.destroy()
      reject(new ConfigError(`a signer is already listening on ${socketPath}`))
    })
    socket.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ECONNREFUSED') {
        try {
          unlinkSync(socketPath)
        } catch {
          // Raced with another unlink, or the platform reports the file gone — either way we can bind.
        }
        resolve()
      } else if (code === 'ENOENT') {
        resolve()
      } else {
        reject(error)
      }
    })
  })
}

// Mirrors the cores' fail-loud LOG_LEVEL validation: a typo'd value is operator misconfig, not a
// silent downgrade to 'info'.
function resolveLogLevel(env: Env): LogLevel {
  const level = env.LOG_LEVEL?.trim()
  if (!level) return 'info'
  const match = LOG_LEVELS.find(candidate => candidate === level)
  if (!match) {
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}; got '${level}'`)
  }
  return match
}

/**
 * `signer`: the long-lived, policy-enforcing signing daemon — the sole holder of the private key.
 * Resolves config (key, policy, socket path; any operator-fixable problem → ConfigError → exit 2),
 * clears a stale socket, then listens on the Unix socket and blocks until SIGTERM/SIGINT, on which
 * it closes cleanly and resolves 0. A bind failure resolves 1 (transient). The key goes straight
 * into `privateKeyToAccount` and never lands on a logged object; the server logs only tx fields +
 * the signed-tx hash, never the raw signed bytes.
 */
export async function runSignerCommand(opts: { socket?: string | undefined }): Promise<number> {
  const home = botsHome()

  let socketPath: string
  let account: LocalAccount
  let policy: Policy
  let logLevel: LogLevel
  try {
    warnOnLooseSecrets(home)
    const env = mergedSignerEnv({ home })
    const key = resolveSignerKey(env)
    policy = loadPolicy(env, home)
    socketPath = resolveSocketPath(opts, env, home)
    await probeStaleSocket(socketPath)
    account = privateKeyToAccount(key)
    logLevel = resolveLogLevel(env)
  } catch (error) {
    fail('startup.error', error)
    // A ConfigError is operator misconfig (exit 2); anything else here (an unexpected probe error)
    // is transient (exit 1), matching the loop-vs-crash contract of the other commands.
    return error instanceof ConfigError ? 2 : 1
  }

  const logger = createLogger(logLevel)
  const server: SignerServer = createSignerServer({ socketPath, account, policy, log: logger })
  try {
    await server.listen()
  } catch (error) {
    fail('signer.bind_error', error)
    return 1
  }
  logger.info('signer.listening', {
    socket: socketPath,
    address: server.address,
    rules: policy.rules.length
  })

  // Long-lived: block until a shutdown signal, close the socket, then resolve 0.
  return new Promise<number>(resolve => {
    let shuttingDown = false
    const shutdown = (signal: string): void => {
      if (shuttingDown) return
      shuttingDown = true
      logger.info('signer.shutdown', { signal })
      void server.close().then(() => resolve(0))
    }
    process.once('SIGTERM', () => shutdown('SIGTERM'))
    process.once('SIGINT', () => shutdown('SIGINT'))
  })
}
