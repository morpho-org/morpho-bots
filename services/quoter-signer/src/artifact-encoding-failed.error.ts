/**
 * The post-sign assembly stages {@link ArtifactEncodingFailedError} may name. `publication`
 * covers Mempool payload assembly from the signed Ecrecover tree (ratifier-data construction and
 * payload encoding); `transaction` covers signed-transaction assembly (signature parsing and
 * serialization). Both run strictly after a successful KMS call — pre-sign encoding rejections
 * are policy denials instead.
 */
export type ArtifactEncodingStage = 'publication' | 'transaction'

/**
 * Signals that assembling a response artifact from an already signed intent failed unexpectedly —
 * a middleware fault, not a caller mistake, since every caller-decidable rejection happened in
 * earlier typed stages. The intent still fails closed and nothing partial is returned; the
 * handler has already emitted the per-call `middleware.kms_sign` record for the completed Sign
 * call, so the signature stays reconcilable against CloudTrail even though it is never released.
 * Never advertised as retryable: replaying the identical intent against the same build
 * re-executes the same fault, and a post-sign replay would mint a second signature for one
 * artifact.
 */
export class ArtifactEncodingFailedError extends Error {
  readonly name = 'ArtifactEncodingFailedError'

  /** Terminal for this build: assembly is deterministic, so the identical intent fails again. */
  readonly retryable = false

  /**
   * Creates a sanitized artifact-assembly failure.
   * @param stage - Assembly stage that failed.
   * @param options - Standard error options; the unexpected SDK or serialization fault may ride
   * as `cause` for middleware-side diagnostics. The cause never reaches responses or logs.
   */
  constructor(
    readonly stage: ArtifactEncodingStage,
    options?: { readonly cause?: unknown }
  ) {
    super(`quoter-signer ${stage} artifact assembly failed`, options)
  }
}
