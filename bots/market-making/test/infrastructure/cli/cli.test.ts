import { describe, expect, test } from 'bun:test'

import { VersionService } from '../../../src/application/version.service'
import { Cli, formatSetupCheckReport } from '../../../src/infrastructure/cli/cli'

const readyReport = {
  ready: true,
  checks: [
    { name: 'native-balance' as const, status: 'passed' as const, observed: 10n, required: 10n }
  ]
}

function cli(assertReady = async () => readyReport) {
  return new Cli(new VersionService(), { assertReady })
}

describe('Cli', () => {
  test('mm --version returns 0.0.0', async () => {
    expect(await cli().run(['--version'])).toBe('0.0.0')
  })

  test('mm -v is an alias for --version', async () => {
    expect(await cli().run(['-v'])).toBe('0.0.0')
  })

  test('rejects an unknown command', async () => {
    expect(cli().run(['bogus'])).rejects.toThrow(/unknown command/)
  })

  test('rejects an empty argv', async () => {
    expect(cli().run([])).rejects.toThrow('Unknown command: (none)')
  })

  test('runs setup-check and returns a structured bigint-safe report', async () => {
    expect(await cli().run(['setup-check'])).toBe(
      '{"ready":true,"checks":[{"name":"native-balance","status":"passed","observed":"10","required":"10"}]}'
    )
  })

  test('propagates a readiness failure for a deterministic non-zero entrypoint exit', async () => {
    const failure = new Error('Setup check failed: chain')

    expect(cli(async () => Promise.reject(failure)).run(['setup-check'])).rejects.toBe(failure)
  })

  test('formats the complete failed report for the non-zero entrypoint path', () => {
    expect(formatSetupCheckReport({ ...readyReport, ready: false })).toContain('"observed":"10"')
  })
})
