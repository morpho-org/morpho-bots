import type { Data, JournalEntry, JournalSink, JournalWrite, RunnerOptions } from '@repo/engine'
import type { FileHandle } from 'node:fs/promises'

import {
  decode,
  DEFAULT_JOURNAL_IO_TIMEOUT_MS,
  encode,
  expandJournalWrite,
  JOURNAL_FORMAT,
  JournalIoTimeoutError,
  validateJournalLimits
} from '@repo/engine'
import { randomUUID } from 'node:crypto'
import * as fileSystem from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { JournalFileError, MissingBuildIdentityError } from './errors'

export const JOURNAL_FILE_FORMAT = 1
export const JOURNAL_FILE_SUFFIX = '.journal.jsonl'

export type JournalBuildIdentity = Readonly<{
  revision: string
  imageTag: string
}>

export type JournalHeader = Readonly<{
  type: 'header'
  fileFormat: typeof JOURNAL_FILE_FORMAT
  journalFormat: typeof JOURNAL_FORMAT
  graph: string
  run: string
  startedAt: number
  build: JournalBuildIdentity
}>

type JournalEnd = Readonly<{ type: 'end'; endedAt: number }>

export type JournalReadResult =
  | Readonly<{
      status: 'clean'
      header: JournalHeader
      entries: readonly JournalEntry[]
      end: JournalEnd
    }>
  | Readonly<{
      status: 'truncated'
      header?: JournalHeader
      entries: readonly JournalEntry[]
      truncatedBytes: number
    }>
  | Readonly<{
      status: 'corrupt'
      header?: JournalHeader
      entries: readonly JournalEntry[]
      line: number
      reason: string
    }>

export type JournalWritableFile = Pick<FileHandle, 'writeFile' | 'datasync' | 'sync' | 'close'>
export type JournalFileSystem = Readonly<{
  mkdir: (path: string, options: { recursive: true; mode: number }) => Promise<string | undefined>
  chmod: (path: string, mode: number) => Promise<void>
  open: (path: string, flags: string, mode?: number) => Promise<JournalWritableFile>
  writeFile?: (
    file: JournalWritableFile,
    data: Buffer,
    options: { signal?: AbortSignal }
  ) => Promise<void>
  readFile: (path: string) => Promise<Buffer>
}>

const defaultFileSystem: JournalFileSystem = {
  ...fileSystem,
  writeFile: (file, data, options) =>
    fileSystem.writeFile(file as FileHandle, data, { signal: options.signal })
}

const lineOf = (value: Data) => Buffer.from(`${encode(value)}\n`)

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

type CreationFiles = Readonly<{
  open: JournalFileSystem['open']
  close: (file: JournalWritableFile) => Promise<void>
}>

const syncDirectory = async (path: string, fs: JournalFileSystem) => {
  const directory = await fs.open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

const syncCreationDirectory = async (path: string, files: CreationFiles) => {
  const directory = await files.open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await files.close(directory)
  }
}

const createdDirectories = (firstCreated: string | undefined, target: string) => {
  if (!firstCreated) return []
  const first = resolve(firstCreated)
  const created: string[] = []
  for (let directory = resolve(target); ; directory = dirname(directory)) {
    created.push(directory)
    if (directory === first) break
    if (directory === dirname(directory))
      throw new JournalFileError('locate its created directory', undefined)
  }
  return created.toReversed()
}

const syncCreatedDirectories = async (created: readonly string[], files: CreationFiles) => {
  for (const directory of created) await syncCreationDirectory(dirname(directory), files)
}

export type JournalFileOptions = Readonly<{
  directory: string
  graph: string
  build: JournalBuildIdentity
  capacityBytes: number
  runId?: string
  now?: () => number
  ioTimeoutMs?: number
  describe?: (error: unknown) => string
}>

const imageTag = (value: unknown) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) &&
  !/(?:api[-_]?key|credential|password|private|rpc|secret|sk[-_]?live|token)/i.test(value) &&
  !/^(?:0x)?[0-9A-Fa-f]{64}$/.test(value)

const revision = (value: unknown) => typeof value === 'string' && /^[0-9A-Fa-f]{6,40}$/.test(value)

