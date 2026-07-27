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
  return new Cli(new VersionService(), () => ({ assertReady }))
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
