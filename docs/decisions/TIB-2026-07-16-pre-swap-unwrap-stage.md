# TIB-2026-07-16: Pre-swap unwrap stage — uniform `SwapStep` plans and auto-detected ERC4626 redeems

| Field      | Value                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Status** | Proposed — implemented on `feature/crtr-2804-unwrap-seam` (PR 1 of 2); awaiting review                                    |
| **Date**   | 2026-07-16                                                                                                                |
| **Author** | @hayden                                                                                                                   |
| **Scope**  | Package: `@repo/swaps` (+ both liquidation cores' quoting adapters and encoders)                                          |
| **Amends** | [TIB-2026-06-29](./TIB-2026-06-29-midnight-multi-venue-swaps.md) — the single-`Swap` adapter→encoder currency clause only |

---

> **Note.** This TIB covers PR 1 of a stacked pair (CRTR-2804): the unwrap _seam_ plus the ERC4626
> unwrapper. PR 2 adds a Pendle PT unwrapper on top and will land as an **amendment** to this TIB —
> see the placeholder under Future Considerations.

## Context

Both bots resolve exactly ONE venue swap for the raw seized collateral — the `Swap` currency of
[TIB-2026-06-29](./TIB-2026-06-29-midnight-multi-venue-swaps.md), ranked and firm-quoted per
[TIB-2026-07-09](./TIB-2026-07-09-midnight-market-and-venue-selection.md). Exotic collateral breaks
this: ERC4626 vault shares and Pendle PTs often have no direct DEX route, so a liquidatable
position either fails every venue quote or needs a hand-picked config entry pointing at a thin
share-token pool. On Midnight, PT-X/X markets make "the collateral just needs redeeming into the
loan token" the **norm**, not an edge case. The fix is a pre-swap conversion stage: redeem/unwrap
the collateral into a tradable underlying, then (only if still needed) run the existing venue swap.

## Goals / Non-Goals

**Goals**

- **One executable shape** for unwraps and the venue swap, so the encoders flatten everything into
  a single Executor callback queue with no special-cased swap call.
- **Auto-detection over config**: recognize ERC4626 shares on-chain — no per-vault listing to
  maintain (the same toil-that-drifts failure the markets whitelist killed).
- **Worst-case amount threading**: a downstream fixed-amount venue call must never be able to
  revert on an unwrap shortfall.
- **Full-path route quality**: keep the oracle collateral→loan reference as the one sanity check,
  covering unwraps + swap together.
- **Operator escape hatches preserved**: a direct config entry (blue) / `EXCLUDE_COLLATERALS`
  (midnight) still overrides the automatic path.

**Non-Goals**

- **Pendle PT unwrapping** — PR 2, amending this TIB.
- **`erc20Wrapper` / Midas-style unwrappers** — follow-ups; the `Unwrapper` seam is shaped for
  them.
- **Route optimization across unwrap paths.** `resolveUnwraps` is ordered first-match trials
  bounded by `MAX_UNWRAP_DEPTH = 3` (also the cycle guard) — no search.
- **Automatic handling of gated-redeem vaults** (sUSDe-style: preview succeeds, redeem reverts).
  They fail closed in `simulate()` + cooldown; the escape hatches cover them.
- **Post-unwrap decimal-denominated venues.** The request's `tokenInDecimals` describes the RAW
  collateral, so it is dropped after an unwrap — LiquidSwap firm quotes post-unwrap stay
  unsupported until the HyperEVM epic wires a `getDecimals` seam.

## Current Solution

The quote boundary carries one `Swap` (spender/target/callData + the `amountIn` binding union);
each encoder builds `[approve pair, the swap call, repay approve pair]` around that single swap.
There is no conversion stage: exotic collateral is either config'd to a direct share-token route or
skipped as `no_config`.

## Proposed Solution

### 1. `SwapStep` + `SwapPlan.steps` — one uniform executable shape

`SwapStep` (`packages/swaps/src/types.ts`) is one executable conversion call — a vault redeem, a
PT redeem/swap, or the venue swap: `{ tokenIn, tokenOut, target, value, callData, amountIn,
approvalSpender? }`. The `amountIn` binding union (`balance`-spliced at an offset XOR `fixed`)
carries over from `Swap` unchanged; `approvalSpender` is set when the target pulls `tokenIn`
(venue router, Pendle router) and omitted when it burns the caller's own balance (ERC4626 redeem).

`SwapPlan` replaces `Swap` at the quote/encode boundary: ordered `steps` chaining collateral →
loan token (never empty), plus plan-level `expectedAmountOut`/`amountOutMinimum` — **observability
and route-quality only**, never encoder inputs. The encoders flatten `steps` into one callback
queue (`stepCalls` per step: optional USDT-safe zero-then-balance approve pair, then the call) with
no special-cased terminal swap and no nullable swap field — midnight keeps a **single** null
meaning: `plan === null` = pure bad-debt realization.

`Swap` is **not deleted**: it remains each venue adapter's output, normalized into the plan's
final step by `quoting.ts`' `toStep` (the adapter's `spender` becomes `approvalSpender`). Adapters
never learn about unwraps.

