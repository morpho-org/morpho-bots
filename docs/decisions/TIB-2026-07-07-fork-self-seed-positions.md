# TIB-2026-07-07: Fork tests self-seed their liquidatable position

| Field      | Value                     |
| ---------- | ------------------------- |
| **Status** | Accepted                  |
| **Date**   | 2026-07-07                |
| **Author** | @hayden                   |
| **Scope**  | App: midnight-liquidation |

---

## Context

The end-to-end fork suite (`test/fork/liquidation.test.ts`) liquidates a real Midnight position on a
Base fork. Until now it pinned a specific position — a market id, borrower, and maturity — that had
been created out-of-band on the live contract by running `scripts/seed-liquidatable-positions.ts`,
with `FORK_BLOCK` pinned just after that seed tx so the position, oracle, and pool were deterministic.

That coupling broke on every contract migration. When the Midnight deployment moved from `0x2F7a…`
(commit `3836155f`) to `0xAdedD8ab…` (commit `336b924a`), the pinned position no longer existed on the
new contract, and the fresh deployment had no organic debt to point at instead. Re-establishing the
fixture required an operator to fund two EOAs and run the live seeder before the fork test could pass
again — a manual, capital-consuming step gating CI on every migration.

## Goals / Non-Goals

**Goals**

- Make the fork suite self-contained: it should mint whatever position it needs inside the fork, with
  no dependency on a pre-existing on-chain fixture or a prior live-seeding run.
- Survive contract migrations with only an address/typehash bump — no manual re-seeding.
- Exercise the offer-signing path (EIP-712 typehashes, ratifier digest) end-to-end as a side effect,
  so a typehash regression fails the fork test rather than only a unit test.

**Non-Goals**

- Replacing the operator seeder (`scripts/seed-liquidatable-positions.ts`). It still targets **live**
  Base with real capital and real swaps; only the **test** stops depending on its output.
- Testing price-drop liquidation. The fork test uses post-maturity liquidation (warp past `maturity`),
  which is deterministic and does not require nudging the oracle.

## Current Solution

`test/fork/harness.ts` exported a `POSITION` constant (id/borrower/maturity) referencing a real seeded
position on `0x2F7a…`, and `FORK_BLOCK` was pinned just after its seed tx.

## Proposed Solution

Add `test/fork/seed.ts` → `seedLiquidatablePosition(test, rpcUrl)`, called in the suite's `beforeAll`,
which opens a fresh liquidatable WETH/USDC position on the fork and returns `{ id, borrower, maturity }`
(the same shape the old `POSITION` constant had). It:

1. Clones a real curator-trusted WETH/USDC oracle + `lltv`/`liquidationCursor` (from the Midnight API,
   pinned as harness constants) so price scaling matches production. Because the fresh deploy has not
   enabled that cursor yet, the seeder impersonates the on-chain `configurator` (anvil cheatcode) and
   calls `enableLiquidationCursor`.
2. Funds two throwaway EOAs via cheatcodes: ETH via `setBalance`, WETH by wrapping, and USDC by a real
   Uniswap swap on the fork (no external whale, no fragile storage-slot pokes).
3. Reuses the operator seeder's offer cryptography (`scripts/seed/offers.ts`: `hashOffer`,
   `signOfferTree`, `encodeRatifierData`, `toId`) **verbatim**, then drives the real order-book path —
   `supplyCollateral` + `take` — to create the debt (Midnight has no `borrow()`).
4. Sets `maturity` an hour out so the position is healthy at creation (the `take` seller-health check);
   the suite then warps past `maturity` to make it post-maturity liquidatable.

`FORK_BLOCK` is a fixed block shortly after the deploy so the oracle price and pool depth stay
deterministic; `RPC_URL_8453` must be an archive endpoint that serves that historical block.

## Considered Alternatives

### Alternative 1: Keep a pinned live-seeded fixture

Re-seed a real position on each new deployment and re-pin `POSITION`/`FORK_BLOCK`.

**Why rejected:** the recurring manual, capital-consuming step this TIB exists to remove; also leaves
the fork test unable to run on a freshly deployed contract until someone seeds it.

### Alternative 2: Deploy a mock oracle instead of cloning a real one

Deploy a constant-price mock oracle on the fork and use it in the market.

**Why rejected:** the oracle price scaling (1e36 convention across token decimals) must match what the
lens and the real WETH/USDC pool expect, or the collateral-unwind swap's `amountOutMinimum` diverges
from pool spot and the liquidation reverts. Cloning a real, live oracle gets this right by construction.

## Assumptions & Constraints

- `RPC_URL_8453` is an archive RPC that serves state at the fixed `FORK_BLOCK` (a CI secret; locally
  set it in `.env.test.local` — bun skips `.env.local` under `NODE_ENV=test`). Non-archive public RPCs
  (e.g. `mainnet.base.org`) prune older state and cannot fork this block.
- The cloned oracle/lltv/cursor remain valid Base values; if the curator-trusted market changes, the
  harness constants are updated.
- A WETH/USDC Uniswap-V3 pool with depth for a ~$1 swap exists at the fork block (used to fund USDC).

## Future Considerations

- The seeding helper could be parameterized (pair, notional, drawdown, pre- vs post-maturity) if future
  fork tests need multiple positions or price-drop liquidation.