const buildIdentity = (value: unknown): value is JournalBuildIdentity =>
  record(value) &&
  Object.hasOwn(value, 'imageTag') &&
  Object.hasOwn(value, 'revision') &&
  Object.keys(value).every(field => field === 'imageTag' || field === 'revision') &&
  imageTag(value.imageTag) &&
  revision(value.revision)

/** The build the image says it is: `BUILD_REVISION` (a git commit) and `BUILD_IMAGE_TAG`, both required. */
export const buildIdentityFromEnv = (
  env: Readonly<Record<string, string | undefined>>
): JournalBuildIdentity => {
  const build = { revision: env.BUILD_REVISION?.trim(), imageTag: env.BUILD_IMAGE_TAG?.trim() }
  if (!buildIdentity(build)) throw new MissingBuildIdentityError()
  return build
}

export const createJournalFileSink = async (
  options: JournalFileOptions,
  fs: JournalFileSystem = defaultFileSystem
): Promise<
  Readonly<{
    path: string
    header: JournalHeader
    journal: NonNullable<RunnerOptions['journal']>
    finalize: () => Promise<void>
  }>
> => {
  validateJournalLimits(options)
  if (!buildIdentity(options.build)) throw new JournalFileError('use its build identity', undefined)
  const now = options.now ?? Date.now
  const run = options.runId ?? randomUUID()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(run))
    throw new JournalFileError('use its run id', undefined)
  const startedAt = now()
  const header: JournalHeader = {
    type: 'header',
    fileFormat: JOURNAL_FILE_FORMAT,
    journalFormat: JOURNAL_FORMAT,
    graph: options.graph,
    run,
    startedAt,
    build: options.build
  }
  const path = join(options.directory, `${startedAt}-${run}${JOURNAL_FILE_SUFFIX}`)
  let encodedHeader: Buffer
  try {
    encodedHeader = lineOf(header)
  } catch (error) {
    throw new JournalFileError('encode its header', error)
  }
  const timeoutMs = options.ioTimeoutMs ?? DEFAULT_JOURNAL_IO_TIMEOUT_MS
  const controller = new AbortController()
  const opened = new Set<JournalWritableFile>()
  const close = async (file: JournalWritableFile) => {
    if (!opened.delete(file)) return
    await file.close()
  }
  const open: JournalFileSystem['open'] = async (...arguments_) => {
    const file = await fs.open(...arguments_)
    if (controller.signal.aborted) {
      try {
        await file.close()
      } catch {}
      controller.signal.throwIfAborted()
    }
    opened.add(file)
    return file
  }
  const files = { open, close }
  const creating = (async () => {
    let file: JournalWritableFile
    try {
      const firstCreated = await fs.mkdir(options.directory, { recursive: true, mode: 0o700 })
      controller.signal.throwIfAborted()
      const created = createdDirectories(firstCreated, options.directory)
      for (const directory of created) {
        await fs.chmod(directory, 0o700)
        controller.signal.throwIfAborted()
      }
      await syncCreatedDirectories(created, files)
      controller.signal.throwIfAborted()
      file = await open(path, 'wx', 0o600)
      controller.signal.throwIfAborted()
    } catch (error) {
      throw new JournalFileError('open durably', error)
    }
    try {
      await (fs.writeFile?.(file, encodedHeader, { signal: controller.signal }) ??
        file.writeFile(encodedHeader))
      controller.signal.throwIfAborted()
      await file.datasync()
      controller.signal.throwIfAborted()
      await syncCreationDirectory(options.directory, files)
      controller.signal.throwIfAborted()
    } catch (error) {
      try {
        await close(file)
      } catch {}
      throw new JournalFileError('write its header durably', error)
    }
    opened.delete(file)
    return file
  })()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new JournalIoTimeoutError('create', timeoutMs)
      controller.abort(error)
      for (const file of opened) {
        opened.delete(file)
        try {
          void file.close().catch(() => undefined)
        } catch {}
      }
      reject(error)
    }, timeoutMs)
  })
  let file: JournalWritableFile
  try {
    file = await Promise.race([creating, timeout])
  } finally {
    clearTimeout(timer)
  }

  let finalized = false
  const writeFrame = (frame: Buffer, signal?: AbortSignal) =>
    fs.writeFile?.(file, frame, { signal }) ?? file.writeFile(frame)
  const sink: JournalSink = {
    append: async (entry, signal) => {
      if (finalized) throw new JournalFileError('append after finalization', undefined)
      try {
        signal?.throwIfAborted()
        await writeFrame(lineOf({ type: 'entry', entry }), signal)
        signal?.throwIfAborted()
        await file.datasync()
        signal?.throwIfAborted()
      } catch (error) {
        throw new JournalFileError('append durably', error)
      }
    },
    finalize: async (signal, result) => {
      if (finalized) return
      finalized = true
      let failure: JournalFileError | undefined
      if (result?.clean !== false) {
        try {
          signal?.throwIfAborted()
          await writeFrame(lineOf({ type: 'end', endedAt: now() }), signal)
          signal?.throwIfAborted()
          await file.datasync()
          signal?.throwIfAborted()
          await file.sync()
          signal?.throwIfAborted()
        } catch (error) {
          failure = new JournalFileError('finalize durably', error)
        }
      }
      try {
        await file.close()
        await syncDirectory(options.directory, fs)
      } catch (error) {
        failure ??= new JournalFileError('close durably', error)
      }
      if (failure) throw failure
    }
  }
  const finalize = async () => {
    const finalizeController = new AbortController()
    let finalizeTimer: ReturnType<typeof setTimeout> | undefined
    const finalizeTimeout = new Promise<never>((_, reject) => {
      finalizeTimer = setTimeout(() => {
        finalizeController.abort()
        reject(new JournalIoTimeoutError('finalize', timeoutMs))
      }, timeoutMs)
    })
    try {
      await Promise.race([sink.finalize(finalizeController.signal), finalizeTimeout])
    } finally {
      clearTimeout(finalizeTimer)
    }
  }
  const journal = {
    sink,
    capacityBytes: options.capacityBytes,
    ...(options.ioTimeoutMs !== undefined && { ioTimeoutMs: options.ioTimeoutMs }),
    ...(options.describe && { describe: options.describe })
  }
  return { path, header, journal, finalize }
}

