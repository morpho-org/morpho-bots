import type { Hash, Hex } from 'viem'

import { isHash, isHex } from 'viem'

const PRIVATE_KEY_LENGTH = 66

export type MakeCommand = {
  command: 'make'
  marketId: Hash
  chainId: number
  target: number
  spread: number
  privateKey: Hex
  rpcUrl: string
  groupId?: string
  dryRun: boolean
}

export type CancelCommand = {
  command: 'cancel'
  groupId: string
  chainId: number
  privateKey: Hex
  rpcUrl: string
  dryRun: boolean
}

export function parseCommand(
  argv: readonly string[],
  env: Record<string, string | undefined> = Bun.env
) {
  const [command, ...rest] = argv
  const { values, positionals } = parseFlags(rest)
  const chainId = integer(values['chain-id'] ?? env.MM_CHAIN_ID, 'chain-id')
  const privateKey = key(values['private-key'] ?? env.MM_PRIVATE_KEY)
  const rpcUrl = required(values['rpc-url'] ?? env.MM_RPC_URL, 'rpc-url')
  const dryRun = values['dry-run'] === 'true'

  if (command === 'make') {
    const marketId = required(values['market-id'], 'market-id')
    if (!isHash(marketId)) throw new Error('--market-id must be a 32-byte hex value')
    const target = integer(values.target, 'target')
    const spread = integer(values.spread, 'spread')
    if (spread < 0 || spread > target * 2)
      throw new Error('--spread must be between 0 and twice --target')
    return {
      command,
      marketId,
      chainId,
      target,
      spread,
      privateKey,
      rpcUrl,
      groupId: values['group-id'],
      dryRun
    } satisfies MakeCommand
  }

  if (command === 'cancel') {
    const groupId = required(positionals[0], 'logical-group-id')
    return { command, groupId, chainId, privateKey, rpcUrl, dryRun } satisfies CancelCommand
  }

  throw new Error('Usage: mm make [options] | mm cancel <logical-group-id> [options]')
}

function parseFlags(argv: readonly string[]) {
  const values: Record<string, string> = {}
  const positionals: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index]!
    if (!item.startsWith('--')) {
      positionals.push(item)
      continue
    }
    const name = item.slice(2)
    if (name === 'dry-run') {
      values[name] = 'true'
      continue
    }
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`)
    values[name] = value
  }
  return { values, positionals }
}

function required(value: string | undefined, name: string) {
  if (!value)
    throw new Error(`Missing --${name} (or MM_${name.replaceAll('-', '_').toUpperCase()})`)
  return value
}

function integer(value: string | undefined, name: string) {
  const parsed = Number(required(value, name))
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`--${name} must be a non-negative integer`)
  return parsed
}

function key(value: string | undefined) {
  const privateKey = required(value, 'private-key')
  if (!isHex(privateKey) || privateKey.length !== PRIVATE_KEY_LENGTH) {
    throw new Error('--private-key must be a 32-byte hex value')
  }
  return privateKey
}
