import type { LadderDebtConfig } from './debt-ceiling'

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

/**
 * The last block timestamp at which a borrowing sell may be taken.
 * @param config - The market's debt config.
 * @param maturity - The market's onchain maturity.
 * @returns `maturity − stopBorrowingBeforeMaturitySeconds`, every borrowing sell's `expiry`.
 */
export const borrowingCutoff = (config: LadderDebtConfig, maturity: bigint) =>
  maturity - BigInt(config.stopBorrowingBeforeMaturitySeconds)

/**
 * Whether a ladder's sells may borrow at one market reading.
 * @param config - The market's debt config; absent means sells never borrow.
 * @param observation - Maturity and the block timestamp it was read at, from one reading.
 * @returns `true` only while the timestamp is strictly before {@link borrowingCutoff}; a reading
 * missing either value is closed.
 */
export const borrowingOpen = (
  config: LadderDebtConfig | undefined,
  observation: MaturityObservation
) =>
  config !== undefined &&
  observation.maturityTimestamp !== undefined &&
  observation.observedTimestamp !== undefined &&
  observation.observedTimestamp < borrowingCutoff(config, observation.maturityTimestamp)
