import { describe, expect, it } from 'bun:test'

import { parseCommand } from '../src/args'

describe('parseCommand', () => {
  it('parses make bps, credentials, logical group, and dry-run', () => {
    expect(
      parseCommand([
        'make',
        '--market-id',
        `0x${'11'.repeat(32)}`,
        '--chain-id',
        '8453',
        '--target',
        '450',
        '--spread',
        '100',
        '--private-key',
        `0x${'22'.repeat(32)}`,
        '--rpc-url',
        'https://rpc.example',
        '--group-id',
        'desk-a',
        '--dry-run'
      ])
    ).toMatchObject({ command: 'make', target: 450, spread: 100, groupId: 'desk-a', dryRun: true })
  })

  it('parses cancel credentials from the environment', () => {
    expect(
      parseCommand(['cancel', 'desk-a'], {
        MM_CHAIN_ID: '8453',
        MM_PRIVATE_KEY: `0x${'22'.repeat(32)}`,
        MM_RPC_URL: 'https://rpc.example'
      })
    ).toMatchObject({ command: 'cancel', groupId: 'desk-a', chainId: 8453 })
  })
})