const exactFields = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
) => {
  const allowed = new Set([...required, ...optional])
  return (
    required.every(field => Object.hasOwn(value, field)) &&
    Object.keys(value).every(field => allowed.has(field))
  )
}

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const stamp = (value: unknown) =>
  record(value) &&
  exactFields(value, ['at', 'seq']) &&
  Number.isSafeInteger(value.seq) &&
  finite(value.at)

const stringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string')

const journalWrite = (value: unknown): value is JournalWrite => {
  if (!record(value) || typeof value.node !== 'string') return false
  if ('value' in value) return exactFields(value, ['node', 'value'])
  if (!record(value.delta) || value.delta.kind !== 'keyed-complete') return false
  return (
    exactFields(value, ['delta', 'node']) &&
    exactFields(value.delta, ['entries', 'fields', 'kind', 'removed']) &&
    record(value.delta.fields) &&
    record(value.delta.entries) &&
    stringArray(value.delta.removed)
  )
}

const journalStepFields = (value: Record<string, unknown>) =>
  stamp(value.stamp) &&
  Array.isArray(value.writes) &&
  value.writes.every(journalWrite) &&
  (value.wakes === undefined || stringArray(value.wakes))

const journalStep = (value: unknown) =>
  record(value) && exactFields(value, ['stamp', 'writes'], ['wakes']) && journalStepFields(value)

const journalEntry = (value: unknown): value is JournalEntry => {
  if (!record(value)) return false
  if (value.kind === 'note')
    return (
      exactFields(value, ['at', 'effect', 'kind', 'note']) &&
      typeof value.effect === 'string' &&
      finite(value.at)
    )
  if (value.kind === 'recovery')
    return (
      exactFields(value, ['at', 'kind', 'origin']) &&
      typeof value.origin === 'string' &&
      finite(value.at)
    )
  if (value.kind === 'failed')
    return (
      exactFields(value, ['at', 'kind'], ['description', 'origin', 'step']) &&
      finite(value.at) &&
      (value.origin === undefined || typeof value.origin === 'string') &&
      (value.description === undefined || typeof value.description === 'string') &&
      (value.step === undefined || journalStep(value.step))
    )
  return (
    value.kind === 'step' &&
    exactFields(value, ['derived', 'kind', 'stamp', 'writes'], ['wakes']) &&
    journalStepFields(value) &&
    Array.isArray(value.derived) &&
    value.derived.every(
      item =>
        record(item) &&
        exactFields(item, ['digest', 'node']) &&
        typeof item.node === 'string' &&
        typeof item.digest === 'string'
    )
  )
}

