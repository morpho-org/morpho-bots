import type { Address } from 'viem'

import { getAddress } from 'viem'
import {
  arbitrum,
  avalanche,
  base,
  bsc,
  gnosis,
  linea,
  mainnet,
  optimism,
  polygon,
  zksync
} from 'viem/chains'

// Swap-venue constants consumed by the quoting layer and its venue adapters.

/** Basis-point denominator (100% = 10_000 bps) for slippage / route-quality math. */
export const BPS = 10_000n

/** Default 0x Swap API host (per-collateral `baseUrl` overrides it). */
export const ZEROX_BASE_URL = 'https://api.0x.org'

/** Default 1inch API host (per-collateral `baseUrl` overrides it). */
export const ONEINCH_BASE_URL = 'https://api.1inch.dev'

/** Default LiFi API host (per-collateral `baseUrl` overrides it). */
export const LIFI_BASE_URL = 'https://li.quest/v1'

/**
 * LiFi `integrator` query param — a stable id LiFi uses for analytics and API-key scoping. Not a
 * secret; sent on every LiFi request alongside the `x-lifi-api-key` header.
 */
export const LIFI_INTEGRATOR = 'morpho-curator-bots'

/**
 * 0x AllowanceHolder — the canonical plain-ERC20-`approve` spender for the 0x AllowanceHolder flow
 * (same address on every chain). The bot approves THIS, never the Settler. The `/quote` response also
 * returns it as `issues.allowance.spender`; we prefer that when present and fall back to this.
 */
export const ZEROX_ALLOWANCE_HOLDER: Address = getAddress(
  '0x0000000000001fF3684f28c67538d4D072C22734'
)

/**
 * 1inch AggregationRouterV6 per chain — the plain-ERC20-`approve` spender (and the swap `tx.to`;
 * `/approve/spender` returns this same address). Deployed at the canonical CREATE2 address on every
 * chain EXCEPT zkSync Era, whose different address-derivation scheme places it elsewhere. A chain not
 * listed here throws `api_error` in `quoteOneInch` (no behavior change from before this widening).
 */
const ONEINCH_ROUTER_V6 = getAddress('0x111111125421cA6dc452d289314280a0f8842A65')
export const ONEINCH_ROUTER: Record<number, Address> = {
  [mainnet.id]: ONEINCH_ROUTER_V6,
  [optimism.id]: ONEINCH_ROUTER_V6,
  [bsc.id]: ONEINCH_ROUTER_V6,
  [gnosis.id]: ONEINCH_ROUTER_V6,
  [polygon.id]: ONEINCH_ROUTER_V6,
  [base.id]: ONEINCH_ROUTER_V6,
  [arbitrum.id]: ONEINCH_ROUTER_V6,
  [avalanche.id]: ONEINCH_ROUTER_V6,
  [linea.id]: ONEINCH_ROUTER_V6,
  // zkSync Era diverges (verified on-chain): canonical address has no bytecode there.
  [zksync.id]: getAddress('0x6fd4383cB451173D5f9304F041C7BCBf27d561fF')
}
