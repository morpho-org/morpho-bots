import type { Hex } from 'viem'

// Midnight protocol constants shared by the sizing, lens, and execution modules landing in
// later phases. They are pinned here at scaffold time and verified against their on-chain
// derivations in test/constants.test.ts. Values mirror docs/context/repos/midnight-contracts.txt.
// Operational tuning constants (block-poll cadence, stuck-tx thresholds, fee-bump floor) live
// with the daemon/queue modules that consume them (Phase 3) rather than here.

/** 1e18 fixed-point one ("WAD") — the base scalar for Midnight's rate and share math. */
export const WAD = 10n ** 18n

/** Oracle price scale (1e36 = WAD²): collateralUsd = amount * price / ORACLE_PRICE_SCALE. */
export const ORACLE_PRICE_SCALE = 10n ** 36n

/** Seconds over which the post-maturity LIF ramps from WAD up to maxLif (15 minutes). */
export const TIME_TO_MAX_LIF = 900n

/** Maximum collateral slots a single borrower can activate at once (Midnight ConstantsLib). */
export const MAX_COLLATERALS_PER_BORROWER = 16

/**
 * Magic value an `ILiquidateCallback` must return from `onLiquidate`, or the liquidation
 * reverts: `keccak256("MIDNIGHT CALLBACK SUCCESS")` (ConstantsLib.sol:216).
 */
export const CALLBACK_SUCCESS: Hex =
  '0xee60b2e8d46b15beabf6792dae952096e6cb7b86b90ca90f7c00aa15c812ff1a'
