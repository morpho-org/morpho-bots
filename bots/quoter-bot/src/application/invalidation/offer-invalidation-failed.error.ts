import type { OfferInvalidationFailureReport } from './offer-invalidation.service'

/** Signals that one or more requested offer-group cancellations did not complete safely. */
export class OfferInvalidationFailedError extends Error {
  /**
   * Creates an aggregate failure with sanitized per-group evidence.
   * @param report - Complete failure report containing no provider messages, URLs, or credentials.
   */
  constructor(readonly report: OfferInvalidationFailureReport) {
    super('Offer invalidation failed')
    this.name = 'OfferInvalidationFailedError'
  }
}
