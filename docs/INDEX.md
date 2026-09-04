# Documentation Index

Quick navigation for the morpho-bots documentation.

---

## Guides

- [Agent Instructions](../AGENTS.md) — how to work in this repo (`CLAUDE.md` and `.cursorrules` symlink to it)
- [Mission](./MISSION.md) — the North Star the repo is built toward
- [Coding Conventions](./CONVENTIONS.md) — code style, patterns, best practices
- [Review Loop](../.agents/skills/review-loop/SKILL.md) — the satisficing self-check, and how TIBs, implementations, and PR-review responses get independently reviewed
- [Documentation Guidance](./GUIDANCE.md) — when to write a TIB, TIB lifecycle, TIB vs Linear
- [Docs Layout](./README.md) — how `docs/` is organized and how to add a TIB
- [Official Docs Drafts](./official/README.md) — candidate pages for Morpho public documentation

---

## Bots

| Bot                                                       | Description                                                | Docs                                                 |
| --------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| [blue-liquidation](../bots/blue-liquidation/)             | Liquidates eligible Morpho Blue positions                  | [README](../bots/blue-liquidation/README.md)         |
| [midnight-liquidation](../bots/midnight-liquidation/)     | Liquidates eligible Midnight positions                     | [README](../bots/midnight-liquidation/README.md)     |
| [midnight-crossed-books](../bots/midnight-crossed-books/) | Resolves crossed Midnight order books                      | [README](../bots/midnight-crossed-books/README.md)   |
| [quoter-bot](../bots/quoter-bot/)                         | Midnight maker: setup checks, bootstrap, ladder quoting    | [README](../bots/quoter-bot/README.md)               |
| [vault-v1-reallocation](../bots/vault-v1-reallocation/)   | Reallocates liquidity across MetaMorpho (Vault V1) markets | [README](../bots/vault-v1-reallocation/README.md)    |
| [vault-v2-reallocation](../bots/vault-v2-reallocation/)   | Reallocates liquidity across Morpho Vault V2 markets       | [README](../bots/vault-v2-reallocation/README.md)    |
| kill-switch                                               | **Withdrawn** — project cancelled 2026-06-29, docs only    | [TIB](./decisions/TIB-2026-05-14-kill-switch-bot.md) |

---

## Services

| Service                                     | Description                                                                       | Docs                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------- |
| [quoter-signer](../services/quoter-signer/) | KMS signing policy middleware Lambda image (fail-closed skeleton, TIB-2026-08-12) | [README](../services/quoter-signer/README.md) |

---

## Packages

| Package                                                   | Description                                                                  | Docs |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- | ---- |
| [@repo/bot-kit](../packages/bot-kit/)                     | Shared bot runtime: clients, logger, watcher/runner, tx queue, state, policy | —    |
| [@repo/contracts](../packages/contracts/)                 | Shared contract ABIs and Executor sources                                    | —    |
| [@repo/logging](../packages/logging/)                     | CLI presenter: stdout results, stderr errors, bigint-safe JSON Lines         | —    |
| [@repo/monitoring](../packages/monitoring/)               | Monitor interval waits, serial operation queue, cycle-failure predicate      | —    |
| [@repo/observability](../packages/observability/)         | Bot lifecycle/record shipping, process observers, verbose argv gating        | —    |
| [@repo/offers](../packages/offers/)                       | Maker offer-book model: prospective batching and negative-spread checks      | —    |
| [@repo/swaps](../packages/swaps/)                         | Multi-venue DEX quoting, routing, unwrap seam, and venue selection           | —    |
| [@repo/typescript-config](../packages/typescript-config/) | Shared TypeScript configuration                                              | —    |
| [@repo/utils](../packages/utils/)                         | Shared server-safe utilities                                                 | —    |

---

## Data Flow Diagrams

_None yet — copy [`templates/DATA-FLOW.md`](./templates/DATA-FLOW.md) into a bot or package directory when documenting data flow._

---

## TIBs (Repo-wide)

