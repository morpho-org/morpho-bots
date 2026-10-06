import { AdaptiveCurveIrmLib } from '@morpho-org/blue-sdk'

/** The pre-accrual inputs a lens must report for {@link advanceRateAtTarget} to finish the job. */
export type StoredRateAtTarget = {
  /** The IRM's stored rate at target, read before any projection. */
  rateAtTargetStored: bigint
  /** Market utilization (WAD) before projection. */
  utilizationBefore: bigint
  /** `block.timestamp - market.lastUpdate`, before projection. */
  elapsed: bigint
}

/**
 * Finishes the accrual a read-only lens cannot do onchain: only Blue calling the IRM's
 * state-changing `borrowRate` advances its stored `rateAtTarget`, so a lens that projects a market
 * read-only reports the stored value and this applies the adaptation Blue would have triggered.
 *
 * Sound for the canonical AdaptiveCurveIRM only — which is the one IRM the field means anything for,
 * and which callers already gate on. Deliberately NOT skipped when the market has no debt: Blue
 * invokes the IRM whenever any time has passed, so the rate at target moves even at zero borrows.
 *
 * A stored zero is returned unchanged rather than seeded with `INITIAL_RATE_AT_TARGET` as the IRM
 * would on a market's first interaction. Every created market is already initialized, so this is the
 * "not an AdaptiveCurve market" case in practice — and callers treat a zero as exactly that, via
 * `isAdaptiveCurveMarket`. Seeding here would manufacture a rate for a market that has none.
 */
export function advanceRateAtTarget(market: StoredRateAtTarget): bigint {
  if (market.rateAtTargetStored === 0n || market.elapsed === 0n) return market.rateAtTargetStored
  return AdaptiveCurveIrmLib.getBorrowRate(
    market.utilizationBefore,
    market.rateAtTargetStored,
    market.elapsed
  ).endRateAtTarget
}
