import type { EventEmitter } from 'node:events'

import { CliUsageError } from './cli-usage.error'

type InteractiveInput = Pick<EventEmitter, 'on' | 'off'> & {
  isTTY?: boolean
  setRawMode?: (enabled: boolean) => unknown
  pause: () => unknown
  resume: () => unknown
}

type InteractiveOutput = {
  isTTY?: boolean
  write: (value: string) => unknown
}

type PasswordPromptOptions = {
  input?: InteractiveInput
  output?: InteractiveOutput
  signal?: AbortSignal
  secretBytes?: number[]
}

/**
 * Reads one password from an interactive TTY without echoing secret bytes.
 * @param options - Optional input, output, cancellation, and mutable-byte-storage overrides.
 * @returns Password entered before the first line ending. Mutable accumulation and conversion
 * buffers are zeroed during cleanup; the returned immutable JavaScript string cannot be wiped.
 */
export const readPasswordInteractively = (options: PasswordPromptOptions = {}) =>
  new Promise<string>((resolve, reject) => {
    const input = options.input ?? process.stdin
    const output = options.output ?? process.stdout
    if (!input.isTTY || !output.isTTY || !input.setRawMode) {
      reject(new CliUsageError())
      return
    }

    const passwordBytes = options.secretBytes ?? []
    let settled = false
    let rawMode = false
    let prompted = false
    const cleanup = () => {
      input.off('data', onData)
      input.off('error', onFailure)
      input.off('end', onFailure)
      options.signal?.removeEventListener('abort', onFailure)
      if (rawMode) {
        try {
          input.setRawMode?.(false)
        } catch {}
      }
      try {
        input.pause()
      } catch {}
      if (prompted) {
        try {
          output.write('\n')
        } catch {}
      }
      passwordBytes.fill(0)
    }
    const finish = (password?: string) => {
      if (settled) return
      settled = true
      cleanup()
      if (password === undefined || password.length === 0) reject(new CliUsageError())
      else resolve(password)
    }
    const onFailure = () => finish()
    const onData = (chunk: Buffer | Uint8Array | string) => {
      const converted = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : undefined
      const bytes: Uint8Array = typeof chunk === 'string' ? converted! : chunk
      try {
        for (const byte of bytes) {
          if (byte === 3) {
            finish()
            return
          }
          if (byte === 13 || byte === 10) {
            const passwordBuffer = Buffer.from(passwordBytes)
            try {
              finish(passwordBuffer.toString('utf8'))
            } finally {
              passwordBuffer.fill(0)
            }
            return
          }
          if (byte === 8 || byte === 127) {
            if (passwordBytes.length > 0) {
              const current = Buffer.from(passwordBytes)
              let replacement: Buffer | undefined
              try {
                const characters = Array.from(current.toString('utf8'))
                characters.pop()
                replacement = Buffer.from(characters.join(''), 'utf8')
                passwordBytes.splice(0, passwordBytes.length, ...replacement)
              } finally {
                current.fill(0)
                replacement?.fill(0)
              }
            }
          } else if (byte >= 32) passwordBytes.push(byte)
        }
      } finally {
        converted?.fill(0)
      }
    }

    input.on('data', onData)
    input.on('error', onFailure)
    input.on('end', onFailure)
    options.signal?.addEventListener('abort', onFailure, { once: true })
    try {
      output.write('Keystore password: ')
      prompted = true
      rawMode = true
      input.setRawMode(true)
      input.resume()
      if (options.signal?.aborted) onFailure()
    } catch {
      onFailure()
    }
  })
