import type { LogLevel } from '@repo/evm-kit'

import { createLogger } from '@repo/evm-kit'
import { assertSunPathLength, botsHome, ConfigError, queuedSocketFile } from '@repo/home'
import { ensureError } from '@repo/utils'

import { connectQueued } from './client'
import { MAX_TRANSACTION_LINE_BYTES, parseTransactionLine } from './protocol'

type Env = Record<string, string | undefined>
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

function resolveLogLevel(env: Env): LogLevel {
  const level = env.LOG_LEVEL?.trim()
  return LOG_LEVELS.find(candidate => candidate === level) ?? 'info'
}

type StdinLine = { line: string } | { oversize: true }

async function* stdinLines(): AsyncGenerator<StdinLine> {
  let parts: Uint8Array[] = []
  let bytes = 0
  let oversize = false
  for await (const chunk of Bun.stdin.stream()) {
    let start = 0
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue
      const part = chunk.subarray(start, index)
      if (!oversize && bytes + part.byteLength <= MAX_TRANSACTION_LINE_BYTES) {
        parts.push(part)
        yield { line: Buffer.concat(parts).toString('utf8') }
      } else {
        yield { oversize: true }
      }
      parts = []
      bytes = 0
      oversize = false
      start = index + 1
    }
    const remainder = chunk.subarray(start)
    if (!oversize) {
      if (bytes + remainder.byteLength <= MAX_TRANSACTION_LINE_BYTES) {
        parts.push(remainder)
        bytes += remainder.byteLength
      } else {
        parts = []
        bytes = 0
        oversize = true
      }
    }
  }
  if (oversize) yield { oversize: true }
  else if (bytes > 0) yield { line: Buffer.concat(parts).toString('utf8') }
}

export async function runSubmit(opts: { chain?: string | undefined }): Promise<number> {
  const home = botsHome()
  let env: Env
  let chainId: number
  let socketPath: string
  try {
    const rawChain = opts.chain?.trim() || process.env.CHAIN_ID?.trim()
    if (!rawChain || !/^\d+$/.test(rawChain) || Number(rawChain) <= 0) {
      throw new ConfigError('pass a positive --chain <id> or set CHAIN_ID')
    }
    chainId = Number(rawChain)
    env = process.env
    socketPath = env.QUEUED_SOCKET?.trim() || queuedSocketFile(home, rawChain)
    assertSunPathLength(socketPath)
  } catch (error) {
    console.error(
      JSON.stringify({ level: 'error', event: 'submit.startup', error: ensureError(error).message })
    )
    return 2
  }
  const logger = createLogger(resolveLogLevel(env))
  let client
  try {
    client = await connectQueued(socketPath)
  } catch (error) {
    logger.error('submit.connect_failed', { chainId, detail: ensureError(error).message })
    return 1
  }
  try {
    let invalidInput = false
    for await (const framed of stdinLines()) {
      if ('oversize' in framed) {
        logger.warn('submit.skip', { reason: 'oversize' })
        invalidInput = true
        continue
      }
      const line = framed.line.trim()
      if (!line) continue
      let transaction
      try {
        transaction = parseTransactionLine(line, chainId)
      } catch (error) {
        logger.warn('submit.skip', {
          reason: 'invalid_transaction',
          detail: ensureError(error).message
        })
        invalidInput = true
        continue
      }
      try {
        const ack = await client.send(transaction)
        process.stdout.write(`${JSON.stringify(ack)}\n`)
        if (!ack.ok) {
          if (ack.code === 'bad_request' || ack.code === 'chain_mismatch' || ack.code === 'fatal')
            return 2
          if (ack.code === 'retry' || ack.code === 'internal') return 1
        }
      } catch (error) {
        logger.error('submit.failed', { id: transaction.id, detail: ensureError(error).message })
        return 1
      }
    }
    return invalidInput ? 2 : 0
  } finally {
    client.close()
  }
}
