/**
 * Signals that a KMS `Sign` call failed with an unknown outcome: the request was dispatched, the
 * response never verified, and a signature may or may not have been produced server-side
 * (TIB-2026-08-12 failure posture: "KMS error → typed failure; never assume a signature was
 * produced"). Deliberately not retryable, unlike the read-only attestation's
 * `KmsUnavailableError`: blindly re-signing the identical intent could mint a second signature
 * and a second CloudTrail `Sign` event for one artifact, breaking the one-event-per-signing-
 * record reconciliation — and `maxAttempts: 1` on the client only prevents SDK-internal retries,
 * not invocation-level ones. Re-admission after an ambiguous outcome belongs to the reservation
 * ledger's idempotent compensation and CloudTrail reconciliation (later TIB increments), never to
 * an automatic caller retry.
 */
export class KmsSignOutcomeUnknownError extends Error {
  readonly name = 'KmsSignOutcomeUnknownError'

  /**
   * Not because a later attempt cannot succeed, but because an unreconciled retry is unsafe:
   * callers must halt and let the reservation/reconciliation layer decide re-admission.
   */
  readonly retryable = false

  /**
   * Creates the sanitized ambiguous-outcome failure.
   * @param options - Standard error options; the unexpected AWS SDK fault may ride as `cause` for
   * middleware-side diagnostics. The cause never reaches responses or logs — denial envelopes and
   * log lines carry only `name`, sanitized `message`, and `retryable`.
   */
  constructor(options?: { readonly cause?: unknown }) {
    super(
      'quoter-signer kms sign call failed with unknown outcome; a signature may exist and blind retry is unsafe',
      options
    )
  }
}
