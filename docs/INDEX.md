# Documentation Index

Quick navigation for the curator-bots documentation.

---

## Guides

- [Coding Conventions](./CONVENTIONS.md) — code style, patterns, best practices
- [Documentation Guidance](./GUIDANCE.md) — when to write a TIB, TIB lifecycle, TIB vs Linear
- [Official Docs Drafts](./official/README.md) — candidate pages for Morpho public documentation

---

## Bots

| Bot                                                       | Description                               | Docs                                                 |
| --------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| [midnight-liquidation](../packages/midnight-liquidation/) | Liquidates eligible Midnight positions    | [README](../packages/midnight-liquidation/README.md) |
| [blue-liquidation](../packages/blue-liquidation/)         | Liquidates eligible Morpho Blue positions | [README](../packages/blue-liquidation/README.md)     |

---

## Packages

| Package                                                   | Description                                            | Docs |
| --------------------------------------------------------- | ------------------------------------------------------ | ---- |
| [@repo/contracts](../packages/contracts/)                 | Shared contract ABIs and Executor sources              | —    |
| [@repo/evm-kit](../packages/evm-kit/)                     | Deployless client, revert decoding, JSON-lines logger  | —    |
| [@repo/home](../packages/home/)                           | `~/.morpho-bots` layout: config, state, locks, sockets | —    |
| [@repo/ipc](../packages/ipc/)                             | Newline-framed Unix-socket JSON server                 | —    |
| [@repo/pipeline](../packages/pipeline/)                   | Op seam, wire records, position IDs, simulation        | —    |
| [@repo/signer-client](../packages/signer-client/)         | Signer client + shared wire protocol                   | —    |
| [@repo/swaps](../packages/swaps/)                         | Multi-venue DEX quoting, routing, and venue selection  | —    |
| [@repo/typescript-config](../packages/typescript-config/) | Shared TypeScript configuration                        | —    |
| [@repo/utils](../packages/utils/)                         | Shared server-safe utilities                           | —    |

---

## Data Flow Diagrams

_None yet — copy [`templates/DATA-FLOW.md`](./templates/DATA-FLOW.md) into a bot or package directory when documenting data flow._

---

## TIBs (Repo-wide)

- [TIB-2026-04-16: Bootstrap Curator Bots](./decisions/TIB-2026-04-16-bootstrap-curator-bots.md) — initial scaffold, tooling stack, and migration plan from `morpho-apps`
- [TIB-2026-07-13: Off-chain bot architecture](./decisions/TIB-2026-07-13-bot-architecture.md) — the one-shot op pipeline, `apps/`+`packages/`+`deploy/` monorepo shape, transparent JSON-Lines wire contract, per-chain queue and policy-signer daemons, config/state model, and log correlation
- [TIB-2026-07-14: Pared-down Slack CI notifications](./decisions/TIB-2026-07-14-slack-ci-notifications.md) — two `github-script` workflows posting basic PR notifications (store-free threading via a PR-body marker) and `release: published` notes to Slack, deliberately trimmed from `prime-monorepo`'s `@repo/ci-scripts` system — implemented
- [TIB-2026-07-14: BetterStack log forwarding via a Vector side-car](./decisions/TIB-2026-07-14-betterstack-log-forwarding.md) — opt-in in-image Vector side-car tails the bots' combined stderr (tee-to-ephemeral-spool, off the critical path) and ships to a per-bot BetterStack HTTP source; key-scrubbed, byte-identical when disabled — repo wiring implemented
- [TIB-2026-07-15: CI/CD deploy pipeline for Railway bots](./decisions/TIB-2026-07-15-ci-deploy-pipeline.md) — deploy-only GitHub Actions (`railway up`, secrets stay on Railway): `push:main` redeploys both bots to staging, `release-{bot}`-labelled merges ship to production + cut a CalVer tag; four scoped GitHub Environments, `push:main` chosen over `pull_request:closed` for the environment branch policy — implemented

## TIBs (Bot-scoped)

- [TIB-2026-06-30: Blue liquidation bot — v0](./decisions/TIB-2026-06-30-blue-liquidation-bot.md) — Morpho Blue ecosystem-backstop liquidator (rindexer discovery, accrual-aware soltag lens, multi-venue swaps, generic Executor, Railway) — implemented
- [TIB-2026-07-09: Midnight market whitelist and venue selection](./decisions/TIB-2026-07-09-midnight-market-and-venue-selection.md) — API-sourced market whitelist + best-of-venues probe selection replacing the hand-maintained routing file; Uniswap dropped as a direct venue — implemented

_Bot-scoped TIBs move under `packages/<bot>/docs/decisions/` once a bot lands; proposal TIBs for
not-yet-built bots sit in `docs/decisions/` alongside their siblings._

---

## Retrospectives

_None yet — retros land in [`retros/`](./retros/) at the close of major projects._

---

## External Context

- [morpho-vaults-v2](./context/repos/morpho-vaults-v2.txt) — Morpho Vaults V2 repository context
- [midnight-contracts](./context/repos/midnight-contracts.txt) — Midnight protocol Solidity source
