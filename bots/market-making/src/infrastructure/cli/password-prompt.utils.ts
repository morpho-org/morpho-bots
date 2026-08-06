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
}

/**
 * Reads one password from an interactive TTY without echoing secret bytes.
 * @param options - Optional input, output, and cancellation overrides.
 * @returns Password entered before the first line ending.
 */
export const readPasswordInteractively = (options: PasswordPromptOptions = {}) =>
  new Promise<string>((resolve, reject) => {
    const input = options.input ?? process.stdin
    const output = options.output ?? process.stdout
    if (!input.isTTY || !output.isTTY || !input.setRawMode) {
      reject(new CliUsageError())
      return
    }

    const passwordBytes: number[] = []
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
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      for (const byte of bytes) {
        if (byte === 3) {
          finish()
          return
        }
        if (byte === 13 || byte === 10) {
          finish(Buffer.from(passwordBytes).toString('utf8'))
          return
        }
        if (byte === 8 || byte === 127) {
          if (passwordBytes.length > 0) {
            const characters = Array.from(Buffer.from(passwordBytes).toString('utf8'))
            characters.pop()
            passwordBytes.splice(
              0,
              passwordBytes.length,
              ...Buffer.from(characters.join(''), 'utf8')
            )
          }
        } else if (byte >= 32) passwordBytes.push(byte)
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
