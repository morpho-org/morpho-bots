#!/usr/bin/env bun
import { Command, CommanderError } from 'commander'

import type { BotName } from './home'

import { runInit } from './commands/init'
import { runQueueCommand } from './commands/queue'
import { runSignerCommand } from './commands/signer'
import { runSourceCommand } from './commands/source'
import { runTransformCommand } from './commands/transform'
import { DOMAINS } from './domains'

const program = new Command('morpho-bots')
  .description(
    'UNIX-pipeable operator CLI for the Morpho curator bots. Each domain exposes a flat set of ' +
      'op commands — a source (emits opportunities) or a transform (ids/records → tx records) — ' +
      'piped into the stateful `queue` sink, e.g. `<domain> unhealthy-positions | <domain> ' +
      'liquidate | <domain> queue`, run in a loop or on a cron. stdout is JSON-Lines data; logs go ' +
      'to stderr. Config and state live under ~/.morpho-bots (MORPHO_BOTS_HOME overrides).'
  )
  .exitOverride()

program
  .command('init')
  .description('scaffold the config/state home dir with commented examples (never overwrites)')
  .action(() => {
    process.exitCode = runInit()
  })

program
  .command('signer')
  .description(
    'run the policy-enforcing signing agent daemon (the sole key holder) on a Unix socket; ' +
      'the queue opts in via SIGNER_SOCKET'
  )
  .option('--socket <path>', 'unix socket path (default: SIGNER_SOCKET env, or <home>/signer.sock)')
  .action(async (opts: { socket?: string }) => {
    process.exitCode = await runSignerCommand(opts)
  })

const CHAIN_OPTION = 'chain id (default: CHAIN_ID env, or the sole configured chain)'

for (const domain of ['blue', 'midnight'] as const satisfies readonly BotName[]) {
  const group = program.command(domain).description(`${domain} liquidation bot`)

  // One command per op in the domain's static manifest — sources take only `--chain`, transforms
  // also take positional ids. The `[source]`/`[transform]` label keeps the flat namespace legible.
  for (const [op, manifest] of Object.entries(DOMAINS[domain].ops)) {
    if (manifest.kind === 'sense') {
      group
        .command(op)
        .description(`[source] emit ${op} as JSON-Lines opportunity records on stdout (read-only)`)
        .option('--chain <id>', CHAIN_OPTION)
        .action(async (opts: { chain?: string }) => {
          process.exitCode = await runSourceCommand(domain, op, opts)
        })
    } else {
      group
        .command(`${op} [ids...]`)
        .description(
          `[transform] map ${manifest.accepts} ids (positional, else stdin) to simulated tx records`
        )
        .option('--chain <id>', CHAIN_OPTION)
        .action(async (ids: string[] | undefined, opts: { chain?: string }) => {
          process.exitCode = await runTransformCommand(domain, op, opts, ids ?? [])
        })
    }
  }

  group
    .command('queue')
    .description('the stateful sink: dedupe, re-simulate, sign, broadcast, and manage replacement')
    .option('--chain <id>', CHAIN_OPTION)
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
