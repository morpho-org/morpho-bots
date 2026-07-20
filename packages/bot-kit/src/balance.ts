import { ensureError, tryCatch } from '@repo/utils';

import type { Address } from 'viem';
import { formatEther } from 'viem';

import type { Logger } from './logger';

/**
 * Default block cadence for the signer-balance metric. On ~2s Base blocks this ships roughly every
 * 60s — matching the daemon-era wall-clock cadence — so operators see EOA gas drain at a steady rate.
 */
export const BALANCE_EVERY_BLOCKS = 30n;

/**
 * Emits the signer EOA's native balance as the `signer.balance` metric on a fixed block cadence.
 * `balanceEth` is a plain number (a queryable metric field); `balanceWei` is the lossless decimal
 * string. Thresholding/alerting is BetterStack's job, so this is always `info` — the bot just ships
 * the value. A read failure logs `signer.balance_failed` and never disturbs the tick.
 */
export function createBalanceMonitor(deps: {
  address: Address;
  read: () => Promise<bigint>;
  logger: Logger;
  everyBlocks?: bigint;
}): { maybeLog: (blockNumber: bigint) => Promise<void> } {
  const everyBlocks = deps.everyBlocks ?? BALANCE_EVERY_BLOCKS;
  let lastAt: bigint | null = null;
  return {
    async maybeLog(blockNumber) {
      if (lastAt !== null && blockNumber - lastAt < everyBlocks) {
        return;
      }
      lastAt = blockNumber;
      const balance = await tryCatch(deps.read());
      if (balance.error) {
        deps.logger.warn('signer.balance_failed', {
          address: deps.address,
          detail: ensureError(balance.error).message
        });
        return;
      }
      deps.logger.info('signer.balance', {
        address: deps.address,
        balanceWei: balance.data,
        balanceEth: Number(formatEther(balance.data))
      });
    }
  };
}
