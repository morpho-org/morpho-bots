import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { DurableLedger } from './types'

import { decodeLedger, encodeLedger } from './durable'

/** Stands in for a path that exists but holds no parseable ledger: present, so `Start` refuses it. */
const UNREADABLE = { unreadable: true } as const

const TEMPORARY = '.tmp'

const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')

export type LedgerStore = {
  /**
   * The parsed file for `Start`, after deleting temporaries a crash left behind. `null` only when
   * nothing exists at the path; a symlink, a directory, or an unparseable file is never falsy. It
   * waits for writes already requested, and a filesystem failure rejects rather than reading as
   * malformed.
   */
  read(): Promise<unknown>
  /**
   * Encodes `ledger` at the call and resolves once that snapshot is durable: written to a fresh
   * `0600` file, fsynced, renamed over the old one, and the directory fsynced. Writes apply in call
   * order. A rejected write may still have landed, which is safe: either file is a whole ledger,
   * and the kernel treats the failure as unsafe.
   */
  write(ledger: DurableLedger): Promise<void>
}

const syncDirectory = async (directory: string) => {
  const handle = await open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * The kernel's ledger file. Its directory's parent must already be durable, as a mounted volume is;
 * nothing detects a second process writing the same path, and a volatile overlay mount voids it.
 */
export const createLedgerStore = (path: string): LedgerStore => {
  const directory = dirname(path)
  const ownTemporary = new RegExp(`^${escapeRegExp(basename(path))}\\.\\d+\\.[0-9a-f-]{36}\\.tmp$`)
  let tail: Promise<unknown> = Promise.resolve()
  let parentSynced = false

  const removeTemporaries = async () => {
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    await Promise.all(
      names
        .filter(name => ownTemporary.test(name))
        .map(name => rm(join(directory, name), { force: true }))
    )
  }

  const readNow = async (): Promise<unknown> => {
    await removeTemporaries()
    const found = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (found === undefined) return null
    if (!found.isFile()) return UNREADABLE
    const text = await readFile(path, 'utf8')
    try {
      const parsed: unknown = decodeLedger(text)
      return parsed ? parsed : UNREADABLE
    } catch {
      return UNREADABLE
    }
  }

  /** The parent is synced once per process, so an earlier failed sync or a crash after mkdir is covered. */
  const ensureDirectory = async () => {
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    if (parentSynced) return
    await syncDirectory(dirname(directory))
    parentSynced = true
  }

  const persist = async (text: string) => {
    await ensureDirectory()
    const temporary = `${path}.${process.pid}.${randomUUID()}${TEMPORARY}`
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        await file.writeFile(text, 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, path)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
    await syncDirectory(directory)
  }

  /** Reads and writes share one queue, so a read's cleanup never deletes a write's temporary. */
  const queued = <T>(work: () => Promise<T>) => {
    const done = tail.then(work)
    tail = done.catch(() => undefined)
    return done
  }

  const read = () => queued(readNow)

  const write = (ledger: DurableLedger) => {
    const text = encodeLedger(ledger)
    return queued(() => persist(text))
  }

  return { read, write }
}
