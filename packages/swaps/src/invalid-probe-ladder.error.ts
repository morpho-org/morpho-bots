/**
 * A probe-ladder rung (`PROBE_LADDER`) that is not a positive decimal number. Operator
 * misconfiguration, thrown rather than dropped: a silently-skipped rung would move the bracket the
 * cost curve interpolates between without anyone noticing.
 */
export class InvalidProbeLadderError extends Error {
  readonly size: string

  constructor(size: string) {
    super(`invalid probe ladder size: "${size}"`)
    this.name = 'InvalidProbeLadderError'
    this.size = size
  }
}
