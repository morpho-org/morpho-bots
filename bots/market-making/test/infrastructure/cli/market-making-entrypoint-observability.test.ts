import { describe, expect, mock, test } from 'bun:test'

import { ConfigFileError } from '../../../src/config/config-file.error'
import { runMarketMakingEntrypoint } from '../../../src/infrastructure/cli/market-making-entrypoint'

describe('runMarketMakingEntrypoint observability', () => {
  test('mirrors streamed actions and terminal results while preserving stdout', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const record = mock((_value: unknown) => undefined)
    const cycle = { event: 'ladder.cycle', status: 'resting', activeOffers: [{ assets: 9n }] }
    const result = { status: 'stopped', cycles: 1 }

    const exitCode = await runMarketMakingEntrypoint(
      {
        run: async (_argv, runtime) => {
          await runtime?.writeEvent?.(cycle)
          return result
        }
      },
      ['ladder', '--monitor'],
      { writeOut: value => stdout.push(value), writeError: value => stderr.push(value) },
      {},
      { record, unexpected: mock(() => undefined) }
    )

    expect(exitCode).toBe(0)
    expect(stdout.map(value => JSON.parse(value))).toEqual([
      { event: 'ladder.cycle', status: 'resting', activeOffers: [{ assets: '9' }] },
      result
    ])
    expect(stderr).toEqual([])
    expect(record.mock.calls.map(call => call[0])).toEqual([cycle, result])
  })

  test('observes unknown failures by name without leaking their message', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const unexpected = mock((_error: unknown, _origin: 'entrypoint') => undefined)
    const error = new Error('raw provider payload with api credential')
    error.name = 'ProviderFailureError'

    const exitCode = await runMarketMakingEntrypoint(
      { run: async () => Promise.reject(error) },
      ['start'],
      { writeOut: value => stdout.push(value), writeError: value => stderr.push(value) },
      {},
      { record: mock(() => undefined), unexpected }
    )

    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr).toEqual(['Error: UnknownError'])
    expect(unexpected).toHaveBeenCalledWith(error, 'entrypoint')
    expect(stderr.join('')).not.toContain('raw provider')
    expect(stderr.join('')).not.toContain('credential')
  })

  test('preserves audited configuration diagnostics while still classifying the failure', async () => {
    const stderr: string[] = []
    const unexpected = mock((_error: unknown, _origin: 'entrypoint') => undefined)

    const exitCode = await runMarketMakingEntrypoint(
      { run: async () => Promise.reject(new ConfigFileError('malformed')) },
      ['start'],
      { writeOut: () => undefined, writeError: value => stderr.push(value) },
      {},
      { record: mock(() => undefined), unexpected }
    )

    expect(exitCode).toBe(1)
    expect(stderr).toEqual(['Error: Configuration file contains malformed YAML'])
    expect(unexpected).toHaveBeenCalledTimes(1)
  })
})
