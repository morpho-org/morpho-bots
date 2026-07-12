#!/usr/bin/env bun
import type { BotName } from '@repo/home'

import { Command, CommanderError } from 'commander'

import { runInit } from './commands/init'
import { runOpCommand } from './commands/op'

const program = new Command('morpho-bots')
  .description(
    'UNIX-pipeable operator CLI for the Morpho curator bots. Each domain exposes a flat set of ' +
      'op commands — a source (emits position records) or a transform (positions → transactions) — ' +
      'piped into `morpho-queued submit`. stdout is JSON-Lines data; logs go ' +
      'to stderr. Config and state live under ~/.morpho-bots (MORPHO_BOTS_HOME overrides).'
  )
  .exitOverride()

program
  .command('init')
  .description('scaffold the config/state home dir with commented examples (never overwrites)')
  .action(() => {
    process.exitCode = runInit()
  })

const CHAIN_OPTION = 'chain id (default: CHAIN_ID env, or the sole configured chain)'

for (const domain of ['blue', 'midnight'] as const satisfies readonly BotName[]) {
  program
    .command(`${domain} <op>`)
    .description(`run one ${domain} source or transform op`)
    .option('--chain <id>', CHAIN_OPTION)
    .action(async (op: string, opts: { chain?: string }) => {
      process.exitCode = await runOpCommand(domain, op, opts)
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
