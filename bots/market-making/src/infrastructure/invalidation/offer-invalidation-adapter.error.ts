/** Stable cancellation-adapter failure without provider data, endpoints, or credentials. */
export class OfferInvalidationAdapterError extends Error {
  readonly code = 'OFFER_INVALIDATION_ADAPTER_FAILED'
  readonly kind = 'provider-error'

  /** Creates one sanitized adapter failure. @param operation - Stable failed operation code. */
  constructor(readonly operation: string) {
    super('Offer invalidation adapter failed')
    this.name = 'OfferInvalidationAdapterError'
  }
}
