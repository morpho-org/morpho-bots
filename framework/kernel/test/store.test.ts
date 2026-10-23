import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DurableLedger } from '../src'

import { createLedgerStore } from '../src'
import { ecrecoverPlan, publish, T } from './fixtures'
import { Harness } from './harness'
import { midnightId } from './validators'

const liveOfferLedger = (): DurableLedger => {
  const h = new Harness().start()
  h.send({ type: 'Submit', plan: ecrecoverPlan('q', T) })
  h.sign()
  h.materialize(signatures => publish(T, signatures[0]), T)
  h.drive()
  return h.ledger()!
}

describe('the ledger store', () => {
  let directory: string
  let path: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'kernel-store-'))
    path = join(directory, 'ledgers', '8453-maker.json')
  })
  afterEach(() => rm(directory, { recursive: true, force: true }))

  it('reads null only when no file exists', async () => {
    expect(await createLedgerStore(path).read()).toBeNull()
  })

  it('round-trips a ledger the kernel then adopts, in an owner-only file and directory', async () => {
    const ledger = liveOfferLedger()
    expect(ledger.entries[midnightId('g1')]?.state).toBe('exposed')
    const store = createLedgerStore(path)
    await store.write(ledger)
    expect(await store.read()).toEqual(ledger)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(directory, 'ledgers'))).mode & 0o777).toBe(0o700)

    const h = new Harness()
    h.boot('enrolled', await store.read())
    expect(h.state.lifecycle.kind).toBe('starting')
    expect(h.entry(midnightId('g1'))?.state).toBe('exposed')
  })

  it.each([
    ['an empty', ''],
    ['a null', 'null'],
    ['a false', 'false'],
    ['a truncated', '{"header":{"format":1'],
    ['a bad bigint tag', '{"x":{"$bigint":"nope"}}']
  ])(
    'refuses to start in either mode on %s file rather than reading it as absent',
    async (_, text) => {
      await createLedgerStore(path).write(liveOfferLedger())
      await writeFile(path, text)
      const read = await createLedgerStore(path).read()
      for (const enrollment of ['enrolled', 'enrolling'] as const) {
        const h = new Harness()
        h.boot(enrollment, read)
        expect(h.reports().at(-1)).toMatchObject({ outcome: 'refused' })
      }
    }
  )

  it('deletes its own temporaries a crash left before their rename, and nothing else', async () => {
    const store = createLedgerStore(path)
    const before = liveOfferLedger()
    await store.write(before)
    const uuid = randomUUID()
    await writeFile(`${path}.123.${uuid}.tmp`, '{"partial":')
    const sibling = `8453-maker.json.other-account.123.${uuid}.tmp`
    await writeFile(join(directory, 'ledgers', sibling), '')
    expect(await store.read()).toEqual(before)
    expect((await readdir(join(directory, 'ledgers'))).toSorted()).toEqual([
      '8453-maker.json',
      sibling
    ])
  })

  it.each([
    ['a dangling symlink', () => symlink(join(directory, 'nowhere.json'), path)],
    ['a directory', () => mkdir(path)]
  ])('refuses to start in either mode on %s at the path', async (_, make) => {
    await mkdir(join(directory, 'ledgers'))
    await make()
    const read = await createLedgerStore(path).read()
    for (const enrollment of ['enrolled', 'enrolling'] as const) {
      const h = new Harness()
      h.boot(enrollment, read)
      expect(h.reports().at(-1)).toMatchObject({ outcome: 'refused' })
    }
  })

  it('stores the ledger as it was when written, whatever the caller does with it afterwards', async () => {
    const store = createLedgerStore(path)
    const ledger = liveOfferLedger()
    const pending = store.write(ledger)
    ledger.entries = {}
    ledger.nonces = {}
    await pending
    expect(await store.read()).toMatchObject({
      entries: { [midnightId('g1')]: { state: 'exposed' } }
    })
  })

  it('creates only the last directory, and refuses a path whose parent is missing', async () => {
    const deep = createLedgerStore(join(directory, 'missing', 'ledgers', 'x.json'))
    await expect(deep.write(liveOfferLedger())).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('applies writes in call order and keeps going after one fails', async () => {
    const store = createLedgerStore(path)
    const ledger = liveOfferLedger()
    const writes = [1, 2, 3].map(seq =>
      store.write({ ...ledger, header: { ...ledger.header, seq } })
    )
    await Promise.all(writes)
    expect(await store.read()).toMatchObject({ header: { seq: 3 } })

    if (process.getuid?.() === 0) return
    await chmod(join(directory, 'ledgers'), 0o500)
    await expect(store.write({ ...ledger, header: { ...ledger.header, seq: 4 } })).rejects.toThrow()
    await chmod(join(directory, 'ledgers'), 0o700)
    await store.write({ ...ledger, header: { ...ledger.header, seq: 5 } })
    expect(await store.read()).toMatchObject({ header: { seq: 5 } })
    expect(await readdir(join(directory, 'ledgers'))).toEqual(['8453-maker.json'])
  })

  it('reads after the writes already requested, so its cleanup never aborts one', async () => {
    const store = createLedgerStore(path)
    const ledger = liveOfferLedger()
    for (let seq = 1; seq <= 10; seq++) {
      const written = store.write({ ...ledger, header: { ...ledger.header, seq } })
      const read = store.read()
      await expect(written).resolves.toBeUndefined()
      expect(await read).toMatchObject({ header: { seq } })
    }
  })

  it('rejects a read the filesystem refuses, rather than calling the ledger malformed', async () => {
    const store = createLedgerStore(path)
    await store.write(liveOfferLedger())
    await chmod(path, 0o000)
    await expect(store.read()).rejects.toMatchObject({ code: 'EACCES' })
    await chmod(path, 0o600)
  })
})