const journalHeader = (value: unknown): value is JournalHeader =>
  record(value) &&
  exactFields(value, [
    'build',
    'fileFormat',
    'graph',
    'journalFormat',
    'run',
    'startedAt',
    'type'
  ]) &&
  value.type === 'header' &&
  value.fileFormat === JOURNAL_FILE_FORMAT &&
  value.journalFormat === JOURNAL_FORMAT &&
  typeof value.graph === 'string' &&
  typeof value.run === 'string' &&
  finite(value.startedAt) &&
  buildIdentity(value.build)

const journalEnd = (value: unknown): value is JournalEnd =>
  record(value) &&
  exactFields(value, ['endedAt', 'type']) &&
  value.type === 'end' &&
  finite(value.endedAt)

type ReadState = {
  header?: JournalHeader
  entries: JournalEntry[]
  end?: JournalEnd
  deltas?: Parameters<typeof expandJournalWrite>[1]
}

const corruption = (state: ReadState, line: number, reason: string): JournalReadResult => ({
  status: 'corrupt',
  ...(state.header && { header: state.header }),
  entries: state.entries,
  line,
  reason
})

const invalidStepWrites = (entry: Extract<JournalEntry, { kind: 'step' }>, state: ReadState) => {
  for (const write of entry.writes) {
    if (state.deltas && expandJournalWrite(write, state.deltas) === undefined)
      return 'invalid keyed delta chain'
  }
  return undefined
}

const invalidEntryWrites = (entry: JournalEntry, state: ReadState) => {
  if (entry.kind === 'step') return invalidStepWrites(entry, state)
  if (entry.kind === 'failed' && entry.step?.writes.some(write => 'delta' in write))
    return 'a failed step contains a keyed delta'
  return undefined
}

const readLine = (line: string, index: number, state: ReadState): JournalReadResult | undefined => {
  let frame: Data
  try {
    frame = decode(line)
    if (encode(frame) !== line) return corruption(state, index + 1, 'non-canonical encoding')
  } catch {
    return corruption(state, index + 1, 'invalid encoding')
  }
  if (index === 0) {
    if (!journalHeader(frame)) return corruption(state, 1, 'invalid header')
    state.header = frame
    return undefined
  }
  if (!record(frame)) return corruption(state, index + 1, 'invalid frame')
  if (
    frame.type === 'entry' &&
    exactFields(frame, ['entry', 'type']) &&
    journalEntry(frame.entry) &&
    !state.end
  ) {
    const reason = invalidEntryWrites(frame.entry, state)
    if (reason) return corruption(state, index + 1, reason)
    state.entries.push(frame.entry)
    return undefined
  }
  if (journalEnd(frame) && !state.end) {
    state.end = frame
    return undefined
  }
  return corruption(state, index + 1, 'invalid frame order or shape')
}

export const readJournalFile = async (
  path: string,
  fs: Pick<JournalFileSystem, 'readFile'> = defaultFileSystem
): Promise<JournalReadResult> => {
  const bytes = await fs.readFile(path)
  const terminated = bytes.at(-1) === 0x0a
  const finalBreak = bytes.lastIndexOf(0x0a)
  const completeBytes = terminated ? bytes : bytes.subarray(0, finalBreak + 1)
  const truncatedBytes = terminated ? 0 : bytes.length - finalBreak - 1
  const state: ReadState = { entries: [], deltas: new Map() }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let lineStart = 0
  let line = 0
  for (let index = 0; index < completeBytes.length; index++) {
    if (completeBytes[index] !== 0x0a) continue
    let decoded: string
    try {
      decoded = decoder.decode(completeBytes.subarray(lineStart, index))
    } catch {
      return corruption(state, line + 1, 'invalid utf-8')
    }
    lineStart = index + 1
    const failed = readLine(decoded, line++, state)
    if (failed) return failed
  }

  if (!terminated || !state.end || !state.header)
    return {
      status: 'truncated',
      ...(state.header && { header: state.header }),
      entries: state.entries,
      truncatedBytes
    }
  return { status: 'clean', header: state.header, entries: state.entries, end: state.end }
}
