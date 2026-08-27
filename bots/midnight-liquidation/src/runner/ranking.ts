/**
 * Orders sized candidates by expected USD profit, descending, with unpriced candidates last.
 *
 * The tick works candidates serially — one quote plus one simulation each — so in an ascending-price
 * maturity auction, where the first mover takes the whole position, queue order decides which
 * positions get the contested early seconds. Discovery returns candidates in ascending checksummed
 * address order, which is arbitrary.
 *
 * `null` sorts last rather than as zero: an absent price means "unrankable", not "worthless". The sort
 * is stable and non-mutating, so ties and the entire unpriced group keep discovery order — a total
 * price outage therefore degrades to exactly the previous behaviour, not to an untested fallback.
 *
 * Comparison is by bigint predicate, never `Number(b - a)`: these are 1e8-scaled USD figures over
 * token amounts, and their differences routinely exceed `Number.MAX_SAFE_INTEGER`.
 *
 * Generic over the score field so it carries no dependency on the lens or sizing types.
 */
export const rankByUsdSurplus = <T extends { surplusUsd: bigint | null }>(
  candidates: readonly T[]
): T[] =>
  candidates.toSorted((a, b) => {
    if (a.surplusUsd === null) return b.surplusUsd === null ? 0 : 1
    if (b.surplusUsd === null) return -1
    if (a.surplusUsd === b.surplusUsd) return 0
    return a.surplusUsd > b.surplusUsd ? -1 : 1
  })
