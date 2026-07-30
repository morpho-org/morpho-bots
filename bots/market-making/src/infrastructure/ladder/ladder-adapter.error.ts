/** Stable production ladder-adapter failure without provider data or credentials. */
export class LadderAdapterError extends Error {
  readonly code = 'LADDER_ADAPTER_FAILED'
  readonly kind = 'provider-error'

  /** Creates one sanitized adapter failure. @param operation - Stable failed operation code. */
  constructor(readonly operation: string) {
    super('Ladder adapter failed')
    this.name = 'LadderAdapterError'
  }
}
