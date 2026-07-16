import type { Hex } from 'viem'

// Midnight protocol constants shared by the sizing, lens, and execution modules. They are pinned
// here at scaffold time and verified against their on-chain derivations in test/constants.test.ts.
// Values mirror docs/context/repos/midnight-contracts.txt. Operational tuning constants
// (block-poll cadence, stuck-tx thresholds, fee-bump floor) live with the `@repo/bot-kit`
// runner/queue modules that consume them; swap-venue constants live in `@repo/swaps`.

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

// --- Tx-queue operational tuning (consumed by the nonce queue / runner) ---

/**
 * Blocks a position stays in the queue's backpressure set AFTER its tx settles (confirm/revert/drop),
 * suppressing re-submission. A liquidation confirms on the send RPC before the (possibly lagging)
 * read RPC reflects the cleared position, so without this cooldown the tick re-plans an
 * already-liquidated borrower and broadcasts a doomed `NotBorrower` re-send. Sized well above the
 * observed read/confirm head skew; the bot's liquidations are terminal, so a brief suppression of an
 * already-acted position is harmless.
 */
export const SETTLED_COOLDOWN_BLOCKS = 20n

/**
 * Max age of the listed-markets whitelist before it is treated as EMPTY (fail-closed). The
 * whitelist normally refreshes every `markets.refreshMs` (default 60s) with last-known-good
 * surviving transient API failures; this ceiling bounds how long a stale set — e.g. one that has
 * gone unrefreshed through a sustained markets-API outage — may keep a since-delisted market in
 * scope. Sized well above the refresh interval so ordinary API blips never trip it.
 */
export const LISTED_MARKETS_MAX_AGE_MS = 10 * 60_000

/**
 * Basis-point denominator (100% = 10_000 bps) for the sizing layer's `seizeCapMarginBps` math.
 * `@repo/swaps` carries its own copy for slippage/route-quality math — kept separate so protocol
 * sizing never depends on the swap-quoting package.
 */
export const BPS = 10_000n
