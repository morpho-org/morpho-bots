import { createOperationQueue } from '@repo/monitoring'

import type { BootstrapMakeService } from '../bootstrap/position-bootstrap.service'
import type { LadderMakeService } from '../ladder/ladder-market-maker.service'

type MarketMakingMakeServices = {
  bootstrap: BootstrapMakeService
  ladder: LadderMakeService
}

/**
 * Wraps both strategy make ports in one failure-tolerant serial mutation queue.
 * @param services - Independently serialized bootstrap and ladder mutation ports.
 * @returns Equivalent ports whose reconcile, hard-halt, and cleanup calls cannot overlap.
 * @remarks Ladder state reads remain concurrent. Serializing writes across strategies prevents
 * separate wallet nonce managers from submitting concurrently and ensures shutdown cleanups drain.
 */
export const serializeMarketMakingWrites = (
  services: MarketMakingMakeServices
): MarketMakingMakeServices => {
  const enqueue = createOperationQueue()

  return {
    bootstrap: {
      reconcile: parameters => enqueue(() => services.bootstrap.reconcile(parameters)),
      hardHalt: parameters => enqueue(() => services.bootstrap.hardHalt(parameters)),
      cleanup: parameters => enqueue(() => services.bootstrap.cleanup(parameters))
    },
    ladder: {
      readActive: marketId => services.ladder.readActive(marketId),
      reconcile: parameters => enqueue(() => services.ladder.reconcile(parameters)),
      hardHalt: parameters => enqueue(() => services.ladder.hardHalt(parameters)),
      cleanup: parameters => enqueue(() => services.ladder.cleanup(parameters))
    }
  }
}
