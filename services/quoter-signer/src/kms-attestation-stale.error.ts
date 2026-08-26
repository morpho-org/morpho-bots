/**
 * Signals that a maker signer's custody attestation aged past the freshness window before a
 * signing attempt, so the signer refuses to sign — no KMS call is made. The attestation itself
 * was valid when proven; it has merely expired, so resolving a fresh signer (which re-runs the
 * `GetPublicKey` attestation) can succeed. This keeps the freshness bound enforced by the signing
 * primitive itself, not only by the handler's resolution cache: a held signer object cannot sign
 * against a stale attestation.
 */
export class KmsAttestationStaleError extends Error {
  readonly name = 'KmsAttestationStaleError'

  /** Transient by construction: re-resolving the signer re-attests and may succeed. */
  readonly retryable = true

  /** Creates the fixed stale-attestation refusal; there is no per-intent detail to report. */
  constructor() {
    super(
      'quoter-signer kms maker-key attestation is stale; re-attestation is required before signing'
    )
  }
}
