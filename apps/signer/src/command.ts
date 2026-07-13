import type { LogLevel } from '@repo/bot-kit'
import type { Hex, LocalAccount } from 'viem'

import { createLogger } from '@repo/bot-kit'
import {
  assertSunPathLength,
  botsHome,
  ConfigError,
  signerPolicyFile,
  signerSocketFile
} from '@repo/home'
import { ensureError } from '@repo/utils'
import { readFileSync, unlinkSync } from 'node:fs'
import { connect } from 'node:net'
import { isHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { Policy } from './policy'
import type { SignerServer } from './server'

import { parsePolicy, PolicyConfigError } from './policy'
import { createSignerServer } from './server'

type Env = Record<string, string | undefined>

const PRIVATE_KEY_HEX_LENGTH = 66
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

function resolveSignerKey(env: Env): Hex {
  const key = env.SIGNER_PRIVATE_KEY
  if (key === undefined || key.trim() === '') {
    throw new ConfigError('SIGNER_PRIVATE_KEY is required for morpho-signer')
  }
  if (!isHex(key, { strict: true }) || key.length !== PRIVATE_KEY_HEX_LENGTH) {
    throw new ConfigError('SIGNER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
  }
  return key
}

function loadPolicy(env: Env, home: string): Policy {
  const inline = env.SIGNER_POLICY_JSON?.trim()
  if (inline) {
    try {
      return parsePolicy(JSON.parse(inline))
    } catch (error) {
      throw new ConfigError(`invalid SIGNER_POLICY_JSON: ${ensureError(error).message}`)
    }
  }
  const path = env.SIGNER_POLICY_PATH?.trim() || signerPolicyFile(home)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const detail = ensureError(error).message
    const message =
      (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'cannot read' : 'cannot parse'
    throw new ConfigError(`${message} signer policy ${path}: ${detail}`)
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

function resolveLogLevel(env: Env): LogLevel {
  const level = env.LOG_LEVEL?.trim()
  if (!level) return 'info'
  const match = LOG_LEVELS.find(candidate => candidate === level)
  if (!match)
    throw new ConfigError(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}; got '${level}'`)
  return match
}

function probeStaleSocket(socketPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const clear = () => {
      try {
        unlinkSync(socketPath)
      } catch {}
      resolve()
    }
    const socket = connect(socketPath)
    socket.setTimeout(1_000, () => {
      socket.destroy()
      reject(new ConfigError(`the socket at ${socketPath} did not respond within 1s`))
    })
    socket.on('connect', () => {
      socket.destroy()
      reject(new ConfigError(`a signer is already listening on ${socketPath}`))
    })
    socket.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ECONNREFUSED' || code === 'ENOENT') clear()
      else reject(error)
    })
  })
}

function fail(event: string, error: unknown): void {
  console.error(JSON.stringify({ level: 'error', event, error: ensureError(error).message }))
}

export async function runSigner(opts: { socket?: string | undefined }): Promise<number> {
  const home = botsHome()
  let account: LocalAccount
  let policy: Policy
  let socketPath: string
  let logLevel: LogLevel

  try {
    const env = process.env
    account = privateKeyToAccount(resolveSignerKey(env))
    policy = loadPolicy(env, home)
    socketPath = opts.socket?.trim() || env.SIGNER_SOCKET?.trim() || signerSocketFile(home)
    assertSunPathLength(socketPath)
    await probeStaleSocket(socketPath)
    logLevel = resolveLogLevel(env)
  } catch (error) {
    fail('startup.error', error)
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
    chainId: policy.chainId,
    executor: policy.executor
  })

  return new Promise<number>(resolve => {
    let shuttingDown = false
    const shutdown = (signal: string) => {
      if (shuttingDown) return
      shuttingDown = true
      logger.info('signer.shutdown', { signal })
      void server.close().then(() => resolve(0))
    }
    process.once('SIGTERM', () => shutdown('SIGTERM'))
    process.once('SIGINT', () => shutdown('SIGINT'))
  })
}
