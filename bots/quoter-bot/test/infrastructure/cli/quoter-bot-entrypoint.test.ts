import { describe, expect, test } from 'vitest'

import { VersionService } from '../../../src/application/quoter-bot/version.service'
import { Cli } from '../../../src/infrastructure/cli/cli'
import { QUOTER_BOT_ROOT_VALUE_OPTIONS } from '../../../src/infrastructure/cli/verbose-argv.utils'

const runs = () => ({
  runOnce: async () => [],
  runContinuously: async () => ({ status: 'stopped' as const, reason: 'signal' as const })
})

describe('QUOTER_BOT_ROOT_VALUE_OPTIONS', () => {
  test('names exactly the value-taking root options the CLI declares', async () => {
    const cli = new Cli(
      new VersionService(),
      () => ({ assertReady: async () => ({ ready: true, checks: [] }) }),
      () => runs(),
      () => runs()
    )
    const help = String(await cli.run(['--help']))
    const options = help.slice(help.indexOf('Options:'), help.indexOf('Commands:'))
    const valueFlags = [...options.matchAll(/^ {2}(-\S.*?) <[^>]+>/gm)].flatMap(match =>
      match[1]!.split(', ')
    )

    expect(valueFlags.toSorted()).toEqual([...QUOTER_BOT_ROOT_VALUE_OPTIONS].toSorted())
  })
})