- [TIB-2026-04-16: Bootstrap Curator Bots](./decisions/TIB-2026-04-16-bootstrap-curator-bots.md) — initial scaffold, tooling stack, and migration plan from `morpho-apps`
- [TIB-2026-07-16: Revert to bots-as-programs](./decisions/TIB-2026-07-16-revert-to-bots-as-programs.md) — reverts the one-shot op pipeline back to standalone long-running bots on `@repo/bot-kit`; records what was kept, dropped, and re-embedded
- [TIB-2026-07-13: Off-chain bot architecture](./decisions/TIB-2026-07-13-bot-architecture.md) — **Superseded** by TIB-2026-07-16. The one-shot op pipeline, `apps/`+`packages/`+`deploy/` monorepo shape, transparent JSON-Lines wire contract, per-chain queue and policy-signer daemons, config/state model, and log correlation — tried and reverted
- [TIB-2026-07-14: Pared-down Slack CI notifications](./decisions/TIB-2026-07-14-slack-ci-notifications.md) — two `github-script` workflows posting basic PR notifications (store-free threading via a PR-body marker) and `release: published` notes to Slack, deliberately trimmed from `prime-monorepo`'s `@repo/ci-scripts` system — implemented
- [TIB-2026-07-14: BetterStack log forwarding](./decisions/TIB-2026-07-14-betterstack-log-forwarding.md) — opt-in in-process log shipping: `@repo/bot-kit`'s loglayer logger ([packages/bot-kit/src/logger.ts](../packages/bot-kit/src/logger.ts)) ships structured logs to a per-bot BetterStack source when both `BETTERSTACK_SOURCE_TOKEN` and `BETTERSTACK_INGESTING_HOST` are set (partial config fails loud); inert otherwise — implemented. The addenda record dropping the earlier Vector side-car for this in-process transport
- [TIB-2026-07-15: CI/CD deploy pipeline for Railway bots](./decisions/TIB-2026-07-15-ci-deploy-pipeline.md) — deploy-only GitHub Actions (`railway up`, secrets stay on Railway): `push:main` redeploys both bots to staging, `release-{bot}`-labelled merges ship to production + cut a CalVer tag; four scoped GitHub Environments, `push:main` chosen over `pull_request:closed` for the environment branch policy — implemented
- [TIB-2026-08-04: Extract quoter-bot shared packages](./decisions/TIB-2026-08-04-extract-quoter-bot-shared-packages.md) — four standalone workspace packages extracted from the quoter-bot bot (`@repo/logging`, `@repo/observability`, `@repo/monitoring`, `@repo/offers`), deliberately not folded into `@repo/bot-kit`/`@repo/utils`; behavior-preserving, with the observability error-name projection now injected
- [TIB-2026-07-07: Fork tests self-seed their liquidatable position](./decisions/TIB-2026-07-07-fork-self-seed-positions.md) — fork suites mint their own edge-of-liquidation position instead of depending on a live one — accepted
- [TIB-2026-07-20: Migrate to pnpm](./decisions/TIB-2026-07-20-migrate-to-pnpm.md) — replaces the bun toolchain with pnpm workspaces, Node, and Vitest; the version catalog and `allowBuilds` default-deny come from here — proposed
- [TIB-2026-09-03: AGENTS.md as the canonical instruction file](./decisions/TIB-2026-09-03-agents-md-canonical-instruction-file.md) — `AGENTS.md` becomes the real file with `CLAUDE.md`/`.cursorrules` symlinked to it, cut from 301 lines to ~90; records what was evicted, where it went, and the admission criteria for anything added back — accepted

## TIBs (Bot-scoped)

