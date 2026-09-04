import type { Address, Hex } from 'viem'

import type { IntentFees } from './intent.utils'

import { QUOTER_SIGNER_CONTRACT_VERSION } from './intent.utils'

/** Operator-facing denial detail carried in every denial envelope. */
export type QuoterSignerDenial = {
  /** Stable error class name callers can branch on. */
  readonly name: string
  /** Sanitized denial message; never contains caller-supplied data. */
  readonly message: string
  /** Whether retrying the identical intent can succeed (transient reads/ledger) or never will. */
  readonly retryable: boolean
}

/**
 * Fail-closed denial envelope: nothing was signed *for delivery* — no signature, payload, or
 * transaction bytes accompany a denial. A denial does not imply zero KMS activity: an intent that
 * passes every deterministic check triggers (or reuses) the read-only `kms:GetPublicKey` custody
 * attestation before it is denied, the container may have warmed that attestation up at cold
 * start, and a post-sign assembly fault (`ArtifactEncodingFailedError`) denies an intent whose
 * `kms:Sign` call already happened — that call is recorded on its own `middleware.kms_sign` log
 * line, so the audit trail keeps artifact-level parity with CloudTrail either way.
 */
export type QuoterSignerDenialResponse = {
  /** Wire-contract version of the envelope. */
  readonly contractVersion: typeof QUOTER_SIGNER_CONTRACT_VERSION
  /** Constant service discriminator so mixed log/response streams stay attributable. */
  readonly service: 'quoter-signer'
  /** Discriminator: this intent was denied. */
  readonly approved: false
  /** Typed reason for the denial. */
  readonly denial: QuoterSignerDenial
}

/**
 * Exact zero-value calldata payload the constrained non-maker publication broadcaster submits to
 * the Midnight Mempool contract. It is encoded by the middleware from the validated offer set —
 * publishable by any funded sender and carrying no authorization of its own.
 */
export type EncodedPublication = {
  /** Midnight Mempool contract address. */
  readonly to: Address
  /** Middleware-encoded publication calldata. */
  readonly data: Hex
  /** Publications are always zero-value. */
  readonly value: '0'
}

/**
 * One maker transaction signed by the middleware, mirroring the ledger-independent
 * transaction-inventory record: everything a caller needs to broadcast, track, and — during
 * break-glass cleanup — replace the transaction at its exact nonce.
 */
export type SignedTransactionArtifact = {
  /** Exact signed, broadcastable transaction bytes; what was validated is what is signed. */
  readonly signedTransaction: Hex
  /** Transaction hash of the signed bytes. */
  readonly hash: Hex
  /** Account nonce the signature commits to; the middleware leases it before signing. */
  readonly nonce: number
  /** Fee fields the middleware actually signed after applying its ceilings. */
  readonly fees: IntentFees
}

/** Approved Ecrecover quote: the maker tree signature plus the exact publication payload. */
export type QuoteApproval = {
  readonly kind: 'quote'
  /** Offer-tree root the middleware re-derived from the validated set. */
  readonly root: Hex
  /** Maker EIP-712 signature over the offer tree. */
  readonly treeSignature: Hex
  /** Exact Mempool publication payload for the non-maker broadcaster. */
  readonly publication: EncodedPublication
}

/** Approved Setter ratification: the signed root approval plus the exact publication payload. */
export type RatifyApproval = {
  readonly kind: 'ratify'
  /** Offer-tree root the middleware re-derived from the validated set. */
  readonly root: Hex
  /** Signed `setIsRootRatified(maker, root, true)` maker transaction. */
  readonly transaction: SignedTransactionArtifact
  /** Exact Mempool publication payload for the non-maker broadcaster. */
  readonly publication: EncodedPublication
}

/** Approved revocation: one signed exposure-reducing maker transaction. */
export type RevokeApproval = {
  readonly kind: 'revoke'
  /** Signed group-consumption, root-cancellation, or self-cancel transaction. */
  readonly transaction: SignedTransactionArtifact
}

/** Approved setup remediation: one signed manifest-pinned maintenance transaction. */
export type SetupRemediationApproval = {
  readonly kind: 'setup-remediation'
  /** Signed manifest-pinned remediation transaction. */
  readonly transaction: SignedTransactionArtifact
}

/** Per-intent-kind approval payload union. */
export type QuoterSignerApprovalResult =
  | QuoteApproval
  | RatifyApproval
  | RevokeApproval
  | SetupRemediationApproval

/**
 * Approval envelope: the intent passed every implemented check and the middleware returns the
 * signatures together with the exact payloads it encoded, so the caller broadcasts exactly what
 * was validated. The TIB-2026-08-12 durable artifact/inventory recording that must precede
 * delivery is a later increment (see the reservation-ledger deferral in Addendum C/D); until it
 * lands, the per-artifact `middleware.kms_sign` log line is the signing record.
 */
export type QuoterSignerApprovalResponse = {
  /** Wire-contract version of the envelope. */
  readonly contractVersion: typeof QUOTER_SIGNER_CONTRACT_VERSION
  /** Constant service discriminator so mixed log/response streams stay attributable. */
  readonly service: 'quoter-signer'
  /** Discriminator: this intent was approved and signed. */
  readonly approved: true
  /** The per-kind signatures and encoded payloads. */
  readonly result: QuoterSignerApprovalResult
}

/**
 * The complete v1 Lambda return contract: an approval carrying signatures and encoded payloads,
 * or a typed fail-closed denial. The handler never throws; every outcome is one of these
 * envelopes.
 */
export type QuoterSignerResponse = QuoterSignerApprovalResponse | QuoterSignerDenialResponse

/**
 * Builds the fail-closed denial envelope for one typed denial cause.
 * @param cause - Error carrying a stable name, sanitized message, and retryability; never built
 * from caller-supplied data.
 * @returns The versioned {@link QuoterSignerDenialResponse} for that cause.
 */
export const buildDenialResponse = (cause: {
  readonly name: string
  readonly message: string
  readonly retryable: boolean
}): QuoterSignerDenialResponse => ({
  contractVersion: QUOTER_SIGNER_CONTRACT_VERSION,
  service: 'quoter-signer',
  approved: false,
  denial: { name: cause.name, message: cause.message, retryable: cause.retryable }
})

/**
 * Builds the versioned approval envelope for one signed per-kind result.
 * @param result - Per-kind signatures and middleware-encoded payloads; every field is
 * middleware-derived (re-derived roots, verified signatures, canonical payload bytes) — nothing
 * from the caller's object graph is echoed.
 * @returns The versioned {@link QuoterSignerApprovalResponse} carrying `result`.
 */
export const buildApprovalResponse = (
  result: QuoterSignerApprovalResult
): QuoterSignerApprovalResponse => ({
  contractVersion: QUOTER_SIGNER_CONTRACT_VERSION,
  service: 'quoter-signer',
  approved: true,
  result
})
