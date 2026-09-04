# TIB-2026-09-03: AGENTS.md as the canonical instruction file

| Field      | Value          |
| ---------- | -------------- |
| **Status** | Accepted       |
| **Date**   | 2026-09-03     |
| **Author** | @haydenshively |
| **Scope**  | Repo-wide      |

---

## Context

`CLAUDE.md` was the real instruction file, with `AGENTS.md` and `.cursorrules` symlinked to it. It
had grown to 301 lines / 2,259 words — roughly 3k tokens billed on every request, in every session,
forever. Its history explains why: nearly every feature PR appended a paragraph (`c7636cdc` a helm
chart, `b245d014` an operator surface, `ffc0ff8e` quoter-signer, `91ff501b` policy checks). It had
become a changelog of the repo rather than an instruction set for working in it.

Two sections alone — Architecture Overview (60 lines) and Linear Integration (76 lines) — were 45%
of the file and were near-entirely enumerable fact, already carried by `README.md`, `docs/INDEX.md`,
and `.husky/commit-msg`. Enumerable fact is also the part that rots: the file claimed every bot runs
`node dist/src/index.js` (false for quoter-bot and quoter-signer), described `bots/kill-switch` as a
proposal bot (its TIB has said **Withdrawn** since 2026-06-29), and carried scope tables with no row
for `kill-switch` or `services/`.

[TIB-2026-04-16](./TIB-2026-04-16-bootstrap-curator-bots.md) recorded the opposite intent —
"`CLAUDE.md` meta-rules preserved … intact" — so reversing it needs a record.

## Goals / Non-Goals

**Goals**

- One canonical instruction file, named for the cross-harness standard rather than one vendor.
- Cut it to what an otherwise-competent agent would get wrong unprompted.
- Give every evicted rule exactly one home, and make the pointers to those homes true.
- Record admission criteria, so the file does not re-accrete.

**Non-Goals**

- Changing any coding convention. Rules moved; none were softened except where the tree proved
  them overstated (see Arrow Constants below).
- Replacing `docs/CONVENTIONS.md` as the source of truth for code style.
- Automating enforcement of the rules that remain prose.

## Proposed Solution

`AGENTS.md` becomes the real file; `CLAUDE.md` and `.cursorrules` become symlinks to it. It is ~90
lines under seven headings: orientation, **Never**, **Funds at risk**, **Working**, **Done**,
**Traps**, and an **Elsewhere** routing table.

The organizing idea: **AGENTS.md is a prompt prefix, not documentation.** A doc costs tokens when
it is read; this file costs tokens on every turn. So the bar for inline content is high, and four
tests decide admission:

1. Would a competent agent get this wrong without being told? If no, cut it.
2. Is it already enforced by a hook, a lint rule, a CI job, or the type system? If yes, the tool is
   the enforcement — do not restate it.
3. Is it discoverable by reading the code or config in about a minute? If yes, the code is the
   answer.
4. Is it a fact or a behavior? Facts rot and belong in the doc that owns them. Behaviors and
   judgment calls belong here. Prefer the rule that _generates_ a fact over the enumeration
   (`scope = directory name`, not a twenty-row table).

A fifth, learned from the section this replaces: **one home, linked from everywhere else.** The old
"mirror discipline" rule institutionalized the duplication that caused the drift. The symlinks are
the mechanism; the rule is gone.

### What was evicted and where it went

| Evicted                                                                                                                                        | New home                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Architecture Overview, tech-stack versions                                                                                                     | `README.md`, `docs/INDEX.md`, `package.json`, `.nvmrc`           |
| Reverted-architecture narrative                                                                                                                | [TIB-2026-07-16](./TIB-2026-07-16-revert-to-bots-as-programs.md) |
| Utility isolation, arrow utilities, typed error isolation, SDK-first                                                                           | `docs/CONVENTIONS.md`                                            |
| Linear team IDs                                                                                                                                | `docs/GUIDANCE.md`                                               |
| Commit scope tables                                                                                                                            | `.husky/commit-msg` plus a one-line generating rule              |
| Anti-rationalization table, agent role list, mirror discipline, workflow mirroring, JSDoc-on-every-export, the `.claude/skills` symlink clause | Deleted                                                          |

