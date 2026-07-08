import type { Address } from 'viem'

import { getAddress } from 'viem'
import { base } from 'viem/chains'

// Morpho Blue protocol constants shared by the sizing, lens, and execution modules. Pinned here at
// scaffold time and verified against their on-chain derivations in test/constants.test.ts. Values
// are cited to the canonical morpho-org/morpho-blue source (confirmed on Base). Operational tuning
// constants (block-poll cadence, stuck-tx thresholds, fee-bump floor) live with the runner/queue
// modules that consume them, plus the tx-queue block below.

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
