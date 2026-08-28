/**
 * Allowlisted policy checks whose failure {@link IntentPolicyViolationError} reports — the
 * TIB-2026-08-12 "violated check on denial". Only these identifiers ever reach responses or logs.
 * `internal-fault` is the defensive fail-closed mapping for an unexpected evaluation fault; it
 * never names a caller mistake.
 */
export type IntentPolicyCheck =
  | 'surface-intent-kind'
  | 'chain-id'
  | 'maker'
  | 'fee-ceiling'
  | 'market-allowlist'
  | 'price-bound'
  | 'offer-pin'
  | 'group-coherence'
  | 'reduce-only-pin'
  | 'continuous-fee-cap'
  | 'offer-window'
  | 'offer-expired'
  | 'start-age'
  | 'freshness-ceiling'
  | 'expiry-after-maturity'
  | 'lend-exposure-cap'
  | 'total-lend-exposure-cap'
  | 'ratifier-mode-operation'
  | 'remediation-allowlist'
  | 'internal-fault'

/**
 * Signals that a well-formed intent violates the middleware's deployment policy, so signing is
 * denied — the typed rejection of TIB-2026-08-12's deterministic parameter checks (pins, bounds,
 * ceilings, time windows, and static exposure caps). Distinct from `@repo/bot-kit`'s in-process
 * `PolicyViolationError`: this class crosses the wire in denial envelopes and carries only the
 * middleware-built field path and an allowlisted check identifier, never caller-supplied values.
 */
export class IntentPolicyViolationError extends Error {
  readonly name = 'IntentPolicyViolationError'

  /**
   * Terminal for the payload as sent: deployment policy only changes through a redeploy, and
   * time-window denials call for rebuilding the offer set rather than replaying a stale intent.
   */
  readonly retryable = false

  /**
   * Creates a sanitized policy denial.
   * @param check - Allowlisted policy check that failed.
   * @param field - Middleware-built path of the violating field (for example `offers[3].tick`).
   */
  constructor(
    readonly check: IntentPolicyCheck,
    readonly field: string
  ) {
    super(`quoter-signer policy denied intent: ${field} failed ${check}`)
  }
}
