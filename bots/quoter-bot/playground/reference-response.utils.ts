import type { LadderConfig } from '../src/domain/ladder/ladder'
import type { TargetRateConfigured } from '../src/domain/target-rate'

import { generateLadderWithDiagnostics } from '../src/domain/ladder/ladder'

/** Samples rendered in a response strip; enough to show shape without crowding the axis. */
export const RESPONSE_STRIP_POINTS = 61
/** Upper bound on swept references, protecting an extreme configured rate range. */
const MAXIMUM_REFERENCE_SAMPLES = 20_001

/** Inclusive reference range over which a configuration stays free of a described degradation. */
export type ReferenceBand = {
  lowestRateBps: string
  highestRateBps: string
  /** False when the range encloses a degraded reference, so the endpoints alone would mislead. */
  contiguous: boolean
}
/** One swept reference and the rung count that saturates at a hard bound there. */
export type ReferenceResponsePoint = { referenceRateBps: string; pinnedRungs: number }
/** How one ladder entry responds across every reference its configured rate range admits. */
export type LadderReferenceResponse = {
  totalRungs: number
  strip: ReferenceResponsePoint[]
  band?: ReferenceBand
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

const downsample = <T>(items: readonly T[], count: number): T[] => {
  if (items.length <= count) return [...items]
  return Array.from(
    { length: count },
    (_unused, index) => items[Math.round((index * (items.length - 1)) / (count - 1))]!
  )
}

/**
 * Measures how a ladder entry degrades as its reference rate moves across the configured range.
 * @param config - One validated ladder configuration.
 * @returns The rung total, a downsampled response strip, and the widest reference band that pins
 * no rung to a hard bound; `band` is absent only defensively, because the collection parser
 * already rejects a shape that fits at no reference.
 * @remarks Derived entirely from the configuration through the runtime's own
 * `generateLadderWithDiagnostics`, so it assumes no live market data. Answers the question a
 * single deterministic preview cannot: how far the market may move before the shape degrades.
 */
export const ladderReferenceResponse = (
  config: TargetRateConfigured<LadderConfig>
): LadderReferenceResponse => {
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
  // The band is measured past the configured bounds, because the runtime reference is a market rate
  // that may sit anywhere; the strip stays on the plotted axis it is drawn under.
  const margin = absolute(config.quotePremiumBps) + ladderReach(config) + 1n
  const wide = sampleReferences(config.minimumRateBps - margin, config.maximumRateBps + margin)
  const band = bandOf(
    wide,
    wide.map(reference => pinnedRungs(reference) === 0)
  )
  const axis = sampleReferences(config.minimumRateBps, config.maximumRateBps)
  return {
    totalRungs: config.rungCount * 2,
    strip: downsample(
      axis.map(referenceRateBps => ({
        referenceRateBps: String(referenceRateBps),
        pinnedRungs: pinnedRungs(referenceRateBps)
      })),
      RESPONSE_STRIP_POINTS
    ),
    ...(band === undefined ? {} : { band })
  }
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
