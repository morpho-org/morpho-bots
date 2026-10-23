import type { JournalEntry } from '@repo/engine'

import {
  createGraph,
  createRunner,
  encode,
  GraphDefinitionError,
  JournalFailedError,
  JournalIoTimeoutError,
  JournalOverflowError,
  RunnerFinalizationError
} from '@repo/engine'
import { tryCatch } from '@repo/utils'
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { JournalFileSystem, JournalWritableFile } from '../src/journal-file'

import { MissingBuildIdentityError } from '../src/errors'
import { buildIdentityFromEnv, createJournalFileSink, readJournalFile } from '../src/journal-file'

const temporary: string[] = []
const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), 'journal-file-'))
  temporary.push(path)
  return path
}

afterEach(async () => {
  for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true })
})

const note: JournalEntry = { kind: 'note', effect: 'guard', at: 2, note: { verdict: 'act' } }
const build = { revision: 'abc123', imageTag: 'production' } as const
const capacityBytes = 1_000_000

describe('a journal file', () => {
  it('acknowledges an append only after its frame is durable', async () => {
    const calls: string[] = []
    const durable = Promise.withResolvers<void>()
    let syncs = 0
    const file: JournalWritableFile = {
      writeFile: async () => void calls.push('write'),
      datasync: async () => {
        calls.push('fdatasync')
        if (++syncs === 2) await durable.promise
      },
      sync: async () => void calls.push('sync'),
      close: async () => void calls.push('close')
    }
    const folder: JournalWritableFile = {
      ...file,
      sync: async () => void calls.push('directory sync'),
      close: async () => void calls.push('directory close')
    }
    const fs: JournalFileSystem = {
      mkdir: async () => undefined,
      chmod: async () => undefined,
      open: async (_path, flags) => (flags === 'r' ? folder : file),
      readFile: async () => Buffer.of()
    }
    const created = await createJournalFileSink(
      { directory: '/journal', graph: 'bot', build, capacityBytes, runId: 'run', now: () => 1 },
      fs
    )
    let acknowledged = false
    const appending = created.journal.sink.append(note).then(() => {
      acknowledged = true
    })
    await Promise.resolve()
    expect(acknowledged).toBe(false)
    expect(calls).toStrictEqual([
      'write',
      'fdatasync',
      'directory sync',
      'directory close',
      'write',
      'fdatasync'
    ])
    durable.resolve()
    await appending
    expect(acknowledged).toBe(true)
    await created.journal.sink.finalize()
    expect(calls.slice(-6)).toStrictEqual([
      'write',
      'fdatasync',
      'sync',
      'close',
      'directory sync',
      'directory close'
    ])
  })

  it('never reads a run as clean when datasync rejects with more frames queued', async () => {
    const frames: Buffer[] = []
    let syncs = 0
    const file: JournalWritableFile = {
      writeFile: async frame => void frames.push(Buffer.from(frame)),
      datasync: async () => {
        if (++syncs === 2) throw new Error('disk failure')
      },
      sync: async () => undefined,
      close: async () => undefined
    }
    const folder: JournalWritableFile = {
      ...file,
      writeFile: async () => undefined,
      datasync: async () => undefined
    }
    const fs: JournalFileSystem = {
      mkdir: async () => undefined,
      chmod: async () => undefined,
      open: async (_path, flags) => (flags === 'r' ? folder : file),
      readFile: async () => Buffer.concat(frames)
    }
    const created = await createJournalFileSink(
      { directory: '/journal', graph: 'bot', build, capacityBytes, runId: 'run', now: () => 1 },
      fs
    )
    const graph = createGraph('bot')
    const values = graph.occurrences<number>('values')
    const runner = createRunner(graph.build(), { journal: created.journal, now: () => 1 })

    for (const value of [1, 2, 3]) runner.push(values, value)

    await expect(runner.stopped).rejects.toBeInstanceOf(JournalFailedError)
    const result = await readJournalFile(created.path, fs)
    expect(result.status).toBe('truncated')
    expect(result.entries).toHaveLength(1)
    expect(frames).toHaveLength(2)
  })

  it('syncs every parent entry when it creates nested journal directories', async () => {
    const synced: string[] = []
    const restricted: string[] = []
    const handle: JournalWritableFile = {
      writeFile: async () => undefined,
      datasync: async () => undefined,
      sync: async () => undefined,
      close: async () => undefined
    }
    const fs: JournalFileSystem = {
      mkdir: async () => '/root/new',
      chmod: async path => void restricted.push(path),
      open: async (path, flags) => {
        if (flags === 'r') synced.push(path)
        return handle
      },
      readFile: async () => Buffer.of()
    }
    const created = await createJournalFileSink(
      {
        directory: '/root/new/nested',
        graph: 'bot',
        build,
        capacityBytes,
        runId: 'run',
        now: () => 1
      },
      fs
    )
    expect(restricted).toStrictEqual(['/root/new', '/root/new/nested'])
    expect(synced).toStrictEqual(['/root', '/root/new', '/root/new/nested'])
    await created.journal.sink.finalize()
  })

  it('never reads an overflowing runner journal as clean', async () => {
    const path = await directory()
    const graph = createGraph('overflowing-file')
    const values = graph.occurrences<number>('values')
    const built = graph.build()
    const created = await createJournalFileSink({
      directory: path,
      graph: built.id,
      build,
      capacityBytes: 0,
      runId: 'overflow',
      now: () => 1
    })
    const runner = createRunner(built, { journal: created.journal, now: () => 1 })

    runner.push(values, 1)

    await expect(runner.stopped).rejects.toStrictEqual(new JournalOverflowError(0))
    await expect(readJournalFile(created.path)).resolves.toMatchObject({ status: 'truncated' })
  })

  it('fails creation when the exclusive open exceeds the journal I/O deadline', async () => {
    const fs: JournalFileSystem = {
      mkdir: async () => undefined,
      chmod: async () => undefined,
      open: () => new Promise(() => {}),
      readFile: async () => Buffer.of()
    }

    await expect(
      createJournalFileSink(
        { directory: '/journal', graph: 'bot', build, capacityBytes, runId: 'run', ioTimeoutMs: 5 },
        fs
      )
    ).rejects.toStrictEqual(new JournalIoTimeoutError('create', 5))
  })

  it('closes the file when the header write exceeds the journal I/O deadline', async () => {
    const close = vi.fn(async () => undefined)
    const file: JournalWritableFile = {
      writeFile: () => new Promise(() => {}),
      datasync: async () => undefined,
      sync: async () => undefined,
      close
    }
    const fs: JournalFileSystem = {
      mkdir: async () => undefined,
      chmod: async () => undefined,
      open: async () => file,
      readFile: async () => Buffer.of()
    }

    await expect(
      createJournalFileSink(
        { directory: '/journal', graph: 'bot', build, capacityBytes, runId: 'run', ioTimeoutMs: 5 },
        fs
      )
    ).rejects.toStrictEqual(new JournalIoTimeoutError('create', 5))
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes the file when its header sync exceeds the journal I/O deadline', async () => {
    const close = vi.fn(async () => undefined)
    const file: JournalWritableFile = {
      writeFile: async () => undefined,
      datasync: () => new Promise(() => {}),
      sync: async () => undefined,
      close
    }
    const fs: JournalFileSystem = {
      mkdir: async () => undefined,
      chmod: async () => undefined,
      open: async () => file,
      readFile: async () => Buffer.of()
    }

    await expect(
      createJournalFileSink(
        { directory: '/journal', graph: 'bot', build, capacityBytes, runId: 'run', ioTimeoutMs: 5 },
        fs
      )
    ).rejects.toStrictEqual(new JournalIoTimeoutError('create', 5))
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes open handles when the directory sync exceeds the journal I/O deadline', async () => {
    const fileClose = vi.fn(async () => undefined)
    const directoryClose = vi.fn(async () => undefined)
    const file: JournalWritableFile = {
      writeFile: async () => undefined,
      datasync: async () => undefined,
      sync: async () => undefined,
      close: fileClose
    }
    const folder: JournalWritableFile = {
      ...file,
      sync: () => new Promise(() => {}),
      close: directoryClose
    }
    const fs: JournalFileSystem = {
      mkdir: async () => undefined,
      chmod: async () => undefined,
      open: async (_path, flags) => (flags === 'r' ? folder : file),
      readFile: async () => Buffer.of()
    }

    await expect(
      createJournalFileSink(
        { directory: '/journal', graph: 'bot', build, capacityBytes, runId: 'run', ioTimeoutMs: 5 },
        fs
      )
    ).rejects.toStrictEqual(new JournalIoTimeoutError('create', 5))
    expect(fileClose).toHaveBeenCalledOnce()
    expect(directoryClose).toHaveBeenCalledOnce()
  })

  it('bounds startup cleanup finalization by the journal I/O deadline', async () => {
    let syncs = 0
    const file: JournalWritableFile = {
      writeFile: async () => undefined,
      datasync: () => (++syncs === 1 ? Promise.resolve() : new Promise(() => {})),
      sync: async () => undefined,
      close: async () => undefined
    }
    const fs: JournalFileSystem = {
      mkdir: async () => undefined,
      chmod: async () => undefined,
      open: async () => file,
      readFile: async () => Buffer.of()
    }
    const created = await createJournalFileSink(
      {
        directory: '/journal',
        graph: 'bot',
        build,
        capacityBytes,
        runId: 'run',
        ioTimeoutMs: 5
      },
      fs
    )

    await expect(created.finalize()).rejects.toStrictEqual(new JournalIoTimeoutError('finalize', 5))
  })

  it('validates capacity before creating a journal file', async () => {
    const path = await directory()

    await expect(
      createJournalFileSink({ directory: path, graph: 'bot', build, capacityBytes: -1 })
    ).rejects.toStrictEqual(
      new GraphDefinitionError('a journal needs a non-negative safe-integer byte capacity')
    )
    expect(await readdir(path)).toStrictEqual([])
  })

  it('finalizes a created journal sink when runner construction throws', async () => {
    const path = await directory()
    const graph = createGraph('construction-failure').build()
    const construction = new GraphDefinitionError('runner construction failed')
    const invalid = new Proxy(graph, {
      get: (target, property, receiver) => {
        if (typeof property === 'symbol') throw construction
        return Reflect.get(target, property, receiver)
      }
    })
    const created = await createJournalFileSink({
      directory: path,
      graph: graph.id,
      build,
      capacityBytes,
      runId: 'created',
      now: () => 7
    })

    await expect(
      Promise.resolve().then(async () => {
        try {
          createRunner(invalid, { journal: created.journal })
        } catch (error) {
          const finalized = await tryCatch(created.finalize())
          if (finalized.error) throw new RunnerFinalizationError(error, finalized.error)
          throw error
        }
      })
    ).rejects.toBe(construction)
    const files = await readdir(path)
    expect(files).toStrictEqual(['7-created.journal.jsonl'])
    await expect(readJournalFile(join(path, files[0]!))).resolves.toMatchObject({ status: 'clean' })
  })

  it('leaves old run files untouched when opening a journal', async () => {
    const path = await directory()
    const old = join(path, 'old.journal.jsonl')
    const bytes = Buffer.from('not-json\n')
    await writeFile(old, bytes)

    const created = await createJournalFileSink({
      directory: path,
      graph: 'bot',
      build,
      capacityBytes,
      runId: 'live',
      now: () => 7
    })

    expect(await readFile(old)).toStrictEqual(bytes)
    await created.finalize()
  })

  it('creates one exclusive 0600 file and restricts only the directories it creates', async () => {
    const path = await directory()
    await chmod(path, 0o755)
    const parent = join(path, 'journal')
    const journalDirectory = join(parent, 'runs')
    const options = {
      directory: journalDirectory,
      graph: 'bot',
      build,
      capacityBytes,
      runId: 'run-1',
      now: () => 7
    } as const
    const created = await createJournalFileSink(options)
    await created.journal.sink.append(note)
    await created.journal.sink.finalize()

    expect((await stat(path)).mode & 0o777).toBe(0o755)
    expect((await stat(parent)).mode & 0o777).toBe(0o700)
    expect((await stat(journalDirectory)).mode & 0o777).toBe(0o700)
    expect((await stat(created.path)).mode & 0o777).toBe(0o600)
    await expect(createJournalFileSink(options)).rejects.toThrow('could not open durably')
    expect(await readJournalFile(created.path)).toStrictEqual({
      status: 'clean',
      header: created.header,
      entries: [note],
      end: { type: 'end', endedAt: 7 }
    })
  })

  it.each([
    {
      revision: 'abc123',
      imageTag: 'https://user:secret@example.com/image'
    },
    {
      revision: 'abc123',
      imageTag: 'production',
      credential: 'canary-secret'
    },
    {
      revision: 'abc123',
      imageTag: `0x${'11'.repeat(32)}`
    },
    {
      revision: '11'.repeat(32),
      imageTag: 'production'
    },
    {
      revision: 'sk-live-canary-secret',
      imageTag: 'production'
    },
    {
      revision: 'abc123',
      imageTag: 'canary-secret'
    }
  ])(
    'refuses URL-shaped, credential-shaped, or unexpected build identity data before creating a file',
    async invalid => {
      const path = await directory()
      await expect(
        createJournalFileSink({
          directory: path,
          graph: 'bot',
          build: invalid as never,
          capacityBytes,
          runId: 'rejected',
          now: () => 1
        })
      ).rejects.toThrow('could not use its build identity')
      expect(await readdir(path)).toStrictEqual([])
    }
  )

  it('reports a truncated final frame separately from a malformed terminated frame', async () => {
    const path = await directory()
    const created = await createJournalFileSink({
      directory: path,
      graph: 'bot',
      build,
      capacityBytes,
      runId: 'truncated',
      now: () => 1
    })
    await created.journal.sink.append(note)
    await created.journal.sink.finalize()
    const complete = await readFile(created.path, 'utf8')
    const lines = complete.split('\n')

    await writeFile(created.path, `${lines[0]}\n${lines[1]}\n{"type":"end"`)
    await expect(readJournalFile(created.path)).resolves.toMatchObject({
      status: 'truncated',
      entries: [note],
      truncatedBytes: 13
    })

    await writeFile(created.path, `${lines[0]}\nnot-json\n`)
    await expect(readJournalFile(created.path)).resolves.toMatchObject({
      status: 'corrupt',
      line: 2,
      reason: 'invalid encoding'
    })

    await writeFile(
      created.path,
      `${lines[0]}\n${encode({ type: 'end', endedAt: 1, extra: true })}\n`
    )
    await expect(readJournalFile(created.path)).resolves.toMatchObject({
      status: 'corrupt',
      line: 2,
      reason: 'invalid frame order or shape'
    })

    const invalidUtf8 = Buffer.from(lines[0]!)
    invalidUtf8[invalidUtf8.indexOf('bot')] = 0xff
    await writeFile(created.path, Buffer.concat([invalidUtf8, Buffer.from('\n')]))
    await expect(readJournalFile(created.path)).resolves.toMatchObject({
      status: 'corrupt',
      line: 1,
      reason: 'invalid utf-8'
    })
  })

  it('keeps the valid prefix when a later line is invalid utf-8', async () => {
    const path = await directory()
    const created = await createJournalFileSink({
      directory: path,
      graph: 'bot',
      build,
      capacityBytes,
      runId: 'invalid-utf8',
      now: () => 1
    })
    await created.journal.sink.append(note)
    await created.journal.sink.finalize()
    const [header, entry] = (await readFile(created.path, 'utf8')).split('\n')
    await writeFile(
      created.path,
      Buffer.concat([Buffer.from(`${header}\n${entry}\n`), Buffer.from([0xff, 0x0a])])
    )

    expect(await readJournalFile(created.path)).toStrictEqual({
      status: 'corrupt',
      header: created.header,
      entries: [note],
      line: 3,
      reason: 'invalid utf-8'
    })
  })

  it('rejects a keyed delta embedded in a failed rollback step', async () => {
    const path = await directory()
    const created = await createJournalFileSink({
      directory: path,
      graph: 'bot',
      build,
      capacityBytes,
      runId: 'failed-delta',
      now: () => 1
    })
    await created.journal.sink.finalize()
    const failed: JournalEntry = {
      kind: 'failed',
      origin: 'books',
      at: 2,
      step: {
        stamp: { seq: 1, at: 1 },
        writes: [
          {
            node: 'books',
            delta: {
              kind: 'keyed-complete',
              fields: { coverage: 'complete' },
              entries: { one: { debt: 2 } },
              removed: []
            }
          }
        ]
      }
    }
    await writeFile(
      created.path,
      [
        encode(created.header),
        encode({ type: 'entry', entry: failed }),
        encode({ type: 'end', endedAt: 2 }),
        ''
      ].join('\n')
    )

    await expect(readJournalFile(created.path)).resolves.toMatchObject({
      status: 'corrupt',
      line: 2,
      reason: 'a failed step contains a keyed delta'
    })
  })

  it('reports a keyed delta without an acknowledged complete write as corruption', async () => {
    const path = await directory()
    const created = await createJournalFileSink({
      directory: path,
      graph: 'bot',
      build,
      capacityBytes,
      runId: 'missing-baseline',
      now: () => 1
    })
    await created.journal.sink.finalize()
    const entry: JournalEntry = {
      kind: 'step',
      stamp: { seq: 1, at: 1 },
      writes: [
        {
          node: 'books',
          delta: {
            kind: 'keyed-complete',
            fields: { coverage: 'complete' },
            entries: { one: { debt: 2 } },
            removed: []
          }
        }
      ],
      derived: []
    }
    await writeFile(
      created.path,
      [
        encode(created.header),
        encode({ type: 'entry', entry }),
        encode({ type: 'end', endedAt: 1 }),
        ''
      ].join('\n')
    )

    await expect(readJournalFile(created.path)).resolves.toMatchObject({
      status: 'corrupt',
      line: 2,
      reason: 'invalid keyed delta chain'
    })
  })

  it.each([
    {
      name: 'missing complete coverage',
      fields: {},
      entries: { two: { debt: 2 } },
      removed: []
    },
    {
      name: 'overlapping replacement and removal',
      fields: { coverage: 'complete' },
      entries: { one: { debt: 2 } },
      removed: ['one']
    },
    {
      name: 'removal outside the baseline',
      fields: { coverage: 'complete' },
      entries: {},
      removed: ['two']
    },
    {
      name: 'duplicate removal',
      fields: { coverage: 'complete' },
      entries: {},
      removed: ['one', 'one']
    }
  ])('rejects a keyed delta with $name', async ({ name: _name, ...delta }) => {
    const path = await directory()
    const created = await createJournalFileSink({
      directory: path,
      graph: 'bot',
      build,
      capacityBytes,
      runId: 'invalid-delta',
      now: () => 1
    })
    await created.journal.sink.finalize()
    const baseline: JournalEntry = {
      kind: 'step',
      stamp: { seq: 1, at: 1 },
      writes: [
        {
          node: 'books',
          value: { coverage: 'complete', entries: { one: { debt: 1 } } }
        }
      ],
      derived: []
    }
    const invalid: JournalEntry = {
      kind: 'step',
      stamp: { seq: 2, at: 2 },
      writes: [{ node: 'books', delta: { kind: 'keyed-complete', ...delta } as never }],
      derived: []
    }
    await writeFile(
      created.path,
      [
        encode(created.header),
        encode({ type: 'entry', entry: baseline }),
        encode({ type: 'entry', entry: invalid }),
        encode({ type: 'end', endedAt: 2 }),
        ''
      ].join('\n')
    )

    await expect(readJournalFile(created.path)).resolves.toMatchObject({
      status: 'corrupt',
      line: 3,
      reason: 'invalid keyed delta chain'
    })
  })
})

describe('buildIdentityFromEnv', () => {
  it('reads the build the image names', () => {
    expect(
      buildIdentityFromEnv({
        BUILD_REVISION: ' 0d58dd8e5 ',
        BUILD_IMAGE_TAG: 'vault-v1-reallocation'
      })
    ).toStrictEqual({ revision: '0d58dd8e5', imageTag: 'vault-v1-reallocation' })
  })

  it.each([
    ['no revision', { BUILD_IMAGE_TAG: 'bot' }],
    ['no image tag', { BUILD_REVISION: '0d58dd8e5' }],
    ['a revision that is not a commit', { BUILD_REVISION: 'main', BUILD_IMAGE_TAG: 'bot' }],
    ['an image tag naming a secret', { BUILD_REVISION: '0d58dd8e5', BUILD_IMAGE_TAG: 'rpc-key' }]
  ])('refuses %s', (_, env) => {
    expect(() => buildIdentityFromEnv(env)).toThrow(MissingBuildIdentityError)
  })
})
