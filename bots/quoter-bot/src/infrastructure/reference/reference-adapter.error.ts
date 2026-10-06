import type { OperatorAdapterOperation } from '../../application/monitoring/operator-error-name.utils'

/** Stable shared reference-reader failure without provider details. */
export class ReferenceAdapterError extends Error {
  readonly code = 'REFERENCE_ADAPTER_FAILED'
  readonly kind = 'provider-error'

  /** Creates one sanitized reference failure. @param operation - Stable failed operation code. */
  constructor(readonly operation: OperatorAdapterOperation) {
    super('Reference adapter failed')
    this.name = 'ReferenceAdapterError'
  }
}
