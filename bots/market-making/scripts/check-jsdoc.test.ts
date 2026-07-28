import { describe, expect, test } from 'bun:test'

import { inspectJSDocSource } from './check-jsdoc'

const inspect = (source: string) => inspectJSDocSource('fixture.ts', source)

const valid = `
/** Reads provider state without writes. */
export interface Reader {
  /**
   * Reads one value from the provider without writes.
   * @param id - Identifier to read.
   * @returns The decoded provider value.
   * @throws When the provider rejects or returns malformed data.
   */
  read(id: string): Promise<string>
}
`

describe('JSDoc contract checker', () => {
  test('accepts a substantive declaration with matching contract tags', () => {
    expect(inspect(valid).failures).toEqual([])
  })

  test('rejects a missing parameter tag', () => {
    expect(
      inspect(valid.replace('   * @param id - Identifier to read.\n', '')).failures
    ).toContainEqual(expect.objectContaining({ rule: 'params', declaration: 'Reader.read' }))
  })

  test('rejects a stale parameter tag', () => {
    expect(inspect(valid.replace('@param id', '@param stale')).failures).toContainEqual(
      expect.objectContaining({ rule: 'params', declaration: 'Reader.read' })
    )
  })

  test('rejects a missing returns tag for a non-void callable', () => {
    expect(
      inspect(valid.replace('   * @returns The decoded provider value.\n', '')).failures
    ).toContainEqual(expect.objectContaining({ rule: 'returns', declaration: 'Reader.read' }))
  })

  test('rejects missing throws documentation at a provider boundary', () => {
    expect(
      inspect(
        valid.replace('   * @throws When the provider rejects or returns malformed data.\n', '')
      ).failures
    ).toContainEqual(expect.objectContaining({ rule: 'throws', declaration: 'Reader.read' }))
  })

  test('rejects filler summaries', () => {
    expect(
      inspect(valid.replace('Reads one value from the provider without writes.', 'Does the thing.'))
        .failures
    ).toContainEqual(expect.objectContaining({ rule: 'summary', declaration: 'Reader.read' }))
  })

  test('checks scoped concurrency, deadline, and read-only semantics', () => {
    const source = `
/** Setup service. */
export class SetupCheckService {
  /** Checks setup. @returns A report. */
  check(): Promise<string> { return Promise.resolve('ok') }
}
/** State service. */
export class ViemSetupStateService {
  /** Inspects offers. @param maker - Maker. @returns Offers. @throws On provider rejection. */
  inspectOffers(maker: string): Promise<string[]> { return Promise.resolve([]) }
}
`
    const failures = inspect(source).failures
    expect(failures).toContainEqual(
      expect.objectContaining({ rule: 'concurrency', declaration: 'SetupCheckService.check' })
    )
    expect(failures).toContainEqual(
      expect.objectContaining({ rule: 'read-only', declaration: 'SetupCheckService.check' })
    )
    expect(failures).toContainEqual(
      expect.objectContaining({
        rule: 'deadline',
        declaration: 'ViemSetupStateService.inspectOffers'
      })
    )
  })
})
