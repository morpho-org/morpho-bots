import type { Hex } from 'viem'

import { $ } from 'execa'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'

import type { MarketReport } from '../../../src/application/engine/market-report'
import type { QuoterRunReport } from '../../../src/errors'

import { VersionService } from '../../../src/application/quoter-bot/version.service'
import { createApplication } from '../../../src/bootstrap'
import {
  OfferInvalidationFailedError,
  QuoterRunFailedError,
  CliUsageError
} from '../../../src/errors'
import { Cli } from '../../../src/infrastructure/cli/cli'
import { runQuoterBotEntrypoint } from '../../../src/infrastructure/cli/quoter-bot-entrypoint'

const readyReport = {
  ready: true,
  checks: [
    { name: 'native-balance' as const, status: 'passed' as const, observed: 10n, required: 10n }
  ]
}

const stopped: QuoterRunReport = { status: 'stopped', reason: 'signal' }

const runs = (
  overrides: Partial<{
    runOnce: (parameters: {
      signal: AbortSignal
      verbose: boolean
    }) => Promise<readonly MarketReport[]>
    runContinuously: (parameters: {
      signal: AbortSignal
      verbose: boolean
    }) => Promise<QuoterRunReport>
  }> = {}
) => ({
  runOnce: async () => [] as readonly MarketReport[],
  runContinuously: async () => stopped,
  ...overrides
})

const marketId = `0x${'11'.repeat(32)}` as const

const cli = (assertReady = async () => readyReport) => {
  return new Cli(
    new VersionService(),
    () => ({ assertReady }),
    () => runs(),
    () => runs()
  )
}

const REPO_ROOT = `${dirname(fileURLToPath(import.meta.url))}/../../../../..`

// The entrypoint is TypeScript, so the subprocess runs it through tsx rather than a bare node. `reject:
// false` keeps a non-zero exit as a value (these tests assert on exit codes), and the env is passed
// explicitly so no ambient config leaks in — only PATH plus whatever the case sets.
const runEntrypointWith = async (
  argv: readonly string[],
  env: Record<string, string | undefined> = {}
) => {
  const { exitCode, stdout, stderr } = await $({
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, ...env },
    extendEnv: false,
    reject: false
  })`tsx bots/quoter-bot/src/index.ts ${argv}`
  return { exitCode: exitCode ?? 0, stdout, stderr }
}

