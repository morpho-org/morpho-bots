import type { Server, Socket } from 'node:net'

import { chmodSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:net'

export type UnixJsonServer = { listen(): Promise<void>; close(): Promise<void> }

/** Newline-framed request/response server with ordered handling and private socket permissions. */
export function createUnixJsonServer(options: {
  socketPath: string
  maxLineBytes: number
  handleLine: (line: string) => Promise<string> | string
  oversizeResponse: () => string
}): UnixJsonServer {
  const { socketPath, maxLineBytes, handleLine, oversizeResponse } = options
  const sockets = new Set<Socket>()
  let closed = false

  function onConnection(socket: Socket): void {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => undefined)
    let buffer = ''
    let work = Promise.resolve()
    let rejected = false
    const rejectOversize = () => {
      rejected = true
      socket.write(oversizeResponse())
      buffer = ''
      socket.destroy()
    }
    socket.on('data', chunk => {
      work = work.then(async () => {
        if (rejected) return
        buffer += chunk.toString('utf8')
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          if (Buffer.byteLength(line) > maxLineBytes) {
            rejectOversize()
            return
          }
          if (line.trim()) socket.write(await handleLine(line))
          newline = buffer.indexOf('\n')
        }
        if (Buffer.byteLength(buffer) > maxLineBytes) rejectOversize()
      })
    })
  }

  const server: Server = createServer(onConnection)
  return {
    listen: () =>
      new Promise<void>((resolve, reject) => {
        const umask = process.umask(0o177)
        const onError = (error: Error) => {
          process.umask(umask)
          reject(error)
        }
        server.once('error', onError)
        server.listen(socketPath, () => {
          server.removeListener('error', onError)
          process.umask(umask)
          chmodSync(socketPath, 0o600)
          resolve()
        })
      }),
    close: () => {
      if (closed) return Promise.resolve()
      closed = true
      for (const socket of sockets) socket.destroy()
      return new Promise<void>(resolve =>
        server.close(() => {
          try {
            unlinkSync(socketPath)
          } catch {}
          resolve()
        })
      )
    }
  }
}
