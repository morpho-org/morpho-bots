import { unlinkSync } from 'node:fs'
import { connect } from 'node:net'

import { ConfigError } from './config'

/**
 * Distinguish a stale Unix-socket file (a prior daemon died without unlinking) from a live one, so a
 * daemon can safely rebind after a crash without stealing a socket a peer still owns. A connect that
 * succeeds means another daemon owns the socket → refuse (`ConfigError`, so the caller exits 2).
 * Nobody-listening errors (`ECONNREFUSED`; or `ENOENT` — macOS/Bun report this for a stale socket file
 * whose owner died) → unlink the leftover file so `listen` can rebind. Any other error is a genuine
 * problem → propagate.
 *
 * `opts.label` names the daemon in the "already listening" message (e.g. `'a queue daemon'`,
 * `'a signer'`) so each caller's operator-facing text is preserved.
 */
export function probeStaleSocket(socketPath: string, opts: { label: string }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const clearToBind = (): void => {
      try {
        unlinkSync(socketPath)
      } catch {
        // Already gone (or raced with another unlink) — either way we are clear to bind.
      }
      resolve()
    }
    const socket = connect(socketPath)
    socket.setTimeout(1_000, () => {
      socket.destroy()
      reject(new ConfigError(`the socket at ${socketPath} did not respond to a probe within 1s`))
    })
    socket.on('connect', () => {
      socket.destroy()
      reject(new ConfigError(`${opts.label} is already listening on ${socketPath}`))
    })
    socket.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ECONNREFUSED' || code === 'ENOENT') clearToBind()
      else reject(error)
    })
  })
}
