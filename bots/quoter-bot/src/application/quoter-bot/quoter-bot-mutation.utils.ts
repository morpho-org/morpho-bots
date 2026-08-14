import { createOperationQueue } from '@repo/monitoring'

import type { BootstrapMakeService } from '../bootstrap/position-bootstrap.service'
import type { LadderMakeService } from '../ladder/ladder-quoter.service'

type QuoterBotMakeServices = {
  bootstrap: BootstrapMakeService
  ladder: LadderMakeService
}

/**
 * Wraps both strategy make ports in one failure-tolerant serial mutation queue.
 * @param services - Independently serialized bootstrap and ladder mutation ports.
 * @returns Equivalent ports whose reconcile, preview, hard-halt, and cleanup calls cannot overlap.
 * @remarks Ladder state reads remain concurrent. Serializing bootstrap projections with writes keeps
 * the prepared publication cache stable; serializing writes across strategies prevents separate
 * wallet nonce managers from submitting concurrently and ensures shutdown cleanups drain.
 */
export const serializeQuoterBotWrites = (
  services: QuoterBotMakeServices
): QuoterBotMakeServices => {
  const enqueue = createOperationQueue()

  return {
    bootstrap: {
      ...(services.bootstrap.preview
        ? { preview: parameters => enqueue(() => services.bootstrap.preview!(parameters)) }
        : {}),
      reconcile: parameters => enqueue(() => services.bootstrap.reconcile(parameters)),
      hardHalt: parameters => enqueue(() => services.bootstrap.hardHalt(parameters)),
      cleanup: parameters => enqueue(() => services.bootstrap.cleanup(parameters))
    },
    ladder: {
      readActive: marketId => services.ladder.readActive(marketId),
      reconcile: parameters => enqueue(() => services.ladder.reconcile(parameters)),
      hardHalt: parameters => enqueue(() => services.ladder.hardHalt(parameters)),
      cleanup: parameters => enqueue(() => services.ladder.cleanup(parameters)),
      cleanupRemovedMarkets: services.ladder.cleanupRemovedMarkets
        ? () => enqueue(() => services.ladder.cleanupRemovedMarkets!())
        : undefined
    }
  }
}
