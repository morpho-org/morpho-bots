# Midnight Liquidation Bot — Executive Summary

> Companion to TIB-2026-05-28 (midnight liquidation bot — production v1).

## TL;DR

We're shipping a production Midnight liquidation bot that serves two audiences at once: as a
_reference implementation_ for integrators (so the health and sizing math reads as
documentation), and as a _fallback liquidator_ we run ourselves to catch positions the
competitive ecosystem misses.

## Three architectural pillars

1. **Discovery via the Morpho Midnight API.** Replace the entire `eth_getLogs` + dedupe
   pipeline with `GET /v1/midnight/markets` and `GET /v1/midnight/positions`
   (cursor-paginated, `Cache-Control: max-age=2`). The API also exposes `/chains` with
   `latest_indexed_block` — a built-in staleness signal we gate on. **Types are generated
   from the OpenAPI spec** (`openapi-typescript` + `openapi-fetch`), with a sync script + CI
   drift check so spec changes surface in PRs.

2. **Fresh state via a deployless lens.** Authored in inline Solidity via `soltag`, executed
   through `@morpho-org/viem-dlc`'s deployless transport. One `eth_call` per tick returns —
   for every candidate — a validated `Obligation`, liquidatable flag, gate decision,
   USD-valued best collateral slot, and the inputs needed to evaluate the LIF curve and RCF
   cap. **Rule of thumb: API for discovery, `eth_call` for decisions.** No `block.timestamp`
   drift, no oracle-read round-trips, and the lens itself doubles as a hash check that the
   API-supplied market struct matches the on-chain id.

3. **Execution via a shared executooor singleton.** A modified
   [Rubilmax/executooor](https://github.com/Rubilmax/executooor), deployed once per chain and
   called by every integrator (no per-operator deploy). We add `onLiquidate` so it can
   execute a sub-call list inside Midnight's callback. The bot
   broadcasts `exec([liquidate(...)])` and the executooor performs a single-hop DEX swap
   (seized collateral → loan token) atomically. **Single-hop only — no path routing.**
   Operator supplies one Uniswap-V3-style pool per collateral; volatile assets get a
   permissive slippage or are simply opted out.

## Supporting choices

- **Long-running daemon**, one process per chain, driven by block number polling
- **In-memory tx queue.** Nonce assignment delegated to viem's `createNonceManager` (off the
  shelf — handles concurrent-safe assignment + chain sync). Our queue owns only what viem
  doesn't: tracking pending hashes, EIP-1559 fee bumps with a hard ceiling, and resubmits at
  the same nonce when a tx is stuck. Chain truth wins on restart — no persistence.
- **No profitability gate.** Submit every sim-ok plan. We're a coverage bot, not a
  competitor.
- **Correct sizing.** Full LIF curve + pre-maturity RCF cap (with `rcfThreshold` exemption),
  evaluated against the lens's `block.timestamp`. This is the load-bearing math for
  integrators.

## Implementation phases

1. **API + market index.** Generated types, indexer-lag gate, dry-run output.
2. **Lens + sizing.** Soltag lens, deployless read, correct LIF/RCF math. Still read-only.
3. **Daemon + nonce queue + signed sends** against a deterministic-revert dummy callback to
   exercise the queue without swapping.
4. **Callback wiring + swap config.** Go-live gate on testnet against a real pool.

## Explicit non-goals

Profitability gating, multi-hop routing, multi-chain in one process, flashloan funding,
persistent queue state, MEV-aware bidding. All are valid follow-up TIBs but would muddy this
one.

## Dependencies worth flagging

- `soltag@0.0.17` and `openapi-fetch` are new direct dependencies; both are tiny.
- `@morpho-org/viem-dlc@0.0.11` stays as-is.
- `executooor` contract + need for integrator to deploy it
