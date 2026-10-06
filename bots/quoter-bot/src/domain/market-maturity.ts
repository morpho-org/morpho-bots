/** One market observation carrying its maturity beside the timestamp it was observed against. */
type MaturityObservation = { maturityTimestamp?: bigint; observedTimestamp?: bigint }

/**
 * Decides whether a freshly read market has already reached maturity.
 * @param observation - Fresh market read carrying maturity and its observation timestamp.
 * @returns Whether the observed timestamp is at or after the market's maturity.
 * @remarks Both values come from one read, so no wall clock is consulted; an observation missing
 * either value is treated as not matured and left to the workflow's normal quoting path, which
 * keeps adapters that cannot report maturity behaving exactly as before.
 */
export const marketObservationMatured = (observation: MaturityObservation) =>
  observation.maturityTimestamp !== undefined &&
  observation.observedTimestamp !== undefined &&
  observation.observedTimestamp >= observation.maturityTimestamp
