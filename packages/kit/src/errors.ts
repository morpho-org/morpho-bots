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

/** A chain declares no block time, so a time bound cannot be converted to its blocks. */
export class MissingBlockTimeError extends Error {
  constructor(readonly chainId: number) {
    super(`chain ${chainId} declares no block time`)
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
