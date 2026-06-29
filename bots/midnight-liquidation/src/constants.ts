import type { Address, Hex } from 'viem'

import { getAddress } from 'viem'
import { base } from 'viem/chains'

// Midnight protocol constants shared by the sizing, lens, and execution modules landing in
// later phases. They are pinned here at scaffold time and verified against their on-chain
// derivations in test/constants.test.ts. Values mirror docs/context/repos/midnight-contracts.txt.
// Operational tuning constants (block-poll cadence, stuck-tx thresholds, fee-bump floor) live
// with the runner/queue modules that consume them (Phase 3) rather than here.

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
 * reverts (`WrongLiquidateCallbackReturnValue`): `keccak256("morpho.midnight.callbackSuccess")`
 * (ConstantsLib, morpho-org/midnight@main — the version deployed on Base).
 */
export const CALLBACK_SUCCESS: Hex =
  '0x7f87788ea698181ea4d28d1576d0ba4fc92c0dbe5bf75b43692af2ce91dbaea2'

// --- Tx-queue operational tuning (consumed by the nonce queue / runner) ---

/** Blocks a pending tx may sit unconfirmed before the queue bumps its fee and replaces it. */
export const STUCK_BLOCKS = 4n

/** Fee-bump attempts the queue makes on a stuck tx before dropping it. */
export const MAX_BUMP_ATTEMPTS = 3

// --- Swap-venue constants (consumed by the quoting layer) ---

/** Basis-point denominator (100% = 10_000 bps) for slippage / route-quality math. */
export const BPS = 10_000n

/** Default 0x Swap API host (per-collateral `baseUrl` overrides it). */
export const ZEROX_BASE_URL = 'https://api.0x.org'

/** Default 1inch API host (per-collateral `baseUrl` overrides it). */
export const ONEINCH_BASE_URL = 'https://api.1inch.dev'

/**
 * 0x AllowanceHolder — the canonical plain-ERC20-`approve` spender for the 0x AllowanceHolder flow
 * (same address on every chain). The bot approves THIS, never the Settler. The `/quote` response also
 * returns it as `issues.allowance.spender`; we prefer that when present and fall back to this.
 */
export const ZEROX_ALLOWANCE_HOLDER: Address = getAddress(
  '0x0000000000001fF3684f28c67538d4D072C22734'
)

/** 1inch AggregationRouterV6 per chain — the plain-ERC20-`approve` spender (and the swap `tx.to`). */
export const ONEINCH_ROUTER: Record<number, Address> = {
  [base.id]: getAddress('0x111111125421cA6dc452d289314280a0f8842A65')
}
