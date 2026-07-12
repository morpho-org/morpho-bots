#!/usr/bin/env bun
import { parseArgs } from 'node:util'

import { runSigner } from './command'

const help = `Usage: morpho-signer [--socket <path>]

Offline, default-deny transaction signer for morpho-queued.

Options:
  --socket <path>  Unix socket (SIGNER_SOCKET or <home>/signer.sock)
  -h, --help       Show this help
`

try {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      socket: { type: 'string' },
      help: { type: 'boolean', short: 'h' }
    },
    strict: true
  })
  if (values.help) {
    console.log(help)
  } else {
    process.exitCode = await runSigner({ socket: values.socket })
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
}
