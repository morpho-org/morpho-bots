import type { Backoff, KernelView } from '@repo/controller'
import type { Keyed } from '@repo/engine'
import type { Logger } from '@repo/kit'

import { isBackedOff, isBusy, pendingFields } from '@repo/controller'
import { createTxReporter } from '@repo/kit'

/** What one scan left the graph holding, read once the scan has propagated. */
type ScanState = Readonly<{
  markets?: Keyed<unknown>
  view?: KernelView
  backoff?: Backoff
  /** Whether the scan vouched for every listed market. */
  complete: boolean
}>

/**
 * The bot's operator log beside the scan's own: per scan, `tick.end`; per kernel transaction, the
 * {@link createTxReporter} events and `resolution.not_sent`.
 */
export const createReporter = (logger: Logger) => {
  const reportScan = ({ markets, view, backoff, complete }: ScanState) => {
    const crossed = Object.entries(markets?.keys ?? {})
      .filter(([, record]) => record.status === 'present')
      .map(([key]) => key)
    logger.info('tick.end', {
      crossed: crossed.length,
      inflight: crossed.filter(key => isBusy(view, key)).length,
      backedOff: crossed.filter(key => isBackedOff(backoff, key)).length,
      complete,
      ...pendingFields(view)
    })
  }

  const reportActivity = createTxReporter({
    logger,
    reportNotSent: fields => logger.warn('resolution.not_sent', fields)
  })

  return { reportScan, reportActivity }
}
