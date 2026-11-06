import { describe, expect, test } from 'vitest'

import {
  enhanceVerboseArgv,
  QUOTER_BOT_VERBOSE_COMMANDS
} from '../../../src/infrastructure/cli/verbose-argv.utils'

const full = {
  BETTERSTACK_SOURCE_TOKEN: 'source-token',
  BETTERSTACK_INGESTING_HOST: 's1.betterstackdata.com'
}
const shipping = { env: full, hasAdditionalSink: false }

describe('enhanceVerboseArgv', () => {
  test('enables verbose diagnostics for exactly the writer commands', () => {
    expect(QUOTER_BOT_VERBOSE_COMMANDS).toEqual(['start', 'bootstrap', 'ladder'])
    for (const command of QUOTER_BOT_VERBOSE_COMMANDS) {
      expect(enhanceVerboseArgv([command], shipping)).toEqual([command, '--verbose'])
    }
    expect(enhanceVerboseArgv(['setup-check'], shipping)).toEqual(['setup-check'])
  })

  test('does not duplicate an explicit verbose flag', () => {
    expect(enhanceVerboseArgv(['start', '--verbose'], shipping)).toEqual(['start', '--verbose'])
  })

  test('recognizes the command without mistaking a config path for one', () => {
    expect(enhanceVerboseArgv(['--config', 'start', 'setup-check'], shipping)).toEqual([
      '--config',
      'start',
      'setup-check'
    ])
    expect(enhanceVerboseArgv(['--config=quoter-bot.yaml', 'ladder'], shipping)).toEqual([
      '--config=quoter-bot.yaml',
      'ladder',
      '--verbose'
    ])
  })

  test('skips value-taking root options before the command', () => {
    expect(
      enhanceVerboseArgv(['--keystore', './maker.json', '--password', 'secret', 'start'], shipping)
    ).toEqual(['--keystore', './maker.json', '--password', 'secret', 'start', '--verbose'])
    expect(
      enhanceVerboseArgv(['--private-key', '0xaa', 'ladder'], { env: {}, hasAdditionalSink: true })
    ).toEqual(['--private-key', '0xaa', 'ladder', '--verbose'])
  })

  test.each([
    ['unset', {}],
    ['token only', { BETTERSTACK_SOURCE_TOKEN: 'source-token' }],
    ['host only', { BETTERSTACK_INGESTING_HOST: 's1.betterstackdata.com' }]
  ])('is inert when shipping config is %s and no other sink is on', (_name, env) => {
    expect(enhanceVerboseArgv(['start'], { env, hasAdditionalSink: false })).toEqual(['start'])
  })

  test('enables verbose diagnostics for an additional sink without shipping config', () => {
    expect(enhanceVerboseArgv(['start'], { env: {}, hasAdditionalSink: true })).toEqual([
      'start',
      '--verbose'
    ])
  })
})
