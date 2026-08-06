import { describe, expect, test } from 'bun:test'

import { VersionService } from '../../../src/application/version.service'
import { Cli } from '../../../src/infrastructure/cli/cli'
import { CliUsageError } from '../../../src/infrastructure/cli/cli-usage.error'

const createCli = () =>
  new Cli(
    new VersionService(),
    () => ({ assertReady: async () => ({ ready: true, checks: [] }) }),
    () => ({ runOnce: async () => [] }),
    () => ({ runOnce: async () => [] })
  )

describe('maker key storage CLI options', () => {
  const captured = async (argv: readonly string[]) => {
    let options: Record<string, unknown> | undefined
    const cli = new Cli(
      new VersionService(),
      value => {
        options = value
        return { assertReady: async () => ({ ready: true, checks: [] }) }
      },
      () => ({ runOnce: async () => [] }),
      () => ({ runOnce: async () => [] })
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
})