/** Runs the production application in-process against an empty environment. */
const runInProcess = async (argv: readonly string[]) => {
  const stdout: string[] = []
  const stderr: string[] = []
  const exitCode = await runQuoterBotEntrypoint(createApplication({}), argv, {
    writeOut: value => stdout.push(value),
    writeError: value => stderr.push(value)
  })
  return { exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
}

const runEntrypoint = async (argv: readonly string[]) => {
  const { exitCode, stdout, stderr } = await runInProcess(argv)
  return { exitCode, output: stdout + stderr }
}

const expectHumanFailure = (stderr: string[], message: string, details: unknown) => {
  expect(stderr).toHaveLength(1)
  const [header, ...serializedDetails] = (stderr[0] ?? '').split('\n')
  expect(header).toBe(`Error: ${message}`)
  expect(JSON.parse(serializedDetails.join('\n'))).toEqual(details)
}

describe('Cli', () => {
  test('morpho-quoter --version returns the dev placeholder on unbundled runs', async () => {
    expect(await cli().run(['--version'])).toBe('0.0.0-dev')
  })

  test('entrypoint --version succeeds without loading runtime setup environment', async () => {
    const { exitCode, stdout, stderr } = await runInProcess(['--version'])

    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe('0.0.0-dev')
    expect(stderr).toBe('')
  })

  test('entrypoint --json --version emits a valid JSON string', async () => {
    const { exitCode, stdout, stderr } = await runInProcess(['--json', '--version'])

    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout)).toBe('0.0.0-dev')
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
    const { exitCode, stdout, stderr } = await runEntrypointWith(['setup-check'], {
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
      MAX_FEE_GWEI: '100',
      MAX_TRANSACTION_SPEND_WEI: '100000000000000000',
      MAX_CONTINUOUS_FEE_CAP: '0',
      KERNEL_ENROLLMENT: 'enrolling',
      MAX_PUBLICATION_GAS: '5000000',
      MAX_PUBLICATION_DATA_BYTES: '65536',
      MAX_CANCELLATION_GAS: '100000',
      MAX_BATCH_CANCELLATION_GAS: '1000000',
      MAX_BATCH_CANCELLATION_DATA_BYTES: '65536',
      MAX_RATIFICATION_GAS: '100000',
      MORPHO_API_BASE_URL: `http://127.0.0.1:1/morpho?key=${markers[4]}`,
      ROUTER_API_BASE_URL: `http://127.0.0.1:1/router?key=${markers[5]}`,
      REQUEST_TIMEOUT_MS: '50'
    })
    const output = stdout + stderr

    expect(exitCode).toBe(1)
    expect(output).toContain('"name": "chain"')
    for (const marker of markers) expect(output).not.toContain(marker)
  })

  test('morpho-quoter -v is an alias for --version', async () => {
    expect(await cli().run(['-v'])).toBe('0.0.0-dev')
  })

  test('rejects an unknown command', async () => {
    const error = await cli()
      .run(['bogus'])
      .catch(value => value)

    expect(error).toBeInstanceOf(CliUsageError)
    expect(error).toEqual(
      expect.objectContaining({ name: 'CliUsageError', code: 'INVALID_USAGE', kind: 'usage' })
    )
    expect((error as Error).message).toBe('Invalid command-line usage; rerun with --help for usage')
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
    expect((error as Error).message).toBe('Invalid command-line usage; rerun with --help for usage')
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
    expect(output.trim()).toBe('Error: Invalid command-line usage; rerun with --help for usage')
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
      () => runs(),
      () => runs()
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
      () => runs(),
      () => runs()
    )

    await application.run(['--readonly', 'setup-check'])

    expect(readOnly).toBe(true)
  })

  test('accepts --json as a root output option', async () => {
    expect(await cli().run(['--json', 'setup-check'])).toEqual(readyReport)
  })

  test('runs setup-check and returns the complete structured report', async () => {
    expect(await cli().run(['setup-check'])).toEqual(readyReport)
  })

  test('forwards the runtime shutdown signal to startup readiness', async () => {
    const controller = new AbortController()
    const assertReady = vi.fn(async (_signal?: AbortSignal) => readyReport)

    await cli(assertReady).run(['setup-check'], { signal: controller.signal })

    expect(assertReady).toHaveBeenCalledWith(controller.signal)
  })

  test.each(['bootstrap', 'ladder'] as const)(
    'quoter-bot %s runs once until steady and returns each market report',
    async workflow => {
      const reports: readonly MarketReport[] = [
        { workflow, marketId, status: 'applied', action: 'publish' }
      ]
      const runOnce = vi.fn(async () => reports)
      const other = vi.fn(async () => [])
      const assertReady = vi.fn(async () => readyReport)
      const controller = new AbortController()
      const application = new Cli(
        new VersionService(),
        () => ({ assertReady }),
        () => runs(workflow === 'bootstrap' ? { runOnce } : { runOnce: other }),
        () => runs(workflow === 'ladder' ? { runOnce } : { runOnce: other })
      )

      expect(await application.run([workflow], { signal: controller.signal })).toEqual(reports)
      expect(runOnce).toHaveBeenCalledWith({ signal: controller.signal, verbose: false })
      expect(other).not.toHaveBeenCalled()
      expect(assertReady).not.toHaveBeenCalled()
    }
  )

  test('quoter-bot bootstrap --verbose asks for what each market observed', async () => {
    const runOnce = vi.fn(async (_parameters: { signal: AbortSignal; verbose: boolean }) => [])
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => runs({ runOnce }),
      () => runs()
    )

    await application.run(['bootstrap', '--verbose'])

    expect(runOnce.mock.calls[0]?.[0]).toMatchObject({ verbose: true })
  })

  test('quoter-bot bootstrap --monitor runs until the signal and returns the stop report', async () => {
    const runOnce = vi.fn(async () => [])
    const runContinuously = vi.fn(async () => stopped)
    const controller = new AbortController()
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => runs({ runOnce, runContinuously }),
      () => runs()
    )

    expect(
      await application.run(['bootstrap', '--monitor'], { signal: controller.signal })
    ).toEqual(stopped)
    expect(runContinuously).toHaveBeenCalledWith({ signal: controller.signal, verbose: false })
    expect(runOnce).not.toHaveBeenCalled()
  })

  test('quoter-bot bootstrap --monitor --verbose forwards verbose monitoring', async () => {
    const controller = new AbortController()
    const runContinuously = vi.fn(async () => stopped)
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => runs({ runContinuously }),
      () => runs()
    )

    await application.run(['bootstrap', '--monitor', '--verbose'], {
      signal: controller.signal
    })

    expect(runContinuously).toHaveBeenCalledWith({ signal: controller.signal, verbose: true })
  })

  test.each([
    ['ladder', 'runOnce'],
    ['ladder --monitor', 'runContinuously'],
    ['bootstrap', 'runOnce']
  ] as const)('quoter-bot %s surfaces a failed run unchanged', async (command, method) => {
    const failure = new QuoterRunFailedError({
      status: 'halted',
      reason: 'halted',
      halt: 'market-failure-budget: ladder',
      markets: [
        {
          workflow: 'ladder',
          marketId,
          status: 'failed',
          stage: 'act',
          errorName: 'KernelPlanError'
        }
      ]
    })
    const service = runs({ [method]: async () => Promise.reject(failure) })
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => service,
      () => service
    )

    await expect(application.run(command.split(' '))).rejects.toBe(failure)
  })

  test('quoter-bot invalidate targets every active maker group and streams submitted hashes', async () => {
    const groupId = `0x${'12'.repeat(32)}` as const
    const txHash = `0x${'ab'.repeat(32)}` as const
    const report = {
      status: 'applied' as const,
      scope: 'all' as const,
      matchedGroups: 1,
      invalidatedGroups: [{ groupId, txHash }]
    }
    const run = vi.fn(
      async (parameters?: {
        groupId?: Hex
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
      () => runs(),
      () => runs(),
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

  test('quoter-bot invalidate canonicalizes one explicit group and forwards read-only mode', async () => {
    const groupId = `0x${'ab'.repeat(32)}` as const
    let readOnly: boolean | undefined
    const run = vi.fn(async (_parameters?: { groupId?: Hex }) => ({
      status: 'logged' as const,
      scope: 'group' as const,
      matchedGroups: 1,
      invalidatedGroups: [{ groupId }]
    }))
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => runs(),
      () => runs(),
      options => {
        readOnly = options.readOnly
        return { run }
      }
    )

    await application.run(['invalidate', groupId.toUpperCase().replace('0X', '0x'), '--readonly'])

    expect(readOnly).toBe(true)
    expect(run.mock.calls[0]?.[0]?.groupId).toBe(groupId)
  })

  test('quoter-bot invalidate rejects a malformed group before constructing the writer', async () => {
    const invalidation = vi.fn(() => ({ run: async () => undefined as never }))
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => runs(),
      () => runs(),
      invalidation
    )

    const error = await application.run(['invalidate', '0x1234']).catch(value => value)

    expect(error).toBeInstanceOf(CliUsageError)
    expect(invalidation).not.toHaveBeenCalled()
  })

  test('quoter-bot ladder --monitor --verbose --readonly hands the writer to the run', async () => {
    let readOnly: boolean | undefined
    let factoryWriteEvent: ((value: unknown) => void | Promise<void>) | undefined
    const runContinuously = vi.fn(async () => stopped)
    const controller = new AbortController()
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => runs(),
      options => {
        readOnly = options.readOnly
        factoryWriteEvent = options.writeEvent
        return runs({ runContinuously })
      }
    )
    const writeEvent = () => {}

    expect(
      await application.run(['ladder', '--monitor', '--verbose', '--readonly'], {
        signal: controller.signal,
        writeEvent
      })
    ).toEqual(stopped)
    expect(readOnly).toBe(true)
    expect(factoryWriteEvent).toBe(writeEvent)
    expect(runContinuously).toHaveBeenCalledWith({ signal: controller.signal, verbose: true })
  })

  test('quoter-bot start forwards the shared signal, verbose mode, read-only mode, and writer', async () => {
    let readOnly: boolean | undefined
    let factoryWriteEvent: ((value: unknown) => void | Promise<void>) | undefined
    const runContinuously = vi.fn(async () => stopped)
    const controller = new AbortController()
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => runs(),
      () => runs(),
      undefined,
      options => {
        readOnly = options.readOnly
        factoryWriteEvent = options.writeEvent
        return { runContinuously }
      }
    )
    const writeEvent = () => {}

    expect(
      await application.run(['--readonly', 'start', '--verbose'], {
        signal: controller.signal,
        writeEvent
      })
    ).toEqual(stopped)
    expect(readOnly).toBe(true)
    expect(factoryWriteEvent).toBe(writeEvent)
    expect(runContinuously).toHaveBeenCalledWith({ signal: controller.signal, verbose: true })
  })

  test('quoter-bot start surfaces a halted run unchanged', async () => {
    const failure = new QuoterRunFailedError({ status: 'halted', reason: 'graph-error' })
    const application = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => readyReport }),
      () => runs(),
      () => runs(),
      undefined,
      () => ({ runContinuously: async () => Promise.reject(failure) })
    )

    await expect(application.run(['start'])).rejects.toBe(failure)
  })

  test('entrypoint renders structured output for humans by default', async () => {
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = await runQuoterBotEntrypoint(
      { run: async () => ({ ready: true, checks: [{ name: 'chain', status: 'passed' }] }) },
      ['setup-check'],
      { writeOut: value => stdout.push(value), writeError: value => stderr.push(value) }
    )

    expect(exitCode).toBe(0)
    expect(stdout).toEqual([
      [
        '{',
        '  "ready": true,',
        '  "checks": [',
        '    {',
        '      "name": "chain",',
        '      "status": "passed"',
        '    }',
        '  ]',
        '}'
      ].join('\n')
    ])
    expect(stderr).toEqual([])
  })

  test('entrypoint emits machine-parseable JSON lines with --json', async () => {
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = await runQuoterBotEntrypoint(
      {
        run: async (_argv, runtime) => {
          await runtime?.writeEvent?.({ event: 'cycle.completed', assets: 7n })
          return { status: 'stopped', cycles: 1 }
        }
      },
      ['--json', 'setup-check'],
      { writeOut: value => stdout.push(value), writeError: value => stderr.push(value) }
    )

    expect(exitCode).toBe(0)
    expect(stdout.map(line => JSON.parse(line))).toEqual([
      { event: 'cycle.completed', assets: '7' },
      { status: 'stopped', cycles: 1 }
    ])
    expect(stdout.every(line => !line.includes('\n'))).toBe(true)
    expect(stderr).toEqual([])
  })

  test('entrypoint treats an aborted startup as a clean signal stop', async () => {
    const controller = new AbortController()
    controller.abort()
    const stdout: string[] = []
    const stderr: string[] = []
    const error = new Error('Setup check aborted')
    error.name = 'AbortError'

    const exitCode = await runQuoterBotEntrypoint(
      { run: async () => Promise.reject(error) },
      ['start'],
      { writeOut: value => stdout.push(value), writeError: value => stderr.push(value) },
      { signal: controller.signal }
    )

    expect(exitCode).toBe(0)
    expect(stdout).toEqual([])
    expect(stderr).toEqual([])
  })

  test('entrypoint emits an explicit human-readable error when the bot fails', async () => {
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = await runQuoterBotEntrypoint(
      { run: async () => Promise.reject(new Error('Bot cycle failed')) },
      ['ladder'],
      { writeOut: value => stdout.push(value), writeError: value => stderr.push(value) }
    )

    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expect(stderr).toEqual(['Error: UnknownError'])
  })

  test('entrypoint emits one structured JSON error record with --json', async () => {
    const stderr: string[] = []

    const exitCode = await runQuoterBotEntrypoint(
      { run: async () => Promise.reject(new Error('Bot cycle failed')) },
      ['--json', 'ladder'],
      { writeOut: () => {}, writeError: value => stderr.push(value) }
    )

    expect(exitCode).toBe(1)
    expect(stderr).toHaveLength(1)
    expect(JSON.parse(stderr[0] ?? '')).toEqual({
      level: 'error',
      event: 'quoter-bot.error',
      message: 'UnknownError'
    })
    expect(stderr[0]).not.toContain('\n')
  })

  test('entrypoint does not enable JSON output after the option delimiter', async () => {
    const { exitCode, output } = await runEntrypoint(['invalidate', '--', '--json'])

    expect(exitCode).toBe(1)
    expect(output.trim()).toBe('Error: Invalid command-line usage; rerun with --help for usage')
  })

  test('entrypoint emits a failed run report, its bot.failed record, and a non-zero exit code', async () => {
    const report: QuoterRunReport = {
      status: 'failed',
      reason: 'market-failed',
      markets: [
        {
          workflow: 'bootstrap',
          marketId,
          status: 'halted',
          stage: 'reference-read',
          errorName: 'ProviderReadError'
        }
      ]
    }
    const stdout: string[] = []
    const stderr: string[] = []
    const records: unknown[] = []

    const exitCode = await runQuoterBotEntrypoint(
      { run: async () => Promise.reject(new QuoterRunFailedError(report)) },
      ['bootstrap'],
      { writeOut: value => stdout.push(value), writeError: value => stderr.push(value) },
      {},
      { record: value => void records.push(value), unexpected: () => {} }
    )

    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expectHumanFailure(stderr, 'Quoter run failed', report)
    expect(records).toEqual([
      { event: 'bot.failed', reason: 'market-failed', errorName: 'QuoterRunFailedError' }
    ])
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

    const exitCode = await runQuoterBotEntrypoint(
      { run: async () => Promise.reject(new OfferInvalidationFailedError(report)) },
      ['invalidate'],
      { writeOut: value => stdout.push(value), writeError: value => stderr.push(value) }
    )

    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expectHumanFailure(stderr, 'Offer invalidation failed', report)
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

    const exitCode = await runQuoterBotEntrypoint(
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
    expect(stdout.map(value => JSON.parse(value))).toEqual([cycle, report])
    expect(stderr).toEqual([])
  })

  test("entrypoint emits a halted run's stop report and returns a non-zero exit code", async () => {
    const report: QuoterRunReport = {
      status: 'halted',
      reason: 'cleanup-failed',
      halt: 'readiness: setup-failed',
      errorName: 'KernelStopError',
      setupReady: false
    }
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = await runQuoterBotEntrypoint(
      { run: async () => Promise.reject(new QuoterRunFailedError(report)) },
      ['start'],
      { writeOut: value => stdout.push(value), writeError: value => stderr.push(value) }
    )

    expect(exitCode).toBe(1)
    expect(stdout).toEqual([])
    expectHumanFailure(stderr, 'Quoter run failed', report)
  })

  test('propagates a readiness failure for a deterministic non-zero entrypoint exit', async () => {
    const failure = new Error('Setup check failed: chain')

    await expect(cli(async () => Promise.reject(failure)).run(['setup-check'])).rejects.toBe(
      failure
    )
  })
})