Two rules were deliberately **removed**, not moved: the plan-review gate (nothing else triggers it,
so this is a behavior change) and the "temporarily break one assertion" ritual (a focused test that
fails when the implementation breaks is the evidence; corrupting a passing test is theater).

The Bun prohibition was dropped entirely. A rule that no tooling enforces, about a migration that
completed in [TIB-2026-07-20](./TIB-2026-07-20-migrate-to-pnpm.md), is exactly the kind of content
this change exists to remove.

### What was added

Nothing in the old file said this code signs transactions and moves real funds. That is now the
first paragraph, and **Funds at risk** names the trigger conditions explicitly. **Traps** collects
hazards that are non-discoverable from the code and were previously carried only in operators'
heads — worktree placement vs. knip, `gh stack` restacking, log field names as a dashboard
interface, soltag's silent empty-ABI degradation, the `COPY services/` requirement in bot
Dockerfiles, and production not necessarily running `main`. Per
[`docs/MISSION.md`](../MISSION.md) principle 3, load-bearing knowledge belongs in the repo.

## Considered Alternatives

### Keep `CLAUDE.md` canonical and restore the `AGENTS.md` symlink

Smallest diff. **Why rejected:** every non-Claude harness in use here — Codex, Cursor — reads a file
named for one vendor. `AGENTS.md` is the cross-harness convention.

### Reorganize without cutting (~200 lines)

Deduplicate and regroup, keep most content. **Why rejected:** it treats length as a formatting
problem. The cost is per-turn and the rot is in the enumerable content, so only deletion helps.
It also preserves the flattened severity that is the file's real failure — at 301 lines "never push
to `main`" reads in the same register as "declare utilities as arrow constants".

### Move the agent-workflow rules to a new `docs/AGENT-WORKFLOW.md`

**Why rejected:** a fourth agent-facing doc to keep in sync. The rules worth keeping fit inline; the
rest were not worth relocating.

## Assumptions & Constraints

- Harnesses resolve symlinked instruction files. Verified for Claude Code, Codex, and Cursor.
- `.lintstagedrc.mjs` runs `oxfmt` over `*.md`, so `CLAUDE.md` matches a glob while being a symlink.
  If oxfmt ever writes through it rather than following it, the symlink silently reverts to a
  regular file and the inversion un-does itself. `readlink CLAUDE.md` must be checked **after** a
  commit that touches it, not only before.
- Arrow Constants moved to `docs/CONVENTIONS.md` as a _preference_, not a mandate: the tree has ~145
  exported `function` declarations across 76 files, and they are ordinary single-signature
  utilities, not overloads. Stating it as absolute would write ~140 known violations into an
  authoritative doc.

## Security

`main` requires signed commits server-side (`required_signatures: enabled=true`) and nothing caught
that locally, so an agent "fixing" a gpg failure with `--no-gpg-sign` only discovered the problem at
merge. **Never** now forbids `--no-verify`, `--no-gpg-sign`, and `-c commit.gpgsign=false`
explicitly. A new `.husky/pre-push` refuses pushes to `main`, which was previously prose-only.

## Future Considerations

- **Admission criteria.** Anything proposed for `AGENTS.md` must pass all four tests above. A rule
  that a hook, lint rule, or CI job could enforce should become that instead — prefer changing the
  tooling over adding a line here. If the file passes ~110 lines, something was admitted that
  should not have been; re-run the tests rather than reformatting.
- Several remaining rules are still prose with no mechanism (no bot imports another bot; utility
  isolation; typed error isolation). Each is a candidate for a custom lint rule, which would let it
  leave the prose entirely.

## References

- [TIB-2026-04-16: Bootstrap curator bots](./TIB-2026-04-16-bootstrap-curator-bots.md) — superseded
  on the narrow point that `CLAUDE.md` is canonical and its meta-rules are preserved intact
- [TIB-2026-07-20: Migrate to pnpm](./TIB-2026-07-20-migrate-to-pnpm.md)
- [`docs/MISSION.md`](../MISSION.md) — principle 3, "context is a first-class artifact"
