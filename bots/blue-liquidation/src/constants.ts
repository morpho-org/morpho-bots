// Morpho Blue protocol constants shared by the sizing, lens, and execution modules. Pinned here at
// scaffold time and verified against their on-chain derivations in test/constants.test.ts. Values
// are cited to the canonical morpho-org/morpho-blue source (confirmed on Base). Operational tuning
// constants (block-poll cadence, stuck-tx thresholds, fee-bump floor) live with the `@repo/bot-kit`
// runner/queue modules that consume them; swap-venue constants live in `@repo/swaps`.

/** 1e18 fixed-point one ("WAD") — the base scalar for Blue's rate and share math (MathLib.sol). */
export const WAD = 10n ** 18n

/**
 * Oracle price scale (1e36): `maxBorrow = collateral.mulDivDown(price, ORACLE_PRICE_SCALE)…`.
 * The oracle bakes both tokens' decimals into `price()`, so the raw price feeds this directly with
 * no decimal normalization (ConstantsLib.sol).
 */
export const ORACLE_PRICE_SCALE = 10n ** 36n

/** Liquidation cursor 0.3e18 — the LLTV-slope term in the LIF formula (ConstantsLib.sol). */
export const LIQUIDATION_CURSOR = 3n * 10n ** 17n

/** Ceiling on the liquidation incentive factor, 1.15e18 (ConstantsLib.sol). */
export const MAX_LIQUIDATION_INCENTIVE_FACTOR = 115n * 10n ** 16n

/** Virtual shares offset, 1e6 — added to the shares total in every share/asset conversion
 * (SharesMathLib.sol). */
export const VIRTUAL_SHARES = 10n ** 6n

/** Virtual assets offset, 1 — added to the assets total in every share/asset conversion
 * (SharesMathLib.sol). */
export const VIRTUAL_ASSETS = 1n
