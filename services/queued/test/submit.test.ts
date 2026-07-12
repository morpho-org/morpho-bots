import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MAX_TRANSACTION_LINE_BYTES } from '../src/protocol'

const CWD = join(import.meta.dir, '..')
const dirs: string[] = []
const servers: ReturnType<typeof createServer>[] = []

const transaction = (id: string, chainId = 8453) => ({
  kind: 'transaction',
  chainId,
  id,
  to: '0x2222222222222222222222222222222222222222',
  data: '0x',
  value: '0'
})

async function stub(
  ack: (record: { id: string }) => unknown = record => ({
    ok: true,
    id: record.id,
    status: 'submitted'
  })
) {
  const dir = mkdtempSync(join(tmpdir(), 'queued-submit-'))
  dirs.push(dir)
  const socketPath = join(dir, 'queue.sock')
  const received: unknown[] = []
  const server = createServer(socket => {
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk.toString()
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const record = JSON.parse(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        received.push(record)
        socket.write(`${JSON.stringify(ack(record))}\n`)
        newline = buffer.indexOf('\n')
      }
    })
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return { socketPath, received }
}

afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>(resolve => server.close(() => resolve()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('morpho-queued submit', () => {
  it('streams valid transactions, reports malformed input, and echoes valid acks', async () => {
    const queue = await stub()
    const proc = Bun.spawn(['bun', 'src/main.ts', 'submit', '--chain', '8453'], {
      cwd: CWD,
      env: { ...process.env, QUEUED_SOCKET: queue.socketPath },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    })
    await proc.stdin.write(
      [JSON.stringify(transaction('a')), '{bad', JSON.stringify(transaction('b'))].join('\n')
    )
    await proc.stdin.end()
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    expect(code).toBe(2)
    expect(queue.received).toEqual([transaction('a'), transaction('b')])
    expect(
      stdout
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
    ).toEqual([
      { ok: true, id: 'a', status: 'submitted' },
      { ok: true, id: 'b', status: 'submitted' }
    ])
  })

  it('bounds an unterminated line, discards it, and continues after its newline', async () => {
    const queue = await stub()
    const proc = Bun.spawn(['bun', 'src/main.ts', 'submit', '--chain', '8453'], {
      cwd: CWD,
      env: { ...process.env, QUEUED_SOCKET: queue.socketPath },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    })
    await proc.stdin.write('x'.repeat(MAX_TRANSACTION_LINE_BYTES + 1))
    await proc.stdin.write(`\n${JSON.stringify(transaction('valid'))}\n`)
    await proc.stdin.end()
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()])
    expect(code).toBe(2)
    expect(queue.received).toEqual([transaction('valid')])
    expect(JSON.parse(stdout.trim())).toEqual({ ok: true, id: 'valid', status: 'submitted' })

    const eofProc = Bun.spawn(['bun', 'src/main.ts', 'submit', '--chain', '8453'], {
      cwd: CWD,
      env: { ...process.env, QUEUED_SOCKET: queue.socketPath },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    })
    await eofProc.stdin.write('x'.repeat(MAX_TRANSACTION_LINE_BYTES + 1))
    await eofProc.stdin.end()
    expect(await eofProc.exited).toBe(2)
    expect(queue.received).toEqual([transaction('valid')])
  })

  it('maps daemon input verdicts to 2 and transient failures to 1', async () => {
    for (const [code, expected] of [
      ['bad_request', 2],
      ['chain_mismatch', 2],
      ['fatal', 2],
      ['retry', 1],
      ['internal', 1]
    ] as const) {
      const queue = await stub(record => ({ ok: false, id: record.id, code, error: code }))
      const proc = Bun.spawn(['bun', 'src/main.ts', 'submit', '--chain', '8453'], {
        cwd: CWD,
        env: { ...process.env, QUEUED_SOCKET: queue.socketPath },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe'
      })
      await proc.stdin.write(JSON.stringify(transaction(code)))
      await proc.stdin.end()
      expect(await proc.exited).toBe(expected)
    }
  })

  it('fails a handoff when the daemon acknowledges a different transaction', async () => {
    const queue = await stub(() => ({ ok: true, id: 'wrong', status: 'submitted' }))
    const proc = Bun.spawn(['bun', 'src/main.ts', 'submit', '--chain', '8453'], {
      cwd: CWD,
      env: { ...process.env, QUEUED_SOCKET: queue.socketPath },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe'
    })
    await proc.stdin.write(JSON.stringify(transaction('expected')))
    await proc.stdin.end()
    expect(await proc.exited).toBe(1)
  })
})
