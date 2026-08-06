import { CliUsageError } from './cli-usage.error'

/** Reads one password from an interactive TTY without echoing secret bytes. */
export const readPasswordInteractively = () =>
  new Promise<string>((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
      reject(new CliUsageError())
      return
    }
    const input = process.stdin
    const passwordBytes: number[] = []
    const cleanup = () => {
      input.off('data', onData)
      input.setRawMode(false)
      input.pause()
      process.stdout.write('\n')
    }
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          cleanup()
          reject(new CliUsageError())
          return
        }
        if (byte === 13 || byte === 10) {
          cleanup()
          if (passwordBytes.length === 0) reject(new CliUsageError())
          else resolve(Buffer.from(passwordBytes).toString('utf8'))
          return
        }
        if (byte === 8 || byte === 127) {
          if (passwordBytes.length > 0) {
            passwordBytes.pop()
            while (passwordBytes.length > 0 && ((passwordBytes.at(-1) ?? 0) & 0xc0) === 0x80)
              passwordBytes.pop()
            if ((passwordBytes.at(-1) ?? 0) >= 0xc0) passwordBytes.pop()
          }
        } else if (byte >= 32) passwordBytes.push(byte)
      }
    }
    process.stdout.write('Keystore password: ')
    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
