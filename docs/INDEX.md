# Documentation Index

Quick navigation for the curator-bots documentation.

---

## Guides

- [Coding Conventions](./CONVENTIONS.md) — code style, patterns, best practices
- [Documentation Guidance](./GUIDANCE.md) — when to write a TIB, TIB lifecycle, TIB vs Linear

---

## Bots

| Bot                                                   | Description                               | Docs                                             |
| ----------------------------------------------------- | ----------------------------------------- | ------------------------------------------------ |
| [midnight-liquidation](../bots/midnight-liquidation/) | Liquidates eligible Midnight positions    | [README](../bots/midnight-liquidation/README.md) |
| [blue-liquidation](../bots/blue-liquidation/)         | Liquidates eligible Morpho Blue positions | [README](../bots/blue-liquidation/README.md)     |

---

## Packages

| Package                                                   | Description                               | Docs |
| --------------------------------------------------------- | ----------------------------------------- | ---- |
| [@repo/contracts](../packages/contracts/)                 | Shared contract ABIs and Executor sources | —    |
| [@repo/typescript-config](../packages/typescript-config/) | Shared TypeScript configuration           | —    |
| [@repo/utils](../packages/utils/)                         | Shared server-safe utilities              | —    |

---

## Data Flow Diagrams

_None yet — copy [`templates/DATA-FLOW.md`](./templates/DATA-FLOW.md) into a bot or package directory when documenting data flow._

---

## TIBs (Repo-wide)

- [TIB-2026-04-16: Bootstrap Curator Bots](./decisions/TIB-2026-04-16-bootstrap-curator-bots.md) — initial scaffold, tooling stack, and migration plan from `morpho-apps`

## TIBs (Bot-scoped)

- [TIB-2026-06-30: Blue liquidation bot — v0](./decisions/TIB-2026-06-30-blue-liquidation-bot.md) — Morpho Blue ecosystem-backstop liquidator (rindexer discovery, accrual-aware soltag lens, multi-venue swaps, generic Executor, Railway) — implemented

_Bot-scoped TIBs move under `bots/<bot>/docs/decisions/` once a bot lands; proposal TIBs for
not-yet-built bots sit in `docs/decisions/` alongside their siblings._

---

## Retrospectives

_None yet — retros land in [`retros/`](./retros/) at the close of major projects._

---

## External Context

- [morpho-vaults-v2](./context/repos/morpho-vaults-v2.txt) — Morpho Vaults V2 repository context
- [midnight-contracts](./context/repos/midnight-contracts.txt) — Midnight protocol Solidity source
