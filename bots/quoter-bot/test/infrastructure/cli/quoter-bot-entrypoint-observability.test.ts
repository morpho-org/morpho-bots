import { enhanceVerboseArgv } from '@repo/observability'
import { describe, expect, test, vi } from 'vitest'

import { ConfigFileError } from '../../../src/config/config-file.error'
import {
  QUOTER_BOT_VERBOSE_COMMANDS,
  runQuoterBotEntrypoint
} from '../../../src/infrastructure/cli/quoter-bot-entrypoint'
import { MakerAccountError } from '../../../src/infrastructure/make/maker-account.error'

describe('runQuoterBotEntrypoint observability', () => {
  test('mirrors streamed actions and terminal results while preserving stdout', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const record = vi.fn((_value: unknown) => undefined)
    const cycle = { event: 'ladder.cycle', status: 'resting', activeOffers: [{ assets: 9n }] }
    const result = { status: 'stopped', cycles: 1 }

    const exitCode = await runQuoterBotEntrypoint(
      {
        run: async (_argv, runtime) => {
          await runtime?.writeEvent?.(cycle)
          return result
        }
      },
      ['ladder', '--monitor'],
      { writeOut: value => stdout.push(value), writeError: value => stderr.push(value) },
      {},
      { record, unexpected: vi.fn(() => undefined) }
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
    const unexpected = vi.fn((_error: unknown, _origin: 'entrypoint') => undefined)
    const error = new Error('raw provider payload with api credential')
    error.name = 'ProviderFailureError'

    const exitCode = await runQuoterBotEntrypoint(
      { run: async () => Promise.reject(error) },
      ['start'],
      { writeOut: value => stdout.push(value), writeError: value => stderr.push(value) },
      {},
      { record: vi.fn(() => undefined), unexpected }
    )

    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr).toEqual(['Error: UnknownError'])
    expect(unexpected).toHaveBeenCalledWith(error, 'entrypoint')
    expect(stderr.join('')).not.toContain('raw provider')
    expect(stderr.join('')).not.toContain('credential')
  })

  test('surfaces sanitized maker-account failures without reporting them as unexpected', async () => {
    const stderr: string[] = []
    const unexpected = vi.fn((_error: unknown, _origin: 'entrypoint') => undefined)
    const error = new MakerAccountError('keystore-decrypt')

    const exitCode = await runQuoterBotEntrypoint(
      { run: async () => Promise.reject(error) },
      ['setup-check'],
      { writeOut: () => undefined, writeError: value => stderr.push(value) },
      {},
      { record: vi.fn(() => undefined), unexpected }
    )

    expect(exitCode).toBe(1)
    expect(stderr).toEqual(['Error: Maker account keystore-decrypt failed'])
    expect(unexpected).toHaveBeenCalledTimes(0)
  })

  test('suppresses report payloads from errors outside the audited allowlist', async () => {
    const stdout: string[] = []
    const stderr: string[] = []
    const unexpected = vi.fn((_error: unknown, _origin: 'entrypoint') => undefined)
    const error = Object.assign(new Error('raw provider payload'), {
      report: { secret: 'hostile provider response body' }
    })
    error.name = 'ProviderFailureError'

    const exitCode = await runQuoterBotEntrypoint(
      { run: async () => Promise.reject(error) },
      ['start'],
      { writeOut: value => stdout.push(value), writeError: value => stderr.push(value) },
      {},
      { record: vi.fn(() => undefined), unexpected }
    )

    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr).toEqual(['Error: UnknownError'])
    expect(unexpected).toHaveBeenCalledWith(error, 'entrypoint')
    expect(stderr.join('')).not.toContain('hostile provider')
  })

  test('enables verbose diagnostics for exactly the writer commands', () => {
    const env = {
      BETTERSTACK_SOURCE_TOKEN: 'source-token',
      BETTERSTACK_INGESTING_HOST: 's1.betterstackdata.com'
    }

    expect(QUOTER_BOT_VERBOSE_COMMANDS).toEqual(['start', 'bootstrap', 'ladder'])
    for (const command of QUOTER_BOT_VERBOSE_COMMANDS) {
      expect(enhanceVerboseArgv([command], { commands: QUOTER_BOT_VERBOSE_COMMANDS, env })).toEqual(
        [command, '--verbose']
      )
    }
    expect(
      enhanceVerboseArgv(['setup-check'], { commands: QUOTER_BOT_VERBOSE_COMMANDS, env })
    ).toEqual(['setup-check'])
  })

  test('preserves audited configuration diagnostics while still classifying the failure', async () => {
    const stderr: string[] = []
    const unexpected = vi.fn((_error: unknown, _origin: 'entrypoint') => undefined)

    const exitCode = await runQuoterBotEntrypoint(
      { run: async () => Promise.reject(new ConfigFileError('malformed')) },
      ['start'],
      { writeOut: () => undefined, writeError: value => stderr.push(value) },
      {},
      { record: vi.fn(() => undefined), unexpected }
    )

    expect(exitCode).toBe(1)
    expect(stderr).toEqual(['Error: Configuration file contains malformed YAML'])
    expect(unexpected).toHaveBeenCalledTimes(1)
  })
})
