# Decisions (TIBs)

Technical Intent Briefs (TIBs) — durable records of repo-wide architectural decisions for
`curator-bots`. One file per decision.

## Adding a TIB

1. Copy [`../templates/TIB.md`](../templates/TIB.md) to `TIB-YYYY-MM-DD-<short-slug>.md` (CalVer
   based on draft date).
2. Fill in the header, Context, Goals, Proposed Solution, and Considered Alternatives sections.
3. Open a PR with **Status: Proposed**.

See [`../GUIDANCE.md`](../GUIDANCE.md) for the full TIB lifecycle, when to write one, and how TIBs
relate to Linear specs.

## Naming

- **Repo-wide:** `TIB-YYYY-MM-DD-<short-slug>.md`
- **Bot- or package-scoped:** keep colocated under `bots/<bot>/docs/decisions/` or
  `packages/<pkg>/docs/decisions/` — repo-wide TIBs only live here.
