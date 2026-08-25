import { SigningNotImplementedError } from './signing-not-implemented.error'

/** Structured intent kinds defined by TIB-2026-08-12. The wire contract is not final. */
export const INTENT_KINDS = ['quote', 'ratify', 'revoke', 'setup-remediation'] as const

/** One of the TIB-defined structured intent kinds. */
type IntentKind = (typeof INTENT_KINDS)[number]

/** A recognized intent kind, or `unknown` for anything else — the only value ever logged. */
type ClassifiedIntentKind = IntentKind | 'unknown'

/** Operator-facing denial detail carried in every skeleton response. */
export type QuoterSignerDenial = {
  /** Stable error class name callers can branch on. */
  readonly name: string
  /** Sanitized denial message; never contains caller-supplied data. */
  readonly message: string
}

/** Versioned fail-closed response envelope returned for every invocation of the skeleton. */
export type QuoterSignerResponse = {
  /** Wire-contract version; bumps on any envelope change. */
  readonly contractVersion: 1
  /** Constant service discriminator so mixed log/response streams stay attributable. */
  readonly service: 'quoter-signer'
  /** Always `false` in the skeleton: no signing surface exists, nothing is ever approved. */
  readonly approved: false
  /** Typed reason for the denial. */
  readonly denial: QuoterSignerDenial
}

/**
 * Classifies an untrusted invocation payload into a loggable intent kind.
 *
 * Only allowlisted kinds are ever returned, so log records never carry caller-controlled strings;
 * every other shape — including non-object events — collapses to `unknown`.
 * @param event - Raw, untrusted Lambda invocation payload.
 * @returns The matched {@link IntentKind}, or `unknown` when the payload declares none.
 */
export const classifyIntentKind = (event: unknown): ClassifiedIntentKind => {
  if (typeof event !== 'object' || event === null) return 'unknown'
  const kind = (event as { readonly kind?: unknown }).kind
  return typeof kind === 'string' && (INTENT_KINDS as readonly string[]).includes(kind)
    ? (kind as IntentKind)
    : 'unknown'
}

/**
 * Builds the fail-closed denial envelope the skeleton returns for every intent.
 * @returns A {@link QuoterSignerResponse} carrying the {@link SigningNotImplementedError} identity.
 */
export const buildNotImplementedDenial = (): QuoterSignerResponse => {
  const error = new SigningNotImplementedError()
  return {
    contractVersion: 1,
    service: 'quoter-signer',
    approved: false,
    denial: { name: error.name, message: error.message }
  }
}
