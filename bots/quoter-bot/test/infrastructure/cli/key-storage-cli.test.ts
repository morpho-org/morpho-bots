import { describe, expect, test } from 'vitest'

import { VersionService } from '../../../src/application/quoter-bot/version.service'
import { createApplication } from '../../../src/bootstrap'
import { CliUsageError } from '../../../src/errors'
import { Cli } from '../../../src/infrastructure/cli/cli'
import { runQuoterBotEntrypoint } from '../../../src/infrastructure/cli/quoter-bot-entrypoint'

const runs = () => ({
  runOnce: async () => [],
  runContinuously: async () => ({ status: 'stopped' as const, reason: 'signal' as const })
})

const createCli = () =>
  new Cli(
    new VersionService(),
    () => ({ assertReady: async () => ({ ready: true, checks: [] }) }),
    () => runs(),
    () => runs()
  )

describe('signer key storage CLI options', () => {
  const captured = async (argv: readonly string[]) => {
    let options: Record<string, unknown> | undefined
    const cli = new Cli(
      new VersionService(),
      value => {
        options = value
        return { assertReady: async () => ({ ready: true, checks: [] }) }
      },
      () => runs(),
      () => runs()
    )
    await cli.run(argv)
    return options
  }

  test('passes the legacy --private-key source to configuration loading', async () => {
    expect(await captured(['--private-key', `0x${'11'.repeat(32)}`, 'setup-check'])).toMatchObject({
      signerEnvironment: {
        KEY_STORAGE_METHOD: 'private-key',
        MAKER_PRIVATE_KEY: `0x${'11'.repeat(32)}`
      }
    })
  })

  test('passes keystore path and direct password to configuration loading', async () => {
    expect(
      await captured([
        '--keystore',
        '/secure/maker.json',
        '--password',
        'cli-secret',
        'setup-check'
      ])
    ).toMatchObject({
      signerEnvironment: {
        KEY_STORAGE_METHOD: 'keystore',
        KEYSTORE_PATH: '/secure/maker.json',
        KEYSTORE_PASSWORD: 'cli-secret',
        KEYSTORE_INTERACTIVE: 'false'
      }
    })
  })

  test('passes interactive keystore selection without reading the password in Commander', async () => {
    expect(
      await captured(['--keystore', '/secure/maker.json', '--interactive', 'setup-check'])
    ).toMatchObject({
      signerEnvironment: {
        KEY_STORAGE_METHOD: 'keystore',
        KEYSTORE_PATH: '/secure/maker.json',
        KEYSTORE_PASSWORD: '',
        KEYSTORE_INTERACTIVE: 'true'
      }
    })
  })

  test('rejects simultaneous direct and interactive keystore password modes', async () => {
    await expect(
      createCli().run([
        '--keystore',
        '/secure/maker.json',
        '--password',
        'not-reported',
        '--interactive',
        'setup-check'
      ])
    ).rejects.toBeInstanceOf(CliUsageError)
  })

  test('passes --aws selection while companion AWS fields remain config-driven', async () => {
    expect(await captured(['--aws', 'setup-check'])).toMatchObject({
      signerEnvironment: { KEY_STORAGE_METHOD: 'aws' }
    })
  })

  test.each([
    ['private key', ['--private-key', `0x${'11'.repeat(32)}`]],
    ['keystore', ['--keystore', '/secure/maker.json']],
    ['password', ['--password', 'not-reported']],
    ['interactive', ['--interactive']],
    ['AWS', ['--aws']]
  ])('rejects explicit --readonly combined with %s signer options', async (_name, signerArgs) => {
    await expect(
      createCli().run(['--readonly', ...signerArgs, 'setup-check'])
    ).rejects.toBeInstanceOf(CliUsageError)
  })

  test('warns in CLI help that private-key and password argv values are exposed', async () => {
    const help = await createCli().run(['--help'])

    expect(help).toContain('--private-key <key>')
    expect(help).toContain('MAKER_PRIVATE_KEY')
    expect(help).toContain('process listings and shell history')
    expect(help).toContain('--password <password>')
    expect(help).toContain('KEYSTORE_PASSWORD')
    expect(help).toContain('--interactive')
  })

  test('entrypoint --help emits both argv warnings without exposing an ambient secret', async () => {
    const secret = 'must-not-appear-in-help-output'
    const lines: string[] = []
    const exitCode = await runQuoterBotEntrypoint(
      createApplication({ MAKER_PRIVATE_KEY: secret, KEYSTORE_PASSWORD: secret }),
      ['--help'],
      { writeOut: value => lines.push(value), writeError: value => lines.push(value) }
    )
    const output = lines.join('\n')

    expect(exitCode).toBe(0)
    expect(output).toContain('--private-key <key>')
    expect(output).toContain('MAKER_PRIVATE_KEY')
    expect(output).toContain('--password <password>')
    expect(output).toContain('KEYSTORE_PASSWORD')
    expect(output).toContain('process listings and shell history')
    expect(output).not.toContain(secret)
  })
})
