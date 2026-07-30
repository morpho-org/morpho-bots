import { describe, expect, mock, test } from 'bun:test'

import type { LadderTransactionSubmittedEvent } from '../../../src/application/ladder/ladder-verbose'

import { PositionBootstrapHaltedError } from '../../../src/application/bootstrap/position-bootstrap-halted.error'
import { PositionBootstrapMonitorHaltedError } from '../../../src/application/bootstrap/position-bootstrap-monitor-halted.error'
import { OfferInvalidationFailedError } from '../../../src/application/invalidation/offer-invalidation-failed.error'
import { LadderCycleHaltedError } from '../../../src/application/ladder/ladder-cycle-halted.error'
import { LadderMonitorHaltedError } from '../../../src/application/ladder/ladder-monitor-halted.error'
import { SetupMonitorHaltedError } from '../../../src/application/setup/setup-monitor-halted.error'
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

const failedReport = {
  ready: false,
  checks: [
    { name: 'native-balance' as const, status: 'failed' as const, observed: 9n, required: 10n }
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

  test('passes --readonly as an explicit address-only runtime mode', async () => {
    let readOnly: boolean | undefined
    const application = new Cli(
      new VersionService(),
      options => {
        readOnly = options.readOnly
        return { assertReady: async () => readyReport }
      },
      () => ({ runOnce: async () => [] }),
      () => ({ runOnce: async () => [] })
    )

    await application.run(['--readonly', 'setup-check'])

    expect(readOnly).toBe(true)
  })

  test('runs setup-check and returns the complete structured report', async () => {
    expect(await cli().run(['setup-check'])).toEqual(readyReport)
  })

  test('mm setup-check --monitor streams readiness reports until shutdown', async () => {
    const report = {
      status: 'stopped' as const,
      reason: 'signal' as const,
      cycles: 1
    }
    const assertReady = mock(async () => readyReport)
    const runContinuously = mock(
      async (parameters: {
        signal: AbortSignal
        onCycle?: (result: typeof readyReport) => void | Promise<void>
      }) => {
        await parameters.onCycle?.(readyReport)
        return report
      }
    )
    const streamed: unknown[] = []
    const controller = new AbortController()
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady, runContinuously }),
      () => ({ runOnce: async () => [] }),
      () => ({ runOnce: async () => [] })
    )

    expect(
      await application.run(['setup-check', '--monitor'], {
        signal: controller.signal,
        writeEvent: value => {
          streamed.push(value)
        }
      })
    ).toEqual(report)
    expect(streamed).toEqual([readyReport])
    expect(runContinuously).toHaveBeenCalledTimes(1)
    expect(assertReady).not.toHaveBeenCalled()
  })

  test('mm setup-check --monitor rejects a halted lifecycle report', async () => {
    const report = {
      status: 'halted' as const,
      reason: 'setup-failed' as const,
      cycles: 1,
      lastReport: failedReport
    }
    const application = new Cli(
      new VersionService(),
      () => ({
        assertReady: async () => readyReport,
        runContinuously: async () => report
      }),
      () => ({ runOnce: async () => [] }),
      () => ({ runOnce: async () => [] })
    )

    const error = await application.run(['setup-check', '--monitor']).catch(value => value)

    expect(error).toBeInstanceOf(SetupMonitorHaltedError)
    expect(error).toMatchObject({ report })
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
    expect(runOnce).toHaveBeenCalledWith({ verbose: false })
  })

  test('mm bootstrap --verbose requests expanded bootstrap diagnostics', async () => {
    const txHash = `0x${'aa'.repeat(32)}` as const
    const runOnce = mock(
      async (parameters?: {
        verbose?: boolean
        onTransactionSubmitted?: (event: {
          event: 'bootstrap.transaction-submitted'
          operation: 'publish'
          txHash: typeof txHash
        }) => void | Promise<void>
      }) => {
        await parameters?.onTransactionSubmitted?.({
          event: 'bootstrap.transaction-submitted',
          operation: 'publish',
          txHash
        })
        return []
      }
    )
    const events: unknown[] = []
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => ({ runOnce }),
      () => ({ runOnce: async () => [] })
    )

    expect(
      await application.run(['bootstrap', '--verbose'], {
        writeEvent: event => {
          events.push(event)
        }
      })
    ).toEqual([])
    expect(runOnce.mock.calls[0]?.[0]).toMatchObject({ verbose: true })
    expect(events).toEqual([
      {
        event: 'bootstrap.transaction-submitted',
        operation: 'publish',
        txHash
      }
    ])
  })

  test('mm bootstrap --monitor streams cycles and returns shutdown cleanup evidence', async () => {
    const cycle = [{ marketId: `0x${'11'.repeat(32)}`, status: 'observed', action: 'rest' }]
    const report = {
      status: 'stopped' as const,
      reason: 'signal' as const,
      cycles: 1,
      cleanup: { status: 'applied' as const }
    }
    const runOnce = mock(async () => [])
    const runContinuously = mock(
      async (parameters: {
        signal: AbortSignal
        onCycle?: (result: readonly { status: string; [key: string]: unknown }[]) => void
      }) => {
        await parameters.onCycle?.(cycle)
        return report
      }
    )
    const streamed: unknown[] = []
    const controller = new AbortController()
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => ({ runOnce, runContinuously }),
      () => ({ runOnce: async () => [] })
    )

    expect(
      await application.run(['bootstrap', '--monitor'], {
        signal: controller.signal,
        writeEvent: value => {
          streamed.push(value)
        }
      })
    ).toEqual(report)
    expect(streamed).toEqual([cycle])
    expect(runContinuously).toHaveBeenCalledTimes(1)
    expect(runContinuously.mock.calls[0]?.[0]).toMatchObject({ verbose: false })
    expect(runOnce).not.toHaveBeenCalled()
  })

  test('mm bootstrap --monitor --verbose forwards verbose monitoring', async () => {
    const controller = new AbortController()
    const runContinuously = mock(
      async (_parameters: { signal: AbortSignal; verbose?: boolean }) => ({
        status: 'stopped' as const,
        reason: 'signal' as const,
        cycles: 0,
        cleanup: { status: 'applied' as const }
      })
    )
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => ({ runOnce: async () => [], runContinuously }),
      () => ({ runOnce: async () => [] })
    )

    await application.run(['bootstrap', '--monitor', '--verbose'], {
      signal: controller.signal
    })

    expect(runContinuously.mock.calls[0]?.[0]).toMatchObject({
      signal: controller.signal,
      verbose: true
    })
  })

  test('mm bootstrap --monitor preserves a halted terminal report object', async () => {
    const report = {
      status: 'halted' as const,
      reason: 'cycle-failed' as const,
      cycles: 1,
      cleanup: { status: 'applied' as const },
      lastCycle: [
        {
          marketId: `0x${'11'.repeat(32)}` as const,
          status: 'failed' as const,
          stage: 'make' as const,
          invalidated: false,
          errorName: 'ProviderWriteError'
        }
      ]
    }
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => ({
        runOnce: async () => [],
        runContinuously: async () => report
      }),
      () => ({ runOnce: async () => [] })
    )

    const error = await application.run(['bootstrap', '--monitor']).catch(value => value)

    expect(error).toBeInstanceOf(PositionBootstrapMonitorHaltedError)
    expect(error).toMatchObject({ report })
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

  test('mm invalidate targets every active maker group and streams submitted hashes', async () => {
    const groupId = `0x${'12'.repeat(32)}` as const
    const txHash = `0x${'ab'.repeat(32)}` as const
    const report = {
      status: 'applied' as const,
      scope: 'all' as const,
      matchedGroups: 1,
      invalidatedGroups: [{ groupId, txHash }]
    }
    const run = mock(
      async (parameters?: {
        groupId?: `0x${string}`
        onTransactionSubmitted?: (event: {
          event: 'offer-invalidation.transaction-submitted'
          groupId: typeof groupId
          txHash: typeof txHash
        }) => void | Promise<void>
      }) => {
        await parameters?.onTransactionSubmitted?.({
          event: 'offer-invalidation.transaction-submitted',
          groupId,
          txHash
        })
        return report
      }
    )
    const streamed: unknown[] = []
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => ({ runOnce: async () => [] }),
      () => ({ runOnce: async () => [] }),
      () => ({ run })
    )

    expect(
      await application.run(['invalidate'], {
        writeEvent: event => {
          streamed.push(event)
        }
      })
    ).toEqual(report)
    expect(run.mock.calls[0]?.[0]?.groupId).toBeUndefined()
    expect(streamed).toEqual([
      { event: 'offer-invalidation.transaction-submitted', groupId, txHash }
    ])
  })

  test('mm invalidate canonicalizes one explicit group and forwards read-only mode', async () => {
    const groupId = `0x${'ab'.repeat(32)}` as const
    let readOnly: boolean | undefined
    const run = mock(async (_parameters?: { groupId?: `0x${string}` }) => ({
      status: 'logged' as const,
      scope: 'group' as const,
      matchedGroups: 1,
      invalidatedGroups: [{ groupId }]
    }))
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => ({ runOnce: async () => [] }),
      () => ({ runOnce: async () => [] }),
      options => {
        readOnly = options.readOnly
        return { run }
      }
    )

    await application.run(['invalidate', groupId.toUpperCase().replace('0X', '0x'), '--readonly'])

    expect(readOnly).toBe(true)
    expect(run.mock.calls[0]?.[0]?.groupId).toBe(groupId)
  })

  test('mm invalidate rejects a malformed group before constructing the writer', async () => {
    const invalidation = mock(() => ({ run: async () => undefined as never }))
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => ({ runOnce: async () => [] }),
      () => ({ runOnce: async () => [] }),
      invalidation
    )

    const error = await application.run(['invalidate', '0x1234']).catch(value => value)

    expect(error).toBeInstanceOf(CliUsageError)
    expect(invalidation).not.toHaveBeenCalled()
  })

  test('mm ladder --monitor --verbose --readonly streams cycles and cleanup evidence', async () => {
    const marketId = `0x${'11'.repeat(32)}` as const
    const txHash = `0x${'aa'.repeat(32)}` as const
    const cycle = [{ marketId, status: 'observed' as const, action: 'rest' as const }]
    const report = {
      status: 'stopped' as const,
      reason: 'signal' as const,
      cycles: 1,
      cleanup: { status: 'logged' as const }
    }
    let readOnly: boolean | undefined
    const runContinuously = mock(
      async (parameters: {
        signal: AbortSignal
        verbose?: boolean
        onCycle?: (results: typeof cycle) => void | Promise<void>
        onTransactionSubmitted?: (event: LadderTransactionSubmittedEvent) => void | Promise<void>
      }) => {
        await parameters.onTransactionSubmitted?.({
          event: 'ladder.transaction-submitted',
          operation: 'publish',
          txHash
        })
        await parameters.onCycle?.(cycle)
        return report
      }
    )
    const streamed: unknown[] = []
    const controller = new AbortController()
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => ({ runOnce: async () => [] }),
      options => {
        readOnly = options.readOnly
        return { runOnce: async () => [], runContinuously }
      }
    )

    expect(
      await application.run(['ladder', '--monitor', '--verbose', '--readonly'], {
        signal: controller.signal,
        writeEvent: event => {
          streamed.push(event)
        }
      })
    ).toEqual(report)
    expect(readOnly).toBe(true)
    expect(runContinuously.mock.calls[0]?.[0]).toMatchObject({
      signal: controller.signal,
      verbose: true
    })
    expect(streamed).toEqual([
      {
        event: 'ladder.transaction-submitted',
        operation: 'publish',
        txHash
      },
      cycle
    ])
  })

  test('mm ladder --monitor rejects a halted lifecycle report', async () => {
    const report = {
      status: 'halted' as const,
      reason: 'cycle-failed' as const,
      cycles: 1,
      cleanup: { status: 'applied' as const },
      lastCycle: [
        {
          marketId: `0x${'11'.repeat(32)}` as const,
          status: 'failed' as const,
          stage: 'reconcile' as const,
          invalidated: false as const,
          errorName: 'LadderAdapterError'
        }
      ]
    }
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => ({ runOnce: async () => [] }),
      () => ({
        runOnce: async () => [],
        runContinuously: async () => report
      })
    )

    const error = await application.run(['ladder', '--monitor']).catch(value => value)

    expect(error).toBeInstanceOf(LadderMonitorHaltedError)
    expect(error).toMatchObject({ report })
  })

  test.each(['failed', 'halted'] as const)(
    'rejects a ladder cycle containing a %s market result',
    async status => {
      const report = [
        {
          marketId: `0x${'11'.repeat(32)}`,
          status,
          stage: 'make',
          invalidated: status === 'halted',
          errorName: 'ProviderWriteError'
        }
      ]
      const application = new Cli(
        new VersionService(),
        () => ({ assertReady: async () => readyReport }),
        () => ({ runOnce: async () => [] }),
        () => ({ runOnce: async () => report })
      )

      const error = await application.run(['ladder']).catch(value => value)

      expect(error).toMatchObject({
        name: 'LadderCycleHaltedError',
        code: 'LADDER_CYCLE_HALTED',
        kind: 'safety-halt',
        report
      })
      expect((error as Error).message).toBe('Ladder cycle halted for safety')
    }
  )

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

  test('entrypoint emits an invalidation failure report and returns non-zero', async () => {
    const report = {
      status: 'failed' as const,
      scope: 'group' as const,
      matchedGroups: 1,
      invalidatedGroups: [],
      failures: [
        {
          stage: 'invalidation' as const,
          groupId: `0x${'12'.repeat(32)}` as const,
          errorName: 'OfferInvalidationAdapterError'
        }
      ]
    }
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = await runMarketMakingEntrypoint(
      { run: async () => Promise.reject(new OfferInvalidationFailedError(report)) },
      ['invalidate'],
      { writeOut: value => stdout.push(value), writeError: value => stderr.push(value) }
    )

    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr).toEqual([JSON.stringify(report)])
  })

  test('entrypoint emits a halted setup-monitor report and returns a non-zero exit code', async () => {
    const report = {
      status: 'halted' as const,
      reason: 'setup-failed' as const,
      cycles: 1,
      lastReport: failedReport
    }
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = await runMarketMakingEntrypoint(
      { run: async () => Promise.reject(new SetupMonitorHaltedError(report)) },
      ['setup-check', '--monitor'],
      { writeOut: value => stdout.push(value), writeError: value => stderr.push(value) }
    )

    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr).toEqual([
      JSON.stringify(report, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value
      )
    ])
  })

  test('entrypoint emits a halted bootstrap-monitor object and returns a non-zero exit code', async () => {
    const report = {
      status: 'halted' as const,
      reason: 'cycle-failed' as const,
      cycles: 1,
      cleanup: { status: 'applied' as const },
      lastCycle: [
        {
          marketId: `0x${'11'.repeat(32)}` as const,
          status: 'failed' as const,
          stage: 'make' as const,
          invalidated: false,
          errorName: 'ProviderWriteError'
        }
      ]
    }
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = await runMarketMakingEntrypoint(
      { run: async () => Promise.reject(new PositionBootstrapMonitorHaltedError(report)) },
      ['bootstrap', '--monitor'],
      { writeOut: value => stdout.push(value), writeError: value => stderr.push(value) }
    )

    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr).toEqual([JSON.stringify(report)])
  })

  test('entrypoint writes continuous events before the terminal monitor report', async () => {
    const cycle = [{ status: 'observed', action: 'rest' }]
    const report = {
      status: 'stopped',
      reason: 'signal',
      cycles: 1,
      cleanup: { status: 'logged' }
    }
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = await runMarketMakingEntrypoint(
      {
        run: async (_argv, runtime) => {
          await runtime?.writeEvent?.(cycle)
          return report
        }
      },
      ['bootstrap', '--monitor'],
      { writeOut: value => stdout.push(value), writeError: value => stderr.push(value) }
    )

    expect(exitCode).toBe(0)
    expect(stdout).toEqual([JSON.stringify(cycle), JSON.stringify(report)])
    expect(stderr).toEqual([])
  })

  test('entrypoint emits a failed ladder report and returns a non-zero exit code', async () => {
    const report = [
      {
        marketId: `0x${'11'.repeat(32)}`,
        status: 'failed',
        stage: 'make',
        invalidated: false,
        errorName: 'ProviderWriteError'
      }
    ]
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = await runMarketMakingEntrypoint(
      { run: async () => Promise.reject(new LadderCycleHaltedError(report)) },
      ['ladder'],
      { writeOut: value => stdout.push(value), writeError: value => stderr.push(value) }
    )

    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr).toEqual([JSON.stringify(report)])
  })

  test('entrypoint emits a halted ladder monitor report and returns a non-zero exit code', async () => {
    const report = {
      status: 'halted' as const,
      reason: 'cleanup-failed' as const,
      cycles: 1,
      cleanup: { status: 'failed' as const, errorName: 'LadderHardHaltError' }
    }
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = await runMarketMakingEntrypoint(
      { run: async () => Promise.reject(new LadderMonitorHaltedError(report)) },
      ['ladder', '--monitor'],
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
