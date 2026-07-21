# Documentation Index

Quick navigation for the morpho-bots documentation.

---

## Guides

- [Coding Conventions](./CONVENTIONS.md) — code style, patterns, best practices
- [Documentation Guidance](./GUIDANCE.md) — when to write a TIB, TIB lifecycle, TIB vs Linear
- [Official Docs Drafts](./official/README.md) — candidate pages for Morpho public documentation

---

## Bots

| Bot                                                   | Description                               | Docs                                             |
| ----------------------------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| [midnight-liquidation](../bots/midnight-liquidation/) | Liquidates eligible Midnight positions    | [README](../bots/midnight-liquidation/README.md) |
| [blue-liquidation](../bots/blue-liquidation/)         | Liquidates eligible Morpho Blue positions | [README](../bots/blue-liquidation/README.md)     |

---

## Packages

| Package                                                   | Description                                                                  | Docs |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- | ---- |
| [@repo/bot-kit](../packages/bot-kit/)                     | Shared bot runtime: clients, logger, watcher/runner, tx queue, state, policy | —    |
| [@repo/contracts](../packages/contracts/)                 | Shared contract ABIs and Executor sources                                    | —    |
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

## TIBs (Bot-scoped)

- [TIB-2026-06-30: Blue liquidation bot — v0](./decisions/TIB-2026-06-30-blue-liquidation-bot.md) — Morpho Blue ecosystem-backstop liquidator (accrual-aware soltag lens, multi-venue swaps, generic Executor, Railway; the TIB's rindexer discovery has since been replaced by Morpho GraphQL API discovery) — implemented
- [TIB-2026-07-09: Midnight market whitelist and venue selection](./decisions/TIB-2026-07-09-midnight-market-and-venue-selection.md) — API-sourced market whitelist + best-of-venues probe selection replacing the hand-maintained routing file; Uniswap dropped as a direct venue — implemented
- [TIB-2026-07-20: Core-API token metadata for monitor-bot](./decisions/TIB-2026-07-20-core-api-token-metadata.md) — resurrects the metadata loader removed in `81481b2` now that `x-api-key` access to `private.api.morpho.org/v0/tokens` is verified live; `KNOWN_TOKENS` demoted to boot seeds, symbol-required storage, raw-units degradation preserved — implemented

_Bot-scoped TIBs move under `packages/<bot>/docs/decisions/` once a bot lands; proposal TIBs for
not-yet-built bots sit in `docs/decisions/` alongside their siblings._

---

## Retrospectives

_None yet — retros land in [`retros/`](./retros/) at the close of major projects._

---

## External Context

- [morpho-vaults-v2](./context/repos/morpho-vaults-v2.txt) — Morpho Vaults V2 repository context
- [midnight-contracts](./context/repos/midnight-contracts.txt) — Midnight protocol Solidity source
