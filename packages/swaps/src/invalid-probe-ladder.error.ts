/**
 * A configured probe-ladder rung (`PROBE_LADDER`) that is not a positive decimal number.
 *
 * Operator misconfiguration, judged against the string alone so the verdict cannot depend on which
 * collateral the rung is being converted for — a rung that merely converts to less than one base unit
 * is DROPPED instead, which is a property of the collateral. Both liquidators' `PROBE_LADDER` parsers
 * reject the same shape at startup, so reaching this means a programmatic caller.
 *
 * It is raised from the per-pair ladder conversion, deep inside `VenueSelector.refresh`, so it surfaces
 * as a refresh rejection that every call site logs and continues past (`probe.error` /
 * `probe.warm_failed`). The pair is then left permanently unranked and on the default venue order — a
 * coverage degradation with a log line, not a crash.
 */
export class InvalidProbeLadderError extends Error {
  readonly size: string

  constructor(size: string) {
    super(`invalid probe ladder size: "${size}"`)
    this.name = 'InvalidProbeLadderError'
    this.size = size
  }
}
