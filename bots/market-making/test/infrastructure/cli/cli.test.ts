import { describe, expect, mock, test } from 'bun:test'

import { PositionBootstrapHaltedError } from '../../../src/application/position-bootstrap-halted.error'
import { VersionService } from '../../../src/application/version.service'
import { Cli } from '../../../src/infrastructure/cli/cli'
import { CliUsageError } from '../../../src/infrastructure/cli/cli-usage.error'
import { runMarketMakingEntrypoint } from '../../../src/infrastructure/cli/market-making-entrypoint'

const readyReport = {
  ready: true,
  checks: [
    { name: 'native-balance' as const, status: 'passed' as const, observed: 10n, required: 10n }
  ]
}

const cli = (assertReady = async () => readyReport) => {
  return new Cli(
    new VersionService(),
    () => ({ assertReady }),
    () => ({ runOnce: async () => [] }),
    () => ({ runOnce: async () => [] })
  )
}

const runEntrypoint = async (argv: readonly string[]) => {
  const process = Bun.spawn(
    [Bun.which('bun') ?? 'bun', 'bots/market-making/src/index.ts', ...argv],
    {
      cwd: `${import.meta.dir}/../../../../..`,
      env: { PATH: Bun.env.PATH },
      stdout: 'pipe',
      stderr: 'pipe'
    }
  )
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text()
  ])
  return { exitCode, output: stdout + stderr }
}

