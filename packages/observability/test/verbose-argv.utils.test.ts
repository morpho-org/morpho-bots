import { describe, expect, test } from 'vitest'

import { enhanceVerboseArgv } from '../src/verbose-argv.utils'

const commands = ['start', 'bootstrap', 'ladder']

describe('enhanceVerboseArgv', () => {
  const full = {
    BETTERSTACK_SOURCE_TOKEN: 'source-token',
    BETTERSTACK_INGESTING_HOST: 's1.betterstackdata.com'
  }

  test.each(commands)('enables safe diagnostics for %s with full shipping config', command => {
    expect(enhanceVerboseArgv([command], { commands, env: full })).toEqual([command, '--verbose'])
  })

  test('does not duplicate an explicit verbose flag', () => {
    expect(enhanceVerboseArgv(['start', '--verbose'], { commands, env: full })).toEqual([
      'start',
      '--verbose'
    ])
  })

  test('leaves commands outside the allowlist untouched', () => {
    expect(enhanceVerboseArgv(['setup-check'], { commands, env: full })).toEqual(['setup-check'])
  })

  test('recognizes the command without mistaking a config path for one', () => {
    expect(
      enhanceVerboseArgv(['--config', 'start', 'setup-check'], { commands, env: full })
    ).toEqual(['--config', 'start', 'setup-check'])
    expect(
      enhanceVerboseArgv(['--config=quoter-bot.yaml', 'ladder'], { commands, env: full })
    ).toEqual(['--config=quoter-bot.yaml', 'ladder', '--verbose'])
  })

  test.each([
    ['unset', {}],
    ['token only', { BETTERSTACK_SOURCE_TOKEN: 'source-token' }],
    ['host only', { BETTERSTACK_INGESTING_HOST: 's1.betterstackdata.com' }]
  ])('is inert when shipping config is %s', (_name, env) => {
    expect(enhanceVerboseArgv(['start'], { commands, env })).toEqual(['start'])
  })
})
