import type { Address, Hex } from 'viem'

// Pure types shared across the quoting layer and the encoder. This module has NO runtime imports, so
// `encode-call.ts` can `import type { Swap }` from here without creating a runtime cycle.

/** A swap venue the operator can route a collateral through. */
export type Venue = 'uniswap-v3' | '0x' | '1inch'

/**
 * Input to a venue's quote. Raw integer token units throughout — Blue's oracle price converts
 * collateral → loan natively, so no USD/decimals round-trip is needed. `executor` is the
 * taker/from/recipient: the Executor singleton holds the collateral, performs the swap, and receives
 * the loan token for the repay.
 */
export type QuoteParameters = {
  chainId: number
  tokenIn: Address // seized collateral
  tokenOut: Address // loan token
  amountIn: bigint // the seized collateral the Executor will hold — exactly `plan.seizedAssets` (seize-exact)
  slippageBps: number
  executor: Address
  /** Oracle-priced expected output (no DEX slippage) — the no-route-quality reference. */
  referenceAmountOut: bigint
}

/**
 * An executable swap, ready to drop into the Executor's callback queue. Venue-agnostic: the min-out
 * floor is already encoded inside `callData`, so the encoder never inspects the venue — it only needs
 * to know how the on-chain input amount is bound (`amountIn`).
 */
export type Swap = {
  /** ERC20 `approve` target for `tokenIn`. */
  spender: Address
  /** Swap call target (often === spender). */
  target: Address
  /** Native value to forward (0 for ERC20 → ERC20). */
  value: bigint
  /** Pre-built swap calldata; the min-out floor is already encoded inside it. */
  callData: Hex
  /** How the on-chain input amount is bound. */
  amountIn:
    | { source: 'balance'; offset: bigint } // splice the Executor's live `tokenIn` balance at `offset`
    | { source: 'fixed'; value: bigint } // `callData` commits to `value`; do NOT splice
  /** The venue's quoted output — route-quality check + logging. */
  expectedAmountOut: bigint
  /** The min-out floor encoded in `callData` — logging/observability. */
  amountOutMinimum: bigint
}

/** Why an executable quote could not be produced (for logging + backoff). */
export type QuoteFailureReason = 'timeout' | 'rate_limited' | 'no_route' | 'api_error' | 'bad_route'

/**
 * The result of resolving a swap for one liquidatable position:
 * - `swap` — an executable swap to encode + simulate;
 * - `no_config` — the operator has not configured this collateral (a coverage gap, not a failure; no
 *   API call was made) → skip with `config.no_swap_path`, no backoff;
 * - `failed` — a transient quote/route failure (API down, no route, or the route fails the oracle
 *   sanity check) → skip and back the position off.
 */
export type QuoteOutcome =
  | { kind: 'swap'; swap: Swap }
  | { kind: 'no_config' }
  | { kind: 'failed'; reason: QuoteFailureReason }

/** Thrown by adapters/HTTP client to carry a classified {@link QuoteFailureReason}. */
export class QuoteError extends Error {
  readonly reason: QuoteFailureReason

  constructor(reason: QuoteFailureReason, message: string) {
    super(message)
    this.name = 'QuoteError'
    this.reason = reason
  }
}
