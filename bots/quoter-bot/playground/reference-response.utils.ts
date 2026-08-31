import type { LadderConfig } from '../src/domain/ladder/ladder'
import type { TargetRateConfigured } from '../src/domain/target-rate'

import { generateLadderWithDiagnostics } from '../src/domain/ladder/ladder'

/** Upper bound on swept references, protecting an extreme configured rate range. */
const MAXIMUM_REFERENCE_SAMPLES = 20_001

/** Inclusive reference range over which a configuration stays free of a described degradation. */
export type ReferenceBand = {
  lowestRateBps: string
  highestRateBps: string
  /** False when the range encloses a degraded reference, so the endpoints alone would mislead. */
  contiguous: boolean
}
/**
 * Enumerates candidate references at one-BPS resolution.
 * @remarks The lowest reference is 1 BPS because the runtime requires a positive reference; the
 * caller widens the range past the configured bounds, since a live reference has no reason to stay
 * inside them.
 */
const sampleReferences = (lowest: bigint, highest: bigint) => {
  const first = lowest > 1n ? lowest : 1n
  const stride = (highest - first) / BigInt(MAXIMUM_REFERENCE_SAMPLES - 1) + 1n
  const references: bigint[] = []
  for (let value = first; value <= highest; value += stride) references.push(value)
  if (references.at(-1) !== highest) references.push(highest)
  return references
}

/** Distance from a ladder center to its outermost rung on either side. */
const ladderReach = (config: TargetRateConfigured<LadderConfig>) =>
  config.spreadBps / 2n + (BigInt(config.rungCount) - 1n) * config.stepBps

const absolute = (value: bigint) => (value < 0n ? -value : value)

const bandOf = (
  references: readonly bigint[],
  clean: readonly boolean[]
): ReferenceBand | undefined => {
  const first = clean.indexOf(true)
  if (first === -1) return undefined
  const last = clean.lastIndexOf(true)
  return {
    lowestRateBps: String(references[first]),
    highestRateBps: String(references[last]),
    contiguous: clean.slice(first, last + 1).every(Boolean)
  }
}

/**
 * Measures the reference range over which a ladder keeps every rung off a hard rate bound.
 * @param config - One validated ladder configuration.
 * @returns The widest reference band pinning no rung; absent only defensively, because the
 * collection parser already rejects a shape that fits at no reference.
 * @remarks Derived entirely from the configuration through the runtime's own
 * `generateLadderWithDiagnostics`, so it assumes no live market data. Answers the question a
 * single deterministic preview cannot: how far the market may move before the shape degrades.
 * The sweep runs past the configured bounds, since a live reference has no reason to stay inside
 * them.
 */
export const ladderReferenceBand = (
  config: TargetRateConfigured<LadderConfig>
): ReferenceBand | undefined => {
  const pinnedRungs = (referenceRateBps: bigint) => {
    const { diagnostics } = generateLadderWithDiagnostics({
      config,
      referenceRateBps,
      ...(config.maturityPremium === undefined ? {} : { secondsToMaturity: 0n })
    })
    return (
      diagnostics.lower.clampedToMinimumRungs +
      diagnostics.lower.clampedToMaximumRungs +
      diagnostics.higher.clampedToMinimumRungs +
      diagnostics.higher.clampedToMaximumRungs
    )
  }
  const margin = absolute(config.quotePremiumBps) + ladderReach(config) + 1n
  const references = sampleReferences(
    config.minimumRateBps - margin,
    config.maximumRateBps + margin
  )
  return bandOf(
    references,
    references.map(reference => pinnedRungs(reference) === 0)
  )
}

/**
 * Measures the reference range over which a bootstrap quote tracks the reference instead of
 * saturating at a hard bound.
 * @param premiumBps - The entry's signed quote premium.
 * @param minimum - Inclusive configured rate floor.
 * @param maximum - Inclusive configured rate ceiling.
 * @returns The widest unsaturated reference band, or `undefined` when every swept reference
 * saturates.
 * @remarks Uses the premium-free base quote, matching the anchor the deterministic preview draws.
 */
export const bootstrapReferenceBand = (
  premiumBps: bigint,
  minimum: bigint,
  maximum: bigint
): ReferenceBand | undefined => {
  const margin = absolute(premiumBps) + 1n
  const references = sampleReferences(minimum - margin, maximum + margin)
  return bandOf(
    references,
    references.map(reference => {
      const quote = reference + premiumBps
      return quote >= minimum && quote <= maximum
    })
  )
}
