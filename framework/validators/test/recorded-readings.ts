import type { Payload, Validator, ValidatorContext } from '@repo/kernel'

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'

type ReadingCase = Readonly<{
  payload: Payload
  witness?: unknown
  context: ValidatorContext
}>

const RECORD = process.env.RECORD_READINGS === '1'

const plain = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)))

/**
 * Pins what `validator` authorizes: each case's claim and reading must match what `fixture` recorded
 * under the validator's `id@version` ({@link Validator.version}). `RECORD_READINGS=1` records a
 * version or case not yet recorded, and never rewrites one that is.
 */
export const itReadsAsRecorded = (
  fixture: URL,
  validator: Validator,
  cases: () =>
    | Readonly<Record<string, ReadingCase>>
    | Promise<Readonly<Record<string, ReadingCase>>>
) => {
  const key = `${validator.id}@${validator.version}`
  it(`reads as recorded under ${key}`, async () => {
    const observed = Object.fromEntries(
      Object.entries(await cases()).map(([name, { payload, witness, context }]) => [
        name,
        plain({
          claims: validator.claims(payload),
          reading: validator.read(payload, witness, context)
        })
      ])
    )
    const recorded = existsSync(fixture)
      ? (JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, Record<string, unknown>>)
      : {}
    if (RECORD) {
      recorded[key] = { ...observed, ...recorded[key] }
      writeFileSync(fixture, `${JSON.stringify(recorded, null, 2)}\n`)
    }
    expect(
      observed,
      `${key} reads differently from its recording: bump the version, or record a new case with RECORD_READINGS=1`
    ).toStrictEqual(recorded[key])
  })
}
