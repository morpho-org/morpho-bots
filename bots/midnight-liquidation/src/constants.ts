import type { Hex } from 'viem'

// Midnight protocol constants shared by the sizing, lens, and execution modules. They are pinned
// here at scaffold time and verified against their on-chain derivations in test/constants.test.ts.
// Values mirror docs/context/repos/midnight-contracts.txt. Operational tuning whose correct value
// depends on the chain (block-poll cadence, stuck-tx thresholds, settle cooldown, fee floors) lives
// in each chain's `TuningConfig` row in `config.ts`, because its meaning differs per chain; the
// mechanisms it feeds live in `@repo/bot-kit`, and swap-venue constants live in `@repo/swaps`.

/** 1e18 fixed-point one ("WAD") — the base scalar for Midnight's rate and share math. */
export const WAD = 10n ** 18n

/** Oracle price scale (1e36 = WAD²): collateralUsd = amount * price / ORACLE_PRICE_SCALE. */
export const ORACLE_PRICE_SCALE = 10n ** 36n

/** Seconds over which the post-maturity LIF ramps from WAD up to maxLif (60 minutes). */
export const TIME_TO_MAX_LIF = 3600n

/**
 * Magic value an `ILiquidateCallback` must return from `onLiquidate`, or the liquidation
 * reverts (`WrongLiquidateCallbackReturnValue`): `keccak256("morpho.midnight.callbackSuccess")`
 * (ConstantsLib, morpho-org/midnight@main — the version deployed on Base).
 */
export const CALLBACK_SUCCESS: Hex =
  '0x7f87788ea698181ea4d28d1576d0ba4fc92c0dbe5bf75b43692af2ce91dbaea2'

/**
 * Max age of the listed-markets whitelist before it is treated as EMPTY (fail-closed). The
 * whitelist normally refreshes every `markets.refreshMs` (default 60s) with last-known-good
 * surviving transient API failures; this ceiling bounds how long a stale set — e.g. one that has
 * gone unrefreshed through a sustained markets-API outage — may keep a since-delisted market in
 * scope. Sized well above the refresh interval so ordinary API blips never trip it.
 */
export const LISTED_MARKETS_MAX_AGE_MS = 10 * 60_000

/**
 * How often the token USD-price snapshot is refetched. Build-time rather than an env var, like
 * {@link LISTED_MARKETS_MAX_AGE_MS}: the snapshot only orders work, so an operator has no reason to
 * tune it. Matched to the endpoint's own `max-age=30, stale-while-revalidate=60` cache, and refreshed
 * on its own timer so a slow tokens fetch cannot delay the fail-closed whitelist refresh.
 */
export const TOKEN_PRICES_REFRESH_MS = 60_000

/**
 * Firm-quote attempts one position may spend in a single tick before its remaining, lower-ranked
 * alternatives are dropped as `preselectSkipped`.
 *
 * The retry period a maturity is judged on is set by HTTP calls per candidate, not by candidate count,
 * and `MAX_PLAN_CANDIDATES_PER_POSITION` alternatives times a venue fall-through is several seconds of
 * firm quoting for ONE borrower. Two keeps the top-ranked candidate plus one fall-through, which is
 * what net-of-route-cost ordering buys: with the deciding term inside the ranking, a candidate ranked
 * third is one the curve says loses, not one that merely sorted late.
 *
 * Applied ONLY to a position whose route costs are all known, and never to its best swap-free
 * candidate — see the `preselectSkipped` counter for both exemptions.
 */
export const MAX_PRESELECTED_CANDIDATES_PER_POSITION = 2

/**
 * Basis-point denominator (100% = 10_000 bps) for the sizing layer's `seizeCapMarginBps` math.
 * `@repo/swaps` carries its own copy for slippage/route-quality math — kept separate so protocol
 * sizing never depends on the swap-quoting package.
 */
export const BPS = 10_000n
