/** Allowlisted attestation-failure reasons carried by {@link KmsAttestationFailedError}. */
export type KmsAttestationReason =
  | 'missing-public-key'
  | 'key-spec'
  | 'public-key-encoding'
  | 'maker-mismatch'

/**
 * Signals that the configured KMS key failed the maker-key custody attestation: the key exists
 * and answered, but it is not provably the deployment's maker — wrong key spec/usage/algorithm
 * set, a `GetPublicKey` response without key material, an SPKI encoding outside the canonical
 * uncompressed-secp256k1 form, or a derived address that does not equal the policy-pinned maker.
 * TIB-2026-08-12 requires every surface to fail closed on this drift ("a correct setup function
 * cannot mask a stale key or policy on a signing surface"), so intents are denied until the
 * deployment is fixed. The message carries only an allowlisted reason — key material and derived
 * addresses never echo back to callers.
 */
export class KmsAttestationFailedError extends Error {
  readonly name = 'KmsAttestationFailedError'

  /** Terminal until the deployment is fixed: the same key cannot attest differently on retry. */
  readonly retryable = false

  /**
   * Creates a sanitized attestation rejection.
   * @param reason - Allowlisted custody check that failed.
   */
  constructor(readonly reason: KmsAttestationReason) {
    super(`quoter-signer kms maker-key attestation failed: ${reason}`)
  }
}
