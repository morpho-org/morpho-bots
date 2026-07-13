import type { Hex } from 'viem'

import { getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { Policy } from '../src/policy'

import { parsePolicy } from '../src/policy'

// Throwaway well-known test key (anvil account #0) — never used to hold funds.
const KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
export const account = privateKeyToAccount(KEY)
export const EXECUTOR = getAddress(`0x${'22'.repeat(20)}`)

const noop = () => undefined
export const log = { info: noop, warn: noop, error: noop }

type LogLevel = 'info' | 'warn' | 'error'

/** A capturing SignerLog that records every emitted line so tests can assert on events + fields. */
export function captureLog() {
  const events: { level: LogLevel; event: string; fields?: Record<string, unknown> }[] = []
  const make = (level: LogLevel) => (event: string, fields?: Record<string, unknown>) => {
    events.push({ level, event, fields })
  }
  return { events, info: make('info'), warn: make('warn'), error: make('error') }
}

export function testPolicy(): Policy {
  return parsePolicy({
    chainId: 8453,
    executor: EXECUTOR,
    maxFeePerGasWei: '300000000000',
    maxGasLimit: '15000000',
    maxDataBytes: 65536
  })
}
