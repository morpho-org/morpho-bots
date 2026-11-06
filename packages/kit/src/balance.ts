import type { Address, Chain } from 'viem'

import { ensureError, tryCatch } from '@repo/utils'
import { formatEther } from 'viem'

import type { Logger } from './logger'

import { createBlockSampler } from './block-cadence'
import { blocksFor } from './block-time'

/**
 * Default cadence for the signer-balance metric, converted to each chain's blocks, so operators see
 * EOA gas drain at a steady rate.
 */
export const BALANCE_EVERY_MS = 60_000

/**
 * Emits the signer EOA's native balance as the `signer.balance` metric on a fixed block cadence.
 * `balanceEth` is a plain number (a queryable metric field); `balanceWei` is the lossless decimal
 * string. Thresholding/alerting is BetterStack's job, so this is always `info` — the bot just ships
 * the value. A read failure logs `signer.balance_failed` and never disturbs the tick.
 */
export function createBalanceMonitor(deps: {
  address: Address
  read: () => Promise<bigint>
  logger: Logger
  chain: Pick<Chain, 'id'>
  everyBlocks?: bigint
}): { maybeLog: (blockNumber: bigint) => Promise<void> } {
  const shouldLog = createBlockSampler(
    deps.everyBlocks ?? BigInt(blocksFor(BALANCE_EVERY_MS, deps.chain))
  )
  return {
    async maybeLog(blockNumber) {
      if (!shouldLog(blockNumber)) return
      const balance = await tryCatch(deps.read())
      if (balance.error) {
        deps.logger.warn('signer.balance_failed', {
          address: deps.address,
          detail: ensureError(balance.error).message
        })
        return
      }
      deps.logger.info('signer.balance', {
        address: deps.address,
        balanceWei: balance.data,
        balanceEth: Number(formatEther(balance.data))
      })
    }
  }
}
