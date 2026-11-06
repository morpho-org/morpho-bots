import type { KernelHead } from '@repo/kernel'
import type { Logger } from '@repo/kit'

import { tryCatch } from '@repo/utils'
import { setTimeout as sleep } from 'node:timers/promises'

import { revertReason } from './revert.utils'

/**
 * Readonly mode, which holds no key and sends nothing: scans at the latest block every `everyMs`,
 * start to start, until `signal` aborts, letting a scan in progress finish.
 */
export const runReadonly = async (options: {
  latest: () => Promise<KernelHead>
  scan: (at: KernelHead) => Promise<unknown>
  everyMs: number
  signal: AbortSignal
  logger: Logger
}) => {
  const { signal, logger } = options
  while (!signal.aborted) {
    const startedAt = Date.now()
    const head = await tryCatch(options.latest())
    if (head.error) logger.warn('tick.error', { reason: revertReason(head.error) })
    else await options.scan(head.data)
    const wait = Math.max(0, startedAt + options.everyMs - Date.now())
    await tryCatch(sleep(wait, undefined, { signal }))
  }
}
