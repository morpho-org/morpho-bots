import type { Hex } from 'viem'

/** Allowlisted signature-rejection reasons carried by {@link KmsSigningFailedError}. */
export type KmsSigningFailureReason =
  | 'digest-width'
  | 'missing-signature'
  | 'missing-request-id'
  | 'der-encoding'
  | 'recovery'

/**
 * Signals that a KMS `Sign` response could not be turned into an attested maker signature: the
 * middleware asked for a signature over a digest it derived, but the digest was not 32 bytes (a
 * middleware bug caught before any KMS call), the response carried no signature, the response
 * carried no KMS request id (the mandatory CloudTrail reconciliation join key of TIB-2026-08-12
 * Observability — a signature without it would be an unreconcilable record), the DER encoding
 * failed the strict canonical parse, or the low-s-normalized signature recovers to an address
 * other than the attested maker. Every case is an anomaly on the custody boundary rather than a
 * caller mistake, so it is terminal and alert-worthy — never silently retried into an unverified
 * signature. Nothing returned by KMS is echoed back to callers.
 */
export class KmsSigningFailedError extends Error {
  readonly name = 'KmsSigningFailedError'

  /** Terminal by classification: an unverifiable signature must halt signing, not loop. */
  readonly retryable = false

  /**
   * Middleware-derived digest of the `Sign` call that produced the rejected response, when the
   * call reached KMS. Present exactly when a CloudTrail `Sign` event exists for the failure, so
   * the handler can still emit the per-artifact `middleware.kms_sign` reconciliation record
   * (TIB-2026-08-12 Observability) even though the signature is never released.
   */
  readonly digest?: Hex

  /** KMS request id of that call, when the response carried a usable one. */
  readonly kmsRequestId?: string

  /**
   * Creates a sanitized signature rejection.
   * @param reason - Allowlisted verification step that failed.
   * @param call - The completed KMS call's middleware-owned identifiers, when the failure
   * happened after the `Sign` call succeeded; omitted for pre-call failures (`digest-width`).
   */
  constructor(
    readonly reason: KmsSigningFailureReason,
    call?: { readonly digest?: Hex; readonly kmsRequestId?: string }
  ) {
    super(`quoter-signer kms signature rejected: ${reason}`)
    this.digest = call?.digest
    this.kmsRequestId = call?.kmsRequestId
  }
}