describe('Cli', () => {
  test('mm --version returns 0.0.0', async () => {
    expect(await cli().run(['--version'])).toBe('0.0.0')
  })

  test('entrypoint --version succeeds without loading runtime setup environment', async () => {
    const process = Bun.spawn(
      [Bun.which('bun') ?? 'bun', 'bots/market-making/src/index.ts', '--version'],
      {
        cwd: `${import.meta.dir}/../../../../..`,
        env: { PATH: Bun.env.PATH },
        stdout: 'pipe',
        stderr: 'pipe'
      }
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text()
    ])

    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe('0.0.0')
    expect(stderr).toBe('')
  })

  test('entrypoint setup-check never emits provider URL credentials or nested request text', async () => {
    const markers = [
      'rpc-user',
      'rpc-pass',
      'rpc-token',
      'archive-token',
      'morpho-key',
      'router-key',
      '127.0.0.1',
      '/rpc',
      '/archive',
      '/morpho',
      '/router',
      'http://',
      'https://',
      'fragment',
      '"origin"'
    ]
    const process = Bun.spawn(
      [Bun.which('bun') ?? 'bun', 'bots/market-making/src/index.ts', 'setup-check'],
      {
        cwd: `${import.meta.dir}/../../../../..`,
        env: {
          PATH: Bun.env.PATH,
          CHAIN_ID: '8453',
          RPC_URL: `https://${markers[0]}:${markers[1]}@127.0.0.1:1/rpc?key=${markers[2]}#fragment`,
          REFERENCE_RPC_URL: `http://127.0.0.1:1/archive?token=${markers[3]}`,
          MAKER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
          MAKER_ADDRESS: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
          MIDNIGHT_ADDRESS: '0x2222222222222222222222222222222222222222',
          LOAN_ASSET_ADDRESS: '0x3333333333333333333333333333333333333333',
          RATIFIER_ADDRESS: '0xd6e70365C8E8DDa9a4ca662C07bbE663b017755E',
          MARKET_IDS: `0x${'55'.repeat(32)}`,
          REFERENCE_MARKET_ID: `0x${'77'.repeat(32)}`,
          NATIVE_RESERVE_WEI: '10',
          MAXIMUM_LEND_EXPOSURE_ASSETS: '100',
          MORPHO_API_BASE_URL: `http://127.0.0.1:1/morpho?key=${markers[4]}`,
          ROUTER_API_BASE_URL: `http://127.0.0.1:1/router?key=${markers[5]}`,
          REQUEST_TIMEOUT_MS: '50'
        },
        stdout: 'pipe',
        stderr: 'pipe'
      }
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text()
    ])
    const output = stdout + stderr

    expect(exitCode).toBe(1)
    expect(output).toContain('"name":"chain"')
    for (const marker of markers) expect(output).not.toContain(marker)
  })

  test('mm -v is an alias for --version', async () => {
    expect(await cli().run(['-v'])).toBe('0.0.0')
  })

  test('rejects an unknown command', async () => {
    const error = await cli()
      .run(['bogus'])
      .catch(value => value)

    expect(error).toBeInstanceOf(CliUsageError)
    expect(error).toEqual(
      expect.objectContaining({ name: 'CliUsageError', code: 'INVALID_USAGE', kind: 'usage' })
    )
    expect((error as Error).message).toBe('Invalid command-line usage')
    expect(error).not.toHaveProperty('cause')
    expect(error).not.toHaveProperty('command')
  })

  test('rejects an empty argv', async () => {
    const error = await cli()
      .run([])
      .catch(value => value)
    expect(error).toBeInstanceOf(CliUsageError)
    expect(error).toMatchObject({
      name: 'CliUsageError',
      code: 'INVALID_USAGE',
      kind: 'usage'
    })
    expect((error as Error).message).toBe('Invalid command-line usage')
    expect(error).not.toHaveProperty('cause')
    expect(error).not.toHaveProperty('command')
  })

  test.each([
    ['hostile unknown option', ['--token=option-secret-7f3a']],
    [
      'URL-shaped unknown command',
      ['https://url-user:url-pass@host-secret.example/private/path?apiKey=query-secret#fragment']
    ]
  ])('entrypoint sanitizes %s', async (_name, argv) => {
    const markers = [
      'option-secret-7f3a',
      'url-user',
      'url-pass',
      'host-secret.example',
      '/private/path',
      'query-secret',
      'fragment',
      'CommanderError',
      'unknown option',
      'unknown command'
    ]
    const { exitCode, output } = await runEntrypoint(argv)

    expect(exitCode).toBe(1)
    expect(output.trim()).toBe('Invalid command-line usage')
    for (const marker of markers) expect(output).not.toContain(marker)
  })

  test('passes an explicit --config path to the command configuration boundary', async () => {
    let configPath: string | undefined
    const application = new Cli(
      new VersionService(),
      options => {
        configPath = options.configPath
        return { assertReady: async () => readyReport }
      },
      () => ({ runOnce: async () => [] }),
      () => ({ runOnce: async () => [] })
    )

    await application.run(['--config', 'operator.yml', 'setup-check'])

    expect(configPath).toBe('operator.yml')
  })

  test('runs setup-check and returns the complete structured report', async () => {
    expect(await cli().run(['setup-check'])).toEqual(readyReport)
  })

  test('mm bootstrap triggers one explicit position-bootstrap run', async () => {
    const runOnce = mock(async () => [
      { marketId: `0x${'11'.repeat(32)}`, status: 'applied', action: 'publish', assets: 10n }
    ])
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => ({ runOnce }),
      () => ({ runOnce: async () => [] })
    )

    expect(await application.run(['bootstrap'])).toEqual([
      { marketId: `0x${'11'.repeat(32)}`, status: 'applied', action: 'publish', assets: 10n }
    ])
    expect(runOnce).toHaveBeenCalledTimes(1)
  })

  test('mm ladder is exposed alongside setup-check and bootstrap', async () => {
    const assertReady = mock(async () => readyReport)
    const bootstrap = mock(async () => [])
    const runOnce = mock(async () => [
      { marketId: `0x${'11'.repeat(32)}`, status: 'observed', action: 'rest' }
    ])
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady }),
      () => ({ runOnce: bootstrap }),
      () => ({ runOnce })
    )

    expect(await application.run(['ladder'])).toEqual([
      { marketId: `0x${'11'.repeat(32)}`, status: 'observed', action: 'rest' }
    ])
    expect(runOnce).toHaveBeenCalledTimes(1)
    expect(assertReady).not.toHaveBeenCalled()
    expect(bootstrap).not.toHaveBeenCalled()
  })

  test('rejects a bootstrap cycle containing a failed market result', async () => {
    const report = [
      {
        marketId: `0x${'11'.repeat(32)}`,
        status: 'failed',
        stage: 'make',
        invalidated: false,
        errorName: 'ProviderWriteError'
      }
    ]
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => ({ runOnce: async () => report }),
      () => ({ runOnce: async () => [] })
    )

    const error = await application.run(['bootstrap']).catch(value => value)

    expect(error).toBeInstanceOf(PositionBootstrapHaltedError)
    expect(error).toMatchObject({ report })
  })

  test('rejects a bootstrap cycle containing a strategy-wide safety halt', async () => {
    const report = [
      {
        marketId: `0x${'11'.repeat(32)}`,
        status: 'halted',
        stage: 'reference-read',
        strategyInvalidated: true,
        errorName: 'ProviderReadError'
      }
    ]
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => ({
        runOnce: async () => report
      }),
      () => ({ runOnce: async () => [] })
    )

    const error = await application.run(['bootstrap']).catch(value => value)

    expect(error).toBeInstanceOf(PositionBootstrapHaltedError)
    expect(error).toMatchObject({
      code: 'POSITION_BOOTSTRAP_HALTED',
      kind: 'safety-halt',
      report
    })
    expect((error as Error).message).toBe('Position bootstrap halted for safety')
  })

  test('entrypoint emits a halted report and returns a non-zero exit code', async () => {
    const report = [
      {
        marketId: `0x${'11'.repeat(32)}`,
        status: 'halted',
        stage: 'reference-read',
        strategyInvalidated: true,
        errorName: 'ProviderReadError'
      }
    ]
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = await runMarketMakingEntrypoint(
      { run: async () => Promise.reject(new PositionBootstrapHaltedError(report)) },
      ['bootstrap'],
      { writeOut: value => stdout.push(value), writeError: value => stderr.push(value) }
    )

    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr).toEqual([JSON.stringify(report)])
  })

  test('propagates a readiness failure for a deterministic non-zero entrypoint exit', async () => {
    const failure = new Error('Setup check failed: chain')

    expect(cli(async () => Promise.reject(failure)).run(['setup-check'])).rejects.toBe(failure)
  })
})
