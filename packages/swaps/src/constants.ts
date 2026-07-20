import type { Address } from 'viem';
import { getAddress } from 'viem';
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
} from 'viem/chains';

// Swap-venue constants consumed by the quoting layer and its venue adapters.

/** Basis-point denominator (100% = 10_000 bps) for slippage / route-quality math. */
export const BPS = 10_000n;

/** Default 0x Swap API host (per-collateral `baseUrl` overrides it). */
export const ZEROX_BASE_URL = 'https://api.0x.org';

/** Default 1inch API host (per-collateral `baseUrl` overrides it). */
export const ONEINCH_BASE_URL = 'https://api.1inch.dev';

/** Default LiFi API host (per-collateral `baseUrl` overrides it). */
export const LIFI_BASE_URL = 'https://li.quest/v1';

/** Default LiquidSwap (liqd.ag) API host — the HyperEVM DEX aggregator (per-collateral `baseUrl` overrides it). */
export const LIQUIDSWAP_BASE_URL = 'https://api.liqd.ag/v2';

/**
 * LiFi `integrator` query param — a stable id LiFi uses for analytics and API-key scoping. Not a
 * secret; sent on every LiFi request alongside the `x-lifi-api-key` header.
 */
export const LIFI_INTEGRATOR = 'morpho-curator-bots';

/** Pendle hosted-SDK API host (keyless). A factory `baseUrl` override exists for tests only. */
export const PENDLE_BASE_URL = 'https://api-v2.pendle.finance/core';

/** How long a fetched Pendle markets list stays fresh — matches upstream's 6h refresh interval. */
export const PENDLE_MARKETS_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * Default slippage for the PT → underlying hop, deliberately small: it both floors the hop's
 * on-chain min-out AND haircuts the amount the downstream venue sells, so it effectively tightens
 * the route-quality threshold by this much. Keep it well under `MAX_ROUTE_IMPACT_BPS` (default 500).
 */
export const DEFAULT_PENDLE_SLIPPAGE_BPS = 50;

/**
 * Chains with a live Pendle deployment (their `GET /v1/chains`, checked 2026-07-16). The PT
 * unwrapper is only constructed on these — elsewhere (e.g. Robinhood 4663) it would burn a failing
 * markets fetch per TTL and, with a cold cache, fail plain-collateral quotes too.
 */
export const PENDLE_CHAIN_IDS: ReadonlySet<number> = new Set([
  1, 10, 56, 143, 146, 999, 5000, 8453, 9745, 42161, 80094
]);

/**
 * 0x AllowanceHolder — the canonical plain-ERC20-`approve` spender for the 0x AllowanceHolder flow
 * (same address on every chain). The bot approves THIS, never the Settler. The `/quote` response also
 * returns it as `issues.allowance.spender`; we prefer that when present and fall back to this.
 */
export const ZEROX_ALLOWANCE_HOLDER: Address = getAddress(
  '0x0000000000001fF3684f28c67538d4D072C22734'
);

/**
 * 1inch AggregationRouterV6 per chain — the plain-ERC20-`approve` spender (and the swap `tx.to`;
 * `/approve/spender` returns this same address). Deployed at the canonical CREATE2 address on most
 * chains, but two diverge (both verified on-chain):
 *   - zkSync Era — a different address-derivation scheme; the canonical address has no bytecode.
 *   - Robinhood — the canonical address is a dead 1-tx deployment; the live router (82k+ `swap`
 *     calls) is a separate address. Robinhood is a `@repo/blue-liquidation` chain, so a `1inch`
 *     swap config there must resolve or liquidations would fail every tick.
 * A chain not listed here throws `api_error` in `quoteOneInch` (no behavior change for wired chains).
 */
const ONEINCH_ROUTER_V6 = getAddress('0x111111125421cA6dc452d289314280a0f8842A65');
const ROBINHOOD_CHAIN_ID = 4663; // Arbitrum Orbit L2; not in viem/chains (defined in blue's config).
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
  [zksync.id]: getAddress('0x6fd4383cB451173D5f9304F041C7BCBf27d561fF'),
  [ROBINHOOD_CHAIN_ID]: getAddress('0x5A705DE8982235a7fa45bB83dCaCf03a211389C7')
};
