import { getAddress, isHex } from 'viem';

import { BPS, LIFI_BASE_URL, LIFI_INTEGRATOR } from '../constants';
import type { RateLimitedClient } from '../http-client';
import type { PriceParameters, PriceQuote, QuoteParameters, Swap } from '../types';
import { QuoteError } from '../types';

/** The LiFi arm of the per-collateral swap config. */
type LiFiEntry = { baseUrl?: string };

// Subset of the LiFi `/quote` response we consume. `transactionRequest` follows the Ethereum JSON-RPC
// tx shape, so `value` is a hex string ("0x0") — unlike 0x's decimal `transaction.value`.
type LiFiQuote = {
  estimate?: { approvalAddress?: string; toAmount?: string; toAmountMin?: string };
  transactionRequest?: { to?: string; data?: string; value?: string };
};

// A non-zero placeholder `fromAddress` for the indicative probe: LiFi's `/quote` requires a sender,
// but a PriceParameters probe has no executor and never mints executable calldata. A zero address can
// be rejected by some routing paths even with `skipSimulation`, so we send a stable non-zero EOA.
const LIFI_PROBE_ADDRESS = getAddress('0x000000000000000000000000000000000000dEaD');

/**
 * Quotes LiFi via the one-step `/quote` endpoint, which returns ready-to-use `transactionRequest`
 * calldata and a plain-ERC20-`approve` spender (`estimate.approvalAddress` — no Permit2). The bought
 * token lands on `fromAddress` (the Executor). `slippage` is a decimal fraction (bps / 10_000). The
 * sell `fromAmount` is committed off-chain (route-bound calldata), so the resulting {@link Swap}
 * carries `amountIn: { source: 'fixed' }`, and `estimate.toAmountMin` is the server-baked on-chain
 * floor (same semantics as 0x's `minBuyAmount`).
 *
 * `skipSimulation=true` is required: LiFi otherwise eth_call-simulates the built tx, which needs the
 * sender to already hold `fromAmount` and its approval — but the Executor is always zeroed at quote
 * time (collateral only arrives mid-liquidation), so the default simulation would fail every quote.
 * We skip it (mirroring 1inch's `disableEstimate`); the queue re-simulates before broadcast, so the
 * only thing lost is LiFi's gas-limit estimate, which we do not use.
 */
export async function quoteLifi(
  client: RateLimitedClient,
  entry: LiFiEntry,
  params: QuoteParameters
): Promise<Swap> {
  const json = await client.getJson<LiFiQuote>({
    venue: 'lifi',
    url: `${entry.baseUrl ?? LIFI_BASE_URL}/quote`,
    searchParams: {
      fromChain: String(params.chainId),
      toChain: String(params.chainId),
      fromToken: params.tokenIn,
      toToken: params.tokenOut,
      fromAmount: params.amountIn.toString(),
      fromAddress: params.executor,
      slippage: (params.slippageBps / Number(BPS)).toString(),
      skipSimulation: 'true',
      integrator: LIFI_INTEGRATOR
    }
  });

  if (
    !json.estimate?.approvalAddress ||
    !json.transactionRequest?.to ||
    !json.transactionRequest.data
  ) {
    throw new QuoteError('no_route', 'lifi: no route for this pair/size');
  }
  if (!isHex(json.transactionRequest.data)) {
    throw new QuoteError('api_error', 'lifi: transactionRequest.data is not hex');
  }

  return {
    spender: getAddress(json.estimate.approvalAddress),
    target: getAddress(json.transactionRequest.to),
    value: BigInt(json.transactionRequest.value ?? '0'),
    callData: json.transactionRequest.data,
    amountIn: { source: 'fixed', value: params.amountIn },
    expectedAmountOut: BigInt(json.estimate.toAmount ?? '0'),
    amountOutMinimum: BigInt(json.estimate.toAmountMin ?? '0')
  };
}

/**
 * Indicative LiFi price via the same `/quote` endpoint — LiFi has no lighter price-only route. We
 * probe with a placeholder `fromAddress` + `slippage=0` + `skipSimulation=true` (skips the allowance
 * simulation) and read only `estimate.toAmount`. This keeps LiFi in the venue selector's warm ranking
 * rather than the cold-default fallback alone.
 */
export async function priceLifi(
  client: RateLimitedClient,
  entry: LiFiEntry,
  params: PriceParameters
): Promise<PriceQuote> {
  const json = await client.getJson<LiFiQuote>({
    venue: 'lifi',
    url: `${entry.baseUrl ?? LIFI_BASE_URL}/quote`,
    searchParams: {
      fromChain: String(params.chainId),
      toChain: String(params.chainId),
      fromToken: params.tokenIn,
      toToken: params.tokenOut,
      fromAmount: params.amountIn.toString(),
      fromAddress: LIFI_PROBE_ADDRESS,
      slippage: '0',
      skipSimulation: 'true',
      integrator: LIFI_INTEGRATOR
    }
  });

  if (!json.estimate?.toAmount) {
    throw new QuoteError('no_route', 'lifi: no route for this pair/size');
  }
  return { expectedAmountOut: BigInt(json.estimate.toAmount) };
}
