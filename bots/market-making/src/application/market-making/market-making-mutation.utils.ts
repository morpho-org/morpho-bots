import type { BootstrapMakeService } from '../bootstrap/position-bootstrap.service'
import type { LadderMakeService } from '../ladder/ladder-market-maker.service'
import type { MonitorOperationQueue } from '../monitor.utils'

type MarketMakingMakeServices = {
  bootstrap: BootstrapMakeService
  ladder: LadderMakeService
}

/**
 * Creates one failure-tolerant queue for complete market-making operations.
 * @returns A boundary that runs each submitted operation after every preceding operation settles.
 * @remarks Combined monitoring uses this around full read, decision, output, and cleanup phases so
 * one strategy cannot decide against capacity that excludes a concurrent strategy mutation.
 */
export const createMarketMakingOperationQueue = (): MonitorOperationQueue => {
  let queue = Promise.resolve()
  return <Result>(operation: () => Promise<Result>) => {
    const result = queue.then(operation, operation)
    queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
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
  const enqueue = createMarketMakingOperationQueue()

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
