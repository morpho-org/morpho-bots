import type { PolicyCheck } from './policy'

/** A transaction kernel was asked about a commitment, which nothing it signs can create. */
export class NoCommitmentsError extends Error {
  constructor(ids: readonly string[]) {
    super(`this account holds no commitments, yet was asked about ${ids.length} of them`)
    this.name = 'NoCommitmentsError'
  }
}

/** Raised when a prepared transaction fails the default-deny policy — an upstream bug, never sent. */
export class PolicyViolationError extends Error {
  readonly code = 'policy_violation'

  constructor(
    message: string,
    readonly check: PolicyCheck
  ) {
    super(message)
    this.name = 'PolicyViolationError'
  }
}

/** Kit has no block time for a chain, so a time bound cannot be converted to its blocks. */
export class MissingBlockTimeError extends Error {
  constructor(readonly chainId: number) {
    super(`no block time is known for chain ${chainId}`)
    this.name = 'MissingBlockTimeError'
  }
}

/** A finality depth the kernel's reorg window cannot reach, so finality would never advance. */
export class FinalityBeyondWindowError extends Error {
  constructor(
    readonly chainId: number,
    readonly depth: number,
    readonly window: number
  ) {
    super(
      `chain ${chainId}: a finality depth of ${depth} blocks reaches past the ${window}-block reorg window; choose a depth below ${window}`
    )
    this.name = 'FinalityBeyondWindowError'
  }
}

/** The kernel's signing guard refused: what the signature would authorize no longer holds. */
export class SignWithdrawnError extends Error {
  constructor() {
    super('the signature was withdrawn before signing')
    this.name = 'SignWithdrawnError'
  }
}

/** The candidate's fee ceiling cannot fund a valid transaction or replacement. */
export class FeeLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FeeLimitError'
  }
}

/** The node prepared transaction fields other than those the caller authorized. */
export class PreparedTransactionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PreparedTransactionError'
  }
}

/** A journal file could not be created, written, synchronized, or closed. */
export class JournalFileError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`the journal file could not ${operation}`, { cause })
    this.name = 'JournalFileError'
  }
}

/** The image does not say which build it is, so its journal could not name the source it ran. */
export class MissingBuildIdentityError extends Error {
  constructor() {
    super(
      'BUILD_REVISION (the git commit) and BUILD_IMAGE_TAG must be set when the image is built so the journal names its build'
    )
    this.name = 'MissingBuildIdentityError'
  }
}

/** `JOURNAL_RUN_CAP_BYTES` is missing or not a byte count the journal can be capped at. */
export class InvalidJournalRunCapError extends Error {
  constructor(minimum: number) {
    super(`JOURNAL_RUN_CAP_BYTES must be set to a whole number of bytes, at least ${minimum}`)
    this.name = 'InvalidJournalRunCapError'
  }
}

/** Sanitized signer-construction or remote-signing failure. */
export class SignerAccountError extends Error {
  readonly name = 'SignerAccountError'

  /**
   * Creates a sanitized account failure from an allowlisted operation only.
   * @param operation - Stable signer operation that failed without retaining secret material.
   */
  constructor(
    readonly operation:
      | 'signer-address'
      | 'keystore-read'
      | 'keystore-decrypt'
      | 'kms-public-key'
      | 'kms-sign'
  ) {
    super(`Signer account ${operation} failed`)
  }
}
