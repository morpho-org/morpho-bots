# TIB-2026-07-09: Extract `@repo/swaps` and `@repo/bot-kit` from the liquidation bots

| Field      | Value                                                                           |
| ---------- | ------------------------------------------------------------------------------- |
| **Status** | Proposed — implemented; bot migration pending                                   |
| **Date**   | 2026-07-09                                                                      |
| **Author** | @hayden                                                                         |
| **Scope**  | Repo-wide (new packages + `bots/blue-liquidation`, `bots/midnight-liquidation`) |

---

## Context

`bots/blue-liquidation` ([TIB-2026-06-30](./TIB-2026-06-30-blue-liquidation-bot.md)) was built by
copy-paste-then-specialize from `bots/midnight-liquidation`
([TIB-2026-05-28](./TIB-2026-05-28-midnight-liquidation-bot.md) +
[TIB-2026-06-29](./TIB-2026-06-29-midnight-multi-venue-swaps.md)). The two bots share **27
identically-pathed `src/` files**: 7 are byte-identical (`logger`, `queue/backoff`,
`queue/fee-policy`, `quotes/http-client`, the 0x and 1inch venue adapters, `runner/watcher`), ~5
more differ only in JSDoc, and the rest are near-identical modules with mechanical deltas
(`signer`, `queue/pending-queue`, `tx-error`, `composeQuoting`, the swap-config zod schemas, venue
constants). Every fix has to land twice, and the upcoming Midnight multichain work would fork the
copies further. The multi-venue TIB already anticipated part of this ("hoist the rate-limited HTTP
client to `@repo/utils` when a second bot needs it") — the second bot arrived.

## Goals / Non-Goals

**Goals**

- One home for every module the two bots share, so a fix lands once.
- **Byte-equivalence for prod.** Both bots are live on Railway; every extracted runtime path is a
  verbatim move or an optional-parameter superset whose defaults reproduce Blue's exact behavior
  and whose explicit arguments reproduce Midnight's. No behavior change, no new log keys.
- Keep the shared packages **protocol-agnostic**: they must never import a bot's `Config`, lens
  types, or protocol pipeline shapes.
- Where multichain forced a shape divergence between the two copies, the extracted signature
  follows Blue's multichain shape (Midnight passes its single chain) — paving Midnight's later
  multichain migration rather than blocking it.

**Non-Goals**

- **Genericizing the protocol pipelines.** `tick`, `eligibility`, `config`, lens, and sizing
  stay per-bot (see Considered Alternatives — premature abstraction while Midnight still evolves).
- **Extracting discovery.** ALL of `discovery/borrowers.ts` stays per-bot, including
  `createPostgresQuery` / `rindexerSyncedBlock` — both bots' SQL is similar today but expected to
  diverge, so it is deliberately not extracted.
- **Deploy infra.** `Dockerfile` / `docker-compose.yml` / `scripts/deploy-railway.ts` (~230 diff
  lines of copy-paste) are deferred to a follow-up.
- **Migrating the bots in this change.** The packages land first; both bots switch over in a
  follow-up PR.

## Current Solution

Each bot vendors its own copy of the runtime (logger, client, signer, queue, watcher/runner,
simulate, tx-error) and the whole quoting stack (`Swap` type, venue adapters, HTTP client,
swap-config schemas, `composeQuoting`). `@repo/utils` holds only generic helpers; the fixed-point
primitives (`mulDivDown` etc.) live duplicated in each bot's `sizing/math.ts`.

## Proposed Solution

Two new workspace packages, **deliberately independent of each other** — neither imports the
other; the only shared surface is a structural logger type.

### `@repo/swaps` — venue-agnostic quoting

Everything from `src/quotes/` plus its config and constants:

- **`types.ts` keeps ZERO runtime imports.** `Swap`, `Venue`, `QuoteParameters`, `VenueAdapter`
  are type-only, so a bot's `encode-call.ts` can `import type { Swap }` without creating a runtime
  cycle.
- **Venue constants** with a per-chain `ONEINCH_ROUTER` map — Blue's multichain shape wins;
  Midnight looks up its single chain.
- **Swap-config zod schemas** + `parseSwapConfig` + `VENUE_API_KEY_ENV` (the fixed
  `ZEROX_API_KEY` / `ONEINCH_API_KEY` convention).
- The **rate-limited venue HTTP client** (its token bucket hoisted to `@repo/utils` as
  `createTokenBucket`, per the multi-venue TIB's future consideration) and the
  **`uniswap-v3` / `0x` / `1inch` adapters**.
- A **request-shaped `composeQuoting`**:

  ```ts
  quoteFor(request: {
    collateralToken: Address
    loanToken: Address
    amountIn: bigint
    referenceAmountOut: bigint
  }): Promise<Swap | null>
  ```

  Each bot keeps a thin adapter that projects its protocol lens output into this request — so
  each bot's `tick.ts` is untouched and the package never learns protocol lens shapes.

- Takes a **structural `QuoteLogger`** (`{ info, warn }`), so it does not depend on
  `@repo/bot-kit`.

### `@repo/bot-kit` — protocol-agnostic bot runtime

- **JSON-line logger** (verbatim move).
- **Deployless read client** + `assertContractDeployed`.
- **Signer** — Midnight's superset: `sendRpcUrl` + `syncNonce`; options decoupled from any bot
  `Config`; key renamed `privateKey`.
- **`tx-error` with a pluggable `RevertDecoder`**:
  `revertReason(error, decode = decodeStandardRevert)` plus an `abiRevertDecoder(abi)` factory —
  Midnight keeps decoding its custom ABI errors, Blue uses the standard `Error(string)` /
  `Panic(uint256)` default.
- **Queue** — `pending-queue` is Midnight's superset with `syncNonce?` and
  `settledCooldownBlocks?` optional; the defaults reproduce Blue's exact behavior.
  `STUCK_BLOCKS` / `MAX_BUMP_ATTEMPTS` become overridable package defaults. `fee-policy` and
  `backoff` move verbatim.
- **Block watcher + runner** (the runner takes an optional `revertReason` dep) and **simulate**.

### `@repo/utils` additions

- `mulDivDown` / `mulDivUp` / `zeroFloorSub` / `bigintMin` — the shared fixed-point primitives.
  Each bot's `sizing/math.ts` re-exports them, keeping its protocol-citation doc anchors
  (e.g. Blue's `MathLib` references) in place.
- `createTokenBucket` — hoisted from the venue HTTP client.

### Implementation Phases

- **Phase 1 — `@repo/swaps`** (`feature/extract-2-swaps`): the quoting stack, request-shaped
  `composeQuoting`, and the `@repo/utils` hoists. Implemented.
- **Phase 2 — `@repo/bot-kit`** (`feature/extract-3-bot-kit`): the runtime supersets. Implemented.
- **Phase 3 — bot migration** (follow-up PR): both bots delete their local copies and import the
  packages; diffs must show only import-path changes plus the thin `quoteFor` adapters.
- **Phase 4 — deploy infra** (deferred): unify `Dockerfile` / `docker-compose` /
  `deploy-railway.ts`.

Housekeeping note: the new `swaps` / `bot-kit` scopes go in the CLAUDE.md scope table; `AGENTS.md`
turned out to be a symlink to `CLAUDE.md`, so the mirror-discipline update is automatic.

## Considered Alternatives

### Alternative 1: One package instead of two

Ship a single `@repo/bot-kit` containing both the runtime and the quoting stack.

**Why rejected:** The runtime and the swaps stack have no real coupling — the only shared surface
is a logger, and a structural `QuoteLogger` covers that without a dependency edge. Two independent
packages let a future bot take quoting without the runner (or vice versa) and keep each package's
dependency footprint minimal.

### Alternative 2: Extend `@repo/utils` with everything

Put the shared modules in the existing shared package instead of creating new ones.

**Why rejected:** `@repo/utils` stays a pure helper library. Pulling in wallet-client machinery
(signer, nonce queue, watcher) would change its character and force viem wallet deps on every
consumer. It gains only the pure primitives (`mulDiv*`, `createTokenBucket`).

### Alternative 3: Genericize the protocol pipelines too

Extract `tick` / `eligibility` / `config` / discovery behind protocol interfaces, leaving each bot
as a thin plugin.

**Why rejected:** Premature — a leaky-abstraction risk while Midnight is still evolving (new
deployment migrations, upcoming multichain). The protocol pipelines stay per-bot, as does all of
`discovery/borrowers.ts`: both bots' SQL is similar today but expected to diverge, so
`createPostgresQuery` / `rindexerSyncedBlock` are deliberately NOT extracted.

## Assumptions & Constraints

- **Byte-equivalence is the acceptance bar.** Every extracted runtime path is a verbatim move or
  an optional-parameter superset; defaults match Blue's current behavior, explicit args match
  Midnight's. Both bots are live in prod, so any observable delta is a defect.
- Where the two copies diverged for multichain reasons, the extracted signature follows Blue;
  Midnight's later multichain migration should require config, not package changes.
- The packages never learn protocol shapes: `composeQuoting` is request-shaped, the queue and
  runner take plain options, and `tx-error`'s decoder is injected. If a future extraction needs a
  lens type in a shared package, that is a signal to stop and re-scope.
- `@repo/swaps` and `@repo/bot-kit` stay mutually independent; the structural `QuoteLogger` is the
  only sanctioned overlap.

## Future Considerations

- **Deploy-infra extraction** (Phase 4) — the remaining ~230 lines of copy-paste.
- **Midnight multichain** — the Blue-shaped signatures (per-chain `ONEINCH_ROUTER`, chain-passing
  call sites) exist to make this a bot-local change.
- **Discovery extraction** — revisit only if the two bots' SQL stays convergent after Midnight's
  multichain work; today divergence is the expectation.

## References

- [TIB-2026-05-28: Midnight liquidation bot — v0](./TIB-2026-05-28-midnight-liquidation-bot.md) —
  source of the runtime supersets (signer, pending-queue, ABI revert decoding).
- [TIB-2026-06-29: Midnight liquidation bot — multi-venue swap support](./TIB-2026-06-29-midnight-multi-venue-swaps.md)
  — origin of the `Swap` currency and the HTTP client this TIB hoists (its Future Considerations
  predicted the `@repo/utils` hoist).
- [TIB-2026-06-30: Blue liquidation bot — v0](./TIB-2026-06-30-blue-liquidation-bot.md) — the
  clone whose multichain shapes the extracted signatures follow.
- Branches: `feature/extract-2-swaps`, `feature/extract-3-bot-kit`.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
