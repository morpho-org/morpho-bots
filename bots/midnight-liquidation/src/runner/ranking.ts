/**
 * Descending comparator over 1e8-scaled USD scores, with `null` LAST rather than treated as zero: an
 * absent score means "unrankable", not "worthless". Returns `0` on a tie, so `toSorted`'s stability
 * keeps the caller's input order for ties and for the entire unrankable group — a total price outage
 * therefore degrades to exactly discovery order, not to an untested fallback.
 *
 * Compared by bigint predicate, never `Number(b - a)`: these are USD figures over token amounts, and
 * their differences routinely exceed `Number.MAX_SAFE_INTEGER`.
 */
const byDescendingUsd = (a: bigint | null, b: bigint | null): number => {
  if (a === null) return b === null ? 0 : 1
  if (b === null) return -1
  if (a === b) return 0
  return a > b ? -1 : 1
}

/** A sized candidate as scoring sees it: its position, its gross prize, and what the route costs. */
type ScorableCandidate = {
  /** Position label — the fail-open unit, because a position's candidates are ranked against each other. */
  label: string
  /** Oracle-only surplus in USD; `null` when the loan token is unpriced. */
  surplusUsd: bigint | null
  /**
   * Interpolated route cost in the same USD scale, `0n` for a candidate that needs no route, and
   * `null` when the probe curve could not price it (cold, clamped, or an unpriced loan token).
   */
  routeCostUsd: bigint | null
}

/**
 * Scores candidates net of route cost (`surplusUsd - routeCostUsd`) and reports, per position, whether
 * that score can be trusted.
 *
 * Route cost is frequently the DECIDING term rather than a tiebreaker — a measured 17.6 bps median for
 * 0x cbBTC→USDC against a ~20 bps post-maturity incentive, versus zero for a loan-as-collateral slot —
 * which is why it belongs inside the ordering rather than after it.
 *
 * **Fails open per POSITION, not per candidate.** Scoring one candidate net while its sibling stays
 * gross would bias the very comparison that decides which of them is attempted, so when ANY candidate
 * of a position lacks a cost, every candidate of that position keeps its gross score and reports
 * `costed: false`. Callers must honour that flag before applying any new cutoff too: a cutoff over an
 * untrusted ordering can preselect away the only executable liquidation, which is worse than the gross
 * ordering it replaced.
 *
 * Pure — no I/O, and the inputs are copied rather than mutated.
 */
export const scoreNetOfRouteCost = <T extends ScorableCandidate>(
  candidates: readonly T[]
): (T & { netUsd: bigint | null; costed: boolean })[] => {
  const uncosted = new Set(
    candidates.filter(entry => entry.routeCostUsd === null).map(entry => entry.label)
  )
  return candidates.map(candidate => {
    const costed = !uncosted.has(candidate.label)
    const net =
      candidate.surplusUsd === null || candidate.routeCostUsd === null
        ? candidate.surplusUsd
        : candidate.surplusUsd - candidate.routeCostUsd
    return { ...candidate, costed, netUsd: costed ? net : candidate.surplusUsd }
  })
}

/**
 * Orders scored candidates by expected USD profit NET of route cost, descending, with unrankable
 * candidates last — see {@link byDescendingUsd} for the `null` and tie rules, and
 * {@link scoreNetOfRouteCost} for when the score falls back to gross surplus.
 *
 * The tick works candidates serially — one quote plus one simulation each — so in an ascending-price
 * maturity auction, where the first mover takes the whole position, queue order decides which
 * positions get the contested early seconds. Discovery returns candidates in ascending checksummed
 * address order, which is arbitrary.
 *
 * Generic over the score field so it carries no dependency on the lens or sizing types. Non-mutating.
 */
export const rankByNetUsdSurplus = <T extends { netUsd: bigint | null }>(
  candidates: readonly T[]
): T[] => candidates.toSorted((a, b) => byDescendingUsd(a.netUsd, b.netUsd))