### 2. The `Unwrapper` seam and the resolve chain

`Unwrapper` (`packages/swaps/src/unwrappers/resolve.ts`) is `{ kind, resolve({ token, amountIn,
executor }) → { step, expectedAmountOut, amountOutMinimum } | null }`. Per-hop amounts ride
**beside** the step, deliberately not in it: they are quoting-internal threading, and the encoder
never needs them. `resolveUnwraps` tries each unwrapper in order per hop (first match advances)
until none applies, the chain reaches the loan token, or `MAX_UNWRAP_DEPTH` (3 — a PT of a vault
share is depth 2; deeper is pathological). A hop that does not change the token is treated as
"does not apply", so the loop must terminate. Unwrapper errors map onto the existing `failed`
outcome (backoff), never a crash.

### 3. ERC4626 auto-detection (`createErc4626Unwrapper`)

Detection probes `asset()` — **memoized per process, negatives included** (closure state per op
run, mirroring the venue selector's cache). The viem error cause-chain is classified: only a
failure the CONTRACT produced (`ContractFunctionRevertedError` / `ExecutionRevertedError` /
`ContractFunctionZeroDataError`) proves "not a vault" and is safe to memoize; a transport failure
is **rethrown** (→ `failed` + cooldown, which recovers) so an RPC blip can never mislabel a real
vault for the process lifetime. A positive is then gated on `previewRedeem(amountIn)` succeeding
non-zero — amount-dependent, so never cached — which by the EIP-7540 spec also filters async
vaults (their `previewRedeem` MUST revert) and `asset()` false positives.

Config then keys on the **unwrapped underlying**: blue's `SWAP_CONFIG` entry for the underlying
routes the post-unwrap swap, and a **direct entry for the raw collateral wins verbatim** (no
unwrap probing) — backward compatible, and the operator's escape hatch for share tokens with
direct DEX liquidity or gated redeems (sUSDe). Midnight has no config file; its escape hatch stays
`EXCLUDE_COLLATERALS` on the raw collateral.

### 4. Worst-case amount threading

Each hop's `amountOutMinimum` becomes the next stage's `amountIn` — the venue is quoted for the
chain's worst-case output, so a fixed-amount venue's route-bound calldata can never revert on
shortfall. For ERC4626 this is sound by spec: `previewRedeem` ≤ actual redeem in the same
transaction, so threading it can only leave surplus. Surpluses are swept: the encoders append a
skim per deduped **intermediate token** after the two market-token sweeps, preserving the shared
singleton's full-drain invariant.

The redeem step itself is balance-spliced at the shares word (`ERC4626_SHARES_OFFSET = 4`) rather
than fixed — required for midnight's cap-binding branch (`seizedAssets = 0`, seize derived
on-chain) and it absorbs donations to the Executor. No approval: `redeem(shares, executor,
executor)` burns the caller's own shares.

### 5. Route quality composes on the full path

`referenceAmountOut` stays the **full-path** oracle value (collateral → loan). Because the unwrap
chain threads its worst-case amounts into the venue's `amountIn`, the final venue's
`expectedAmountOut` is directly comparable to that reference — one guard covers the whole path.
When the unwrap chain already ends in the loan token (the PT-X/X norm), the plan is the unwrap
steps alone — **no venue call at all** — still route-quality-checked with the threaded worst-case
amount standing in for a quote (conservative: it floors, never predicts).

### 6. Required dependencies over optional

`unwrappers` is a **required** parameter on both `composeQuoting` and `composeMultiVenueQuoting`
(`[]` is explicit venue-only intent) — an optional default would let a caller silently lose
unwrapping. `refresh` is likewise required on `composeMultiVenueQuoting` and **moved inside it**,
after unwrap resolution, so probes price the POST-unwrap pair the bot actually sells.
[TIB-2026-07-09](./TIB-2026-07-09-midnight-market-and-venue-selection.md)'s probe decisions —
liquidatable-pairs-only gating, `staleMs` cache, isolated rate budget, non-fatal probe failure —
are unchanged; only where the refresh runs moved.

## Considered Alternatives

### Alternative 1: Upstream's chained "liquidity venues" (morpho-org/morpho-blue-liquidation-bot)

Upstream models this as `supportsRoute`/`convert` venues that chain by mutating a shared encoder.
Deliberate divergences: **(a)** unwrappers return plain `SwapStep` descriptors instead of mutating
an encoder — the seam stays data, testable and encoder-agnostic; **(b)** upstream sizes each
downstream hop by the previous hop's **expected** output, a latent shortfall bug when the actual
redeem underperforms the estimate — we thread **worst-case** minimums; **(c)** upstream approves
`maxUint256` — we keep the USDT-safe zero-then-balance approve pairs on the shared singleton.

