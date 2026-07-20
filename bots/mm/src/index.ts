#!/usr/bin/env bun

import { parseCommand } from './args'
import { runCancel, runMake } from './cli'

async function main() {
  const command = parseCommand(Bun.argv.slice(2))
  const result = command.command === 'make' ? await runMake(command) : await runCancel(command)
  console.log(
    JSON.stringify(
      result,
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
      2
    )
  )
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
