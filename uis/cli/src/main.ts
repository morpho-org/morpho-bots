#!/usr/bin/env bun
import { Command, CommanderError } from 'commander'

import type { BotName } from './home'

import { runInit } from './commands/init'
import { runTickCommand } from './commands/tick'

const program = new Command('morpho-bots')
  .description(
    'One-shot operator CLI for the Morpho curator bots. Persistence is plain unix: run tick in a ' +
      'loop or on a cron. Config and state live under ~/.morpho-bots (MORPHO_BOTS_HOME overrides).'
  )
  .exitOverride()

program
  .command('init')
  .description('scaffold the config/state home dir with commented examples (never overwrites)')
  .action(() => {
    process.exitCode = runInit()
  })

for (const bot of ['blue', 'midnight'] as const satisfies readonly BotName[]) {
  program
    .command(bot)
    .description(`${bot} liquidation bot`)
    .command('tick')
    .description('run one full liquidation cycle at the current chain head, then exit')
    .option('--chain <id>', 'chain id (default: CHAIN_ID env, or the sole configured chain)')
    .action(async (opts: { chain?: string }) => {
      process.exitCode = await runTickCommand(bot, opts)
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
