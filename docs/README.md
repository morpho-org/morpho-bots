# Docs

This directory holds architectural decision records (TIBs), retrospectives, and templates for
`morpho-bots`.

## Layout

- [`INDEX.md`](./INDEX.md) — discovery index linking guides, bots, packages, TIBs, and external
  context.
- [`GUIDANCE.md`](./GUIDANCE.md) — when to write a TIB, the TIB lifecycle, and how TIBs relate to
  Linear specs and RFCs.
- [`templates/TIB.md`](./templates/TIB.md) — canonical TIB template. Copy to
  `decisions/TIB-YYYY-MM-DD-short-slug.md` and fill in.
- [`templates/DATA-FLOW.md`](./templates/DATA-FLOW.md) — template for per-bot or per-package data
  flow documentation. Copy next to the module it describes.
- [`official/`](./official/) — candidate pages for Morpho public documentation.
- [`decisions/`](./decisions/) — accepted and proposed TIBs, one file per decision.
- `retros/` _(added on first retro)_ — retrospectives on completed work, one file per retro.

## Adding a TIB

1. Copy `templates/TIB.md` to `decisions/TIB-YYYY-MM-DD-<slug>.md` (CalVer based on draft date).
2. Fill in the header table and the Context / Goals / Proposed Solution / Alternatives sections.
3. Open a PR with Status: `Proposed`. See [`GUIDANCE.md`](./GUIDANCE.md) for the full lifecycle.
