#!/usr/bin/env bun
import { Command, CommanderError } from 'commander'

import type { BotName } from './home'

import { runActCommand } from './commands/act'
import { runInit } from './commands/init'
import { runQueueCommand } from './commands/queue'
import { runSenseCommand } from './commands/sense'

const program = new Command('morpho-bots')
  .description(
    'UNIX-pipeable operator CLI for the Morpho curator bots. The pipeline is three one-shot ' +
      'commands per domain: `<domain> sense | <domain> act | <domain> queue`, run in a loop or on ' +
      'a cron. stdout is JSON-Lines data; logs go to stderr. Config and state live under ' +
      '~/.morpho-bots (MORPHO_BOTS_HOME overrides).'
  )
  .exitOverride()

program
  .command('init')
  .description('scaffold the config/state home dir with commented examples (never overwrites)')
  .action(() => {
    process.exitCode = runInit()
  })

for (const domain of ['blue', 'midnight'] as const satisfies readonly BotName[]) {
  const group = program.command(domain).description(`${domain} liquidation bot`)

  group
    .command('sense')
    .description('emit actionable liquidation opportunities as JSON lines on stdout (read-only)')
    .option('--chain <id>', 'chain id (default: CHAIN_ID env, or the sole configured chain)')
    .action(async (opts: { chain?: string }) => {
      process.exitCode = await runSenseCommand(domain, opts)
    })

  group
    .command('act [ids...]')
    .description('map opportunity ids (positional, else stdin) to freshly simulated tx records')
    .option('--chain <id>', 'chain id (default: CHAIN_ID env, or the sole configured chain)')
    .action(async (ids: string[] | undefined, opts: { chain?: string }) => {
      process.exitCode = await runActCommand(domain, opts, ids ?? [])
    })

  group
    .command('queue')
    .description('the stateful sink: dedupe, re-simulate, sign, broadcast, and manage replacement')
    .option('--chain <id>', 'chain id (default: CHAIN_ID env, or the sole configured chain)')
    .action(async (opts: { chain?: string }) => {
      process.exitCode = await runQueueCommand(domain, opts)
    })
}

try {
  await program.parseAsync()
} catch (error) {
  // Usage errors (unknown command, bad flags) are operator errors → exit 2, same contract as bad
  // config: a loop wrapper must stop, not retry. Help/version display is a clean exit.
  if (error instanceof CommanderError) {
    process.exitCode =
      error.code === 'commander.helpDisplayed' || error.code === 'commander.version' ? 0 : 2
  } else {
    throw error
  }
}