**Why rejected:** all three divergences above.

### Alternative 2: Config-declared unwraps

List each vault/PT in `SWAP_CONFIG` with an `unwrap` directive.

**Why rejected:** toil that drifts — the exact hand-maintained-file failure the markets whitelist
(TIB-2026-07-09) removed. Detection is two memoized view calls; the config keeps only its routing
job (now keyed on the underlying), and a direct entry still overrides.

### Alternative 3: Unwraps beside a nullable terminal swap (`{ unwraps: SwapStep[], swap: Swap | null }`)

**Why rejected:** the encoders would special-case the swap call, and unwrap-only plans would make
the terminal swap nullable — giving midnight's encoder a SECOND null meaning next to
`plan === null` (bad-debt realization). Uniform `steps` keeps one flatten loop and one null.

## Assumptions & Constraints

- **EIP-4626 preview soundness**: `previewRedeem` ≤ actual redeem within the same transaction —
  the threading invariant. A vault violating the spec downward fails closed in `simulate()`.
- **ERC-7540 async vaults** revert on `previewRedeem` by spec — the detection gate filters them.
- Gated-redeem vaults **pass detection** and fail closed at simulation (cooldown + repeated
  attempts until the operator uses an escape hatch) — a known cost, documented, not silent.
- The `asset()` memo lives for one op process; a token migrating vault-ness mid-process is not a
  real scenario. Transport failures never populate the memo.
- `MAX_UNWRAP_DEPTH = 3` bounds work per position and guarantees termination.

## Observability

New stderr events, all `id`-correlated: `unwrap.resolved` (token path + threaded worst-case
amount), `unwrap.failed` (classified reason), `unwrap.preview_reverted` / `unwrap.preview_zero`
(detection near-misses), `unwrap.bad_route`; unwrap-only plans log `quote.ok` with
`venue: 'unwrap-only'`. Plan-level `expectedAmountOut`/`amountOutMinimum` exist for these events
and the route-quality guard only.

## Security

- **Trust chain unchanged**: min-out floors live inside step calldata, the oracle route-quality
  guard covers the full path, and the on-chain `simulate()` ok-only gate still fronts broadcast — a
  wrong unwrap fails closed as a missed liquidation, never a bad fill.
- **Full-drain invariant extended, not weakened**: every intermediate token the step chain
  introduces gets its own sweep to the operator EOA; fixed-amount surpluses cannot strand value on
  the permissionless singleton.
- **No new approvals**: the ERC4626 redeem needs none (burns own shares); step approvals reuse the
  USDT-safe zero-then-balance pair, whose residual is inert under full-drain.
- Balance-splicing the shares word means a donation to the Executor is redeemed and swept, not a
  griefing vector.

## Future Considerations

- **Pendle PT unwrapper (PR 2 — amends this TIB).** Specifics land there: fixed-amount Pendle
  router steps that DO need `approvalSpender`, markets-list detection with success-only caching
  gated by `PENDLE_CHAIN_IDS`, conservative min-out sizing, and the cold-cache blast radius of a
  Pendle markets-API outage.
- **`erc20Wrapper` / Midas unwrappers** — the seam is shaped for them.
- **Post-unwrap `tokenInDecimals`**: a `getDecimals` seam (HyperEVM epic) would re-enable
  LiquidSwap firm quotes for unwrapped underlyings.

## Amended Decisions

- **TIB-2026-06-29** — the "one `Swap` currency from adapter to encoder" clause only: the
  quote/encode boundary now carries a `SwapPlan` of uniform `SwapStep`s. `Swap` remains the venue
  adapters' output (normalized by `toStep`); the `amountIn` binding union, the venue-agnostic
  encoder principle, and seize-exact sizing carry over unchanged.

## References

- Linear: CRTR-2804.
- [TIB-2026-06-29: Midnight liquidation bot — multi-venue swap support](./TIB-2026-06-29-midnight-multi-venue-swaps.md)
  — the `Swap` currency and venue-agnostic encoder this generalizes.
- [TIB-2026-07-09: Midnight market whitelist and venue selection](./TIB-2026-07-09-midnight-market-and-venue-selection.md)
  — the multi-venue selector; its probe now prices the post-unwrap pair, gating unchanged.
- [TIB-2026-07-13: Off-chain bot architecture](./TIB-2026-07-13-bot-architecture.md) — the
  `liquidate` transform the quoting stage runs inside.
- `morpho-org/morpho-blue-liquidation-bot` — upstream's chained liquidity-venue model
  (Alternative 1): `https://github.com/morpho-org/morpho-blue-liquidation-bot`
- EIP-4626 (`previewRedeem` ≤ redeem) and EIP-7540 (async `previewRedeem` MUST revert).
