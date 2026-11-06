import type { Chain } from 'viem'

import { base, mainnet } from 'viem/chains'

import { MissingBlockTimeError } from './errors'

const ROBINHOOD_CHAIN_ID = 4663

/**
 * Each supported chain's measured block interval. viem's `blockTime` is not trusted: its OP-stack
 * config still says 2s while Base produces a block every 200ms.
 */
export const BLOCK_TIME_MS: ReadonlyMap<number, number> = new Map([
  [mainnet.id, 12_000],
  [base.id, 200],
  [ROBINHOOD_CHAIN_ID, 100]
])

/** `chainId`'s block interval in ms; throws {@link MissingBlockTimeError} for a chain not in the table. */
export const blockTimeMs = (chainId: number): number => {
  const ms = BLOCK_TIME_MS.get(chainId)
  if (ms === undefined) throw new MissingBlockTimeError(chainId)
  return ms
}

/** How many of `chain`'s blocks span `ms`, and at least `atLeast`, so a time bound holds on every chain. */
export const blocksFor = (ms: number, chain: Pick<Chain, 'id'>, atLeast = 1): number =>
  Math.max(atLeast, Math.ceil(ms / blockTimeMs(chain.id)))