- [TIB-2026-06-30: Blue liquidation bot — v0](./decisions/TIB-2026-06-30-blue-liquidation-bot.md) — Morpho Blue ecosystem-backstop liquidator (accrual-aware soltag lens, multi-venue swaps, generic Executor, Railway; the TIB's rindexer discovery has since been replaced by Morpho GraphQL API discovery) — implemented
- [TIB-2026-07-09: Midnight market whitelist and venue selection](./decisions/TIB-2026-07-09-midnight-market-and-venue-selection.md) — API-sourced market whitelist + best-of-venues probe selection replacing the hand-maintained routing file; Uniswap dropped as a direct venue — implemented. **Partly superseded** by TIB-2026-08-31 (probe ladder, gross ranking, probe-proxy assumption)
- [TIB-2026-08-28: Midnight send shortfall — classifying a rejected broadcast](./decisions/TIB-2026-08-28-midnight-send-shortfall-classification.md) — what the 2026-08-28 15:00 UTC maturity measured (tick accounting held; 153 of 167 simulated sends rejected; quoted-vs-realized at p50 0.0 bps) and the decisions from it: an on-chain execution revert no longer arms per-position backoff — classified by revert **class**, never by decoded string — a deliberate `midnight-liquidation` vs `blue-liquidation` divergence on that rule, the 4-byte selector logged, and route cost rather than quote bias named as the economic lever
- [TIB-2026-08-31: Venue selection by USD cost curve](./decisions/TIB-2026-08-31-venue-cost-curve-selection.md) — supersedes three TIB-2026-07-09 clauses: the probe ladder becomes fixed USD decades ($0.01–$100k, 8 rungs), the cache stores a per-rung venue **rate** (pair-keyed, shared across markets, bps derived per candidate at read time) on a 30–60 s TTL, and ranking becomes net of interpolated route cost above the candidate cap, failing open to gross ordering; the curve also predicts the firm quote's min-out denominator — the one decision inside the correctness chain, bounded on both sides of break-even
- [TIB-2026-08-12: Quoter-bot KMS signing policy middleware](./decisions/TIB-2026-08-12-quoter-bot-kms-signing-middleware.md) — an AWS Lambda behind invoke-only IAM becomes the sole `kms:Sign` principal on the maker key; the bot submits structured revoke/quote intents, the Lambda validates no-crossed-books/price-bounds/no-PnL-drop policy against its own independent chain reads and encodes/derives digests itself (sign-what-you-encode), bounding full bot-host compromise to in-policy quoting loss plus revoke griefing
- [TIB-2026-08-27: Quoter-bot loan-as-collateral markets](./decisions/TIB-2026-08-27-quoter-loan-as-collateral-markets.md) — on Midnight markets whose collateral list contains the loan asset (constant price-1 oracle, LLTV = 1 expected), the maker posts loan-asset collateral sized by a maturity-safe coverage invariant and quotes both sides from zero inventory: sells turn non-reduce-only (borrowing on fill) behind an opt-in per-market `debt` config block, buys deleverage via protocol netting, bootstrap becomes unnecessary; collateral management is manual-first — partially supersedes TIB-2026-07-27

_Bot-scoped TIBs move under `packages/<bot>/docs/decisions/` once a bot lands; proposal TIBs for
not-yet-built bots sit in `docs/decisions/` alongside their siblings._

- [TIB-2026-05-14: Kill-switch bot](./decisions/TIB-2026-05-14-kill-switch-bot.md) — vault circuit breaker that nukes `supplyQueue` on oracle staleness/deviation — **withdrawn**, project cancelled 2026-06-29
- [TIB-2026-05-28: Midnight liquidation bot — v0](./decisions/TIB-2026-05-28-midnight-liquidation-bot.md) — the original Midnight liquidator design — accepted, implemented
- [TIB-2026-06-29: Midnight multi-venue swap support](./decisions/TIB-2026-06-29-midnight-multi-venue-swaps.md) — collateral unwinding across several DEX venues — proposed, implemented
- [TIB-2026-07-27: Midnight ladder quoter-bot — v0](./decisions/TIB-2026-07-27-midnight-quoter-bot.md) — the maker bot's ladder quoting design — proposed
- [TIB-2026-08-14: Quoter-bot Docker Hub publishing](./decisions/TIB-2026-08-14-quoter-bot-dockerhub-publishing.md) — `morphoorg/quoter-*` images on production release — proposed
- [TIB-2026-08-14: Quoter-bot Helm chart](./decisions/TIB-2026-08-14-quoter-bot-helm-chart.md) — package-owned chart for Kubernetes self-hosting — proposed
- [TIB-2026-08-14: Quoter-bot cross-book clearance](./decisions/TIB-2026-08-14-quoter-cross-book-clearance.md) — clearance and bound clamping — proposed
- [TIB-2026-08-17: Vault V1 reallocation bot](./decisions/TIB-2026-08-17-vault-v1-reallocation-bot.md) — monorepo migration of the MetaMorpho reallocator — accepted
- [TIB-2026-08-23: Quoter-bot monitoring event vocabulary](./decisions/TIB-2026-08-23-quoter-bot-monitoring-events.md) — the structured event names operators query on — proposed
- [TIB-2026-08-25: Quoter-bot bootstrap maturity premium](./decisions/TIB-2026-08-25-quoter-bootstrap-maturity-premium.md) — proposed
- [TIB-2026-08-25: Quoter-bot ladder maturity premium](./decisions/TIB-2026-08-25-quoter-ladder-maturity-premium.md) — proposed
- [TIB-2026-08-25: Quoter-bot npm publishing](./decisions/TIB-2026-08-25-quoter-bot-npm-publishing.md) — `@morpho-org/quoter` on production release — proposed
- [TIB-2026-08-28: Midnight loan-as-collateral](./decisions/TIB-2026-08-28-midnight-loan-as-collateral.md) — off-chain slot choice and the swap-free path — proposed

---

## Retrospectives

_None yet — retros land in [`retros/`](./retros/) at the close of major projects._

---

## External Context

- [morpho-vaults-v2](./context/repos/morpho-vaults-v2.txt) — Morpho Vaults V2 repository context
- [midnight-contracts](./context/repos/midnight-contracts.txt) — Midnight protocol Solidity source
