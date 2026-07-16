import type { Address } from 'viem'

import { getAddress } from 'viem'
import { base } from 'viem/chains'

// Swap-venue constants consumed by the quoting layer and its venue adapters.

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
