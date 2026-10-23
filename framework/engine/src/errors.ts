/** A step re-entered operators it had already evaluated more often than the graph allows. */
export class CycleBoundError extends Error {
  constructor(bound: number, operator: string) {
    super(`a step re-entered evaluated operators more than ${bound} times, last ${operator}`)
    this.name = 'CycleBoundError'
  }
}

/** A graph declaration the engine refuses to build or run. */
export class GraphDefinitionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'GraphDefinitionError'
  }
}

/**
 * An operator or effect outside the graph's recovery failed at `origin`. The recovery part ran on
 * until it stopped the runner with `stop`, which is `undefined` when it had nothing to wind down.
 */
export class GraphFailedError extends Error {
  constructor(
    readonly origin: string,
    readonly stop: unknown,
    cause: unknown
  ) {
    super(`the graph failed at ${origin}; its recovery ran until it stopped`, { cause })
    this.name = 'GraphFailedError'
  }
}

/** The journal sink refused an entry; nothing is journaled after it. */
export class JournalFailedError extends Error {
  constructor(cause: unknown) {
    super('the journal sink refused an entry', { cause })
    this.name = 'JournalFailedError'
  }
}

/** A journal I/O operation did not settle before its configured deadline. */
export class JournalIoTimeoutError extends Error {
  constructor(operation: 'append' | 'create' | 'finalize', timeoutMs: number) {
    super(
      operation === 'create'
        ? `the journal file was not created within ${timeoutMs}ms`
        : `the journal sink did not ${operation} within ${timeoutMs}ms`
    )
    this.name = 'JournalIoTimeoutError'
  }
}

/** More encoded journal bytes were queued or in flight than the journal's capacity. */
export class JournalOverflowError extends Error {
  constructor(capacityBytes: number) {
    super(`more than ${capacityBytes} encoded journal bytes were queued or in flight`)
    this.name = 'JournalOverflowError'
  }
}

/** The runner and its journal both failed while stopping; neither failure is discarded. */
export class RunnerFinalizationError extends Error {
  constructor(
    readonly runnerError: unknown,
    readonly journalError: unknown
  ) {
    super('the runner failed and its journal also failed while finalizing', { cause: runnerError })
    this.name = 'RunnerFinalizationError'
  }
}

/** More work waited in a lane than its bound allows; the runner stops rather than skip it. */
export class LaneOverflowError extends Error {
  constructor(lane: string, bound: number) {
    super(`lane ${lane} has more than ${bound} requests waiting`)
    this.name = 'LaneOverflowError'
  }
}

/** Raised when a value the engine must record or compare is not plain data. */
export class NotDataError extends Error {
  constructor(path: string, reason: string) {
    super(`${path === '' ? 'value' : path} ${reason}`)
    this.name = 'NotDataError'
  }
}

/** An operator pushed while its step was propagating; operators emit through the runtime instead. */
export class ReentrantPushError extends Error {
  constructor(node: string) {
    super(`a push to ${node} was made from inside a propagating step`)
    this.name = 'ReentrantPushError'
  }
}

/** A lane policy called the runner or a runner context, which a policy must never do. */
export class PolicyReentryError extends Error {
  constructor(effect: string) {
    super(`a lane policy of ${effect} called the runner`)
    this.name = 'PolicyReentryError'
  }
}

/** A request an effect must not run, such as a redelivery; the runner stops rather than run it twice. */
export class RequestRefusedError extends Error {
  constructor(effect: string, reason: string) {
    super(`${effect} refused a request: ${reason}`)
    this.name = 'RequestRefusedError'
  }
}

/** A push that breaks its source's contract; nothing of it is applied. */
export class WriteRefusedError extends Error {
  constructor(node: string, reason: string) {
    super(`a write to ${node} was refused: ${reason}`)
    this.name = 'WriteRefusedError'
  }
}
