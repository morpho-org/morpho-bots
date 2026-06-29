# TIB-2026-04-16: Bootstrap `curator-bots` repo from `morpho-apps` foundations

| Field      | Value                               |
| ---------- | ----------------------------------- |
| **Status** | Proposed                            |
| **Date**   | 2026-04-16                          |
| **Author** | @cashd                              |
| **Scope**  | Repo-wide (morpho-org/curator-bots) |

---

## Context

Morpho curator operations need off-chain bots — reallocators, liquidation monitors, a Kill Switch Bot — and those do not belong inside `morpho-apps`, which is a NextJS front-end monorepo. `curator-bots` exists to give bots their own home with their own deploy surface, dependency graph, and CI. At the same time, `morpho-apps` has matured conventions worth inheriting wholesale: agent definitions, the TIB workflow, `CONVENTIONS.md`, the ox lint/format stack, and two packages — `@repo/utils` and `@repo/abis` — every bot needs on day one. This TIB ports that slice; everything NextJS, UI, observability, or web3-specific stays behind.

## Goals / Non-Goals

**Goals**

- Give a contributor coming from `morpho-apps` the same dev experience here: same commit conventions, same self-verification ritual, same TIB workflow, same lint and format commands.
- Adopt the ox stack and bun workspaces as the full tooling posture.
- Ship `@repo/utils` and `@repo/abis` ready for the first bot to consume, with `@repo/utils` trimmed to server-safe code.
- Seed a `docs/` scaffold — conventions, guidance, empty decisions and retros folders, TIB and data-flow templates — so the team writes its own records from day one.
- Land a small CI pipeline that runs lint, typecheck, unit tests, and dead-code detection on every PR, backed by pre-commit and commit-msg hooks.
- Keep the `@repo/*` package namespace so code copied from `morpho-apps` compiles without import rewrites.

**Success signal.** CI is green on the first post-migration PR across all four jobs (Lint, Typecheck, Unit-Test, Dead-Code); `bun run lint` emits 0 warnings; `@repo/abis` builds cleanly; opening Claude Code surfaces `CLAUDE.md` Strict Rules and Agent Team config identical to `morpho-apps`. Smoke task: asked to add a trivial utility to `@repo/utils`, Claude colocates types, uses `tryCatch`, writes a `bun test` spec, and commits with `feat(utils): ...` format — without being prompted on conventions.

**Non-Goals**

- Nothing NextJS-specific. No apps, UI packages, wagmi, Tailwind, Sentry browser, GraphQL codegen, or Playwright/anvil E2E.
- Nothing platform-level yet. Observability, resolvers, indexer, and per-bot deploy surfaces land in their own TIBs when the first bot needs them.
- No existing `morpho-apps` TIBs, retros, or context docs — `curator-bots` authors its own.
- Not choosing the first bot in this TIB. Scaffolding stops at an empty `bots/` directory.

## Current Solution

`curator-bots` was created on 2026-04-16 from `npm create turbo@latest` and currently carries that default scaffold. Concretely, the repo on `main` has:

- `apps/docs/` and `apps/web/` — both Next.js 16.2.0 apps with React 19, directly conflicting with the "Nothing NextJS-specific" non-goal.
- `packages/ui/`, `packages/eslint-config/`, `packages/typescript-config/` — turbo defaults with eslint 9 and the `@repo/*` names already claimed by stock implementations this migration will replace.
- Root `package.json` with `"name": "morpho-bots"`, `"engines.node": ">=18"`, `"packageManager": "bun@1.3.12"`, workspace globs `apps/*`, `packages/*`, devDeps `prettier` / `turbo` / `typescript`, and scripts all routed through `turbo run ...`.
- `turbo.json` with the default `build / dev / lint / check-types` pipeline.
- `CODEOWNERS` assigns `@cashd` to all paths; branch protection requires code-owner approval on `main`.

**Branch context.** Baseline is `main @ ef8a96d`. The `docs/bootstrap-tib-scaffold` branch on top of that adds `docs/GUIDANCE.md`, `docs/templates/TIB.md`, `docs/templates/DATA-FLOW.md`, `docs/README.md`, and this TIB — all pure additions, none of which affect the migration plan below.

Doing nothing means new bots land in a repo with Next.js scaffolding, no conventions, no agent guidance, and no shared utilities. Every contributor reinvents formatting, error handling, and env validation. Claude gets no `CLAUDE.md` to align behavior.

## Proposed Solution

Port a **curated foundation slice** of `morpho-apps` into `curator-bots` across seven ordered phases. The slice is: ox-stack tooling, agent infra, pruned conventions + TIB scaffold, two code packages trimmed to bot needs, two new config packages, and lean CI.

### Tech stack

`curator-bots` diverges from `morpho-apps` on runtime and JS tooling. `morpho-apps` is NextJS-centric on pnpm, ESLint, Prettier, and turbo; `curator-bots` runs the ox stack on bun workspaces. The table below is the source of truth for versions.

| Decision           | curator-bots                     | morpho-apps          | Why                                                                                                                                                                                                                                              |
| ------------------ | -------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Package manager    | bun 1.3.12                       | pnpm 10.32.1         | Target is already bun; ox/bun direction for the new repo                                                                                                                                                                                         |
| Node version       | 24.14.1                          | 24.14.1              | Matches source's `.nvmrc`; required by some morpho deps                                                                                                                                                                                          |
| Linter             | oxlint                           | ESLint (flat config) | Rust-based; faster and clearer diagnostics                                                                                                                                                                                                       |
| Formatter          | oxfmt 0.35+                      | Prettier             | ox stack; fast, zero-config                                                                                                                                                                                                                      |
| TypeScript         | 6.0                              | 6.0                  | Already upgraded repo-wide (commit `6a56d0a`); keep in step with source                                                                                                                                                                          |
| Dead-code detector | knip 5                           | knip 5               | Matches source; invoked directly as `bun run knip` (no turbo task graph needed)                                                                                                                                                                  |
| Task runner        | bun workspace scripts            | turbo 2.x            | Divergence. Turbo's pipeline graph + remote cache payoff is invisible at 2-package scale; `bun run --filter '*' <task>` covers our needs with zero extra tooling and no `TURBO_TOKEN` provisioning. Revisit if workspace count or CI time grows. |
| Version pinning    | bun catalog                      | pnpm catalog         | Bun 1.2+ supports the catalog pattern; mirrors source's `pnpm-workspace.yaml` catalog                                                                                                                                                            |
| Package namespace  | `@repo/*`                        | `@repo/*`            | Max copy-paste compatibility from source                                                                                                                                                                                                         |
| Test runner        | `bun test` (built-in)            | vitest 4.x           | Divergence. Bun ships a vitest-compatible runner; using it drops a dev-dep and keeps the runtime, package manager, and test runner on one tool.                                                                                                  |
| Pre-commit         | husky + lint-staged + commit-msg | husky + lint-staged  | oxlint/oxfmt on staged files; enforce `type(scope): description` 72-char commits                                                                                                                                                                 |

### Source → target mapping

Contributors and agents coming from `morpho-apps` should recognise every workflow discipline below: commit format, self-verification ritual, TIB process, `CONVENTIONS.md` ethos, `@repo/*` namespace, agent role definitions, and the Linear + Context7 MCP servers. Each source component lands in one of four buckets:

| `morpho-apps` component                                                               | Disposition                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE.md`                                                                           | Port adapted (pnpm→bun commands, UI examples removed; Strict Rules / Agent Team / self-verification unchanged)                                                                                                               |
| `.mcp.json`                                                                           | Port adapted (Linear + Context7 kept; Playwright dropped)                                                                                                                                                                    |
| `.cursor/`, `.vscode/`, `.zed/`                                                       | Port verbatim (agent + editor settings)                                                                                                                                                                                      |
| `docs/GUIDANCE.md`, `docs/templates/*`                                                | Port verbatim                                                                                                                                                                                                                |
| `docs/CONVENTIONS.md`                                                                 | Port pruned (React Error Boundaries, Toast patterns, Sentry, `captureError`, `getClientEnvVar`/`getServerEnvVar`/`getEnvVar`, Next.js env inlining, and the env-access section all removed — bots read `Bun.env.*` directly) |
| `packages/utils/`                                                                     | Port adapted (server-safe subset; `client.ts` dropped)                                                                                                                                                                       |
| `packages/abis/`                                                                      | Port verbatim                                                                                                                                                                                                                |
| `packages/typescript-config/`                                                         | Port adapted (`./base` + `./module` only)                                                                                                                                                                                    |
| `packages/eslint-config/`                                                             | Rewrite as `@repo/oxlint-config` (spirit, not literal)                                                                                                                                                                       |
| `.github/actions/setup/action.yml`                                                    | Port adapted (bun replaces pnpm)                                                                                                                                                                                             |
| `.github/workflows/checks.yml`                                                        | Port adapted (TURBO env + NEXT_PUBLIC env dropped)                                                                                                                                                                           |
| `.github/workflows/_cache-setup.yml`                                                  | Skip (no turbo, no remote cache)                                                                                                                                                                                             |
| `.husky/*`, `.lintstagedrc.mjs`, `knip.json`                                          | Port adapted for bun + oxlint + oxfmt                                                                                                                                                                                        |
| `turbo.json`                                                                          | Skip (no turbo)                                                                                                                                                                                                              |
| Agent prompts for GraphQL codegen, Playwright E2E, anvil forks                        | Skip (no surface in a bot repo)                                                                                                                                                                                              |
| All Next.js apps, UI / web3 / observability / resolvers / indexer                     | Skip (non-goal)                                                                                                                                                                                                              |
| Existing TIBs, retros, `docs/CI-CD.md`, `docs/adding-a-new-chain.md`, `docs/context/` | Skip (new repo authors its own content)                                                                                                                                                                                      |

### Target directory structure

```
curator-bots/
├── .cursor/worktrees.json
├── .github/
│   ├── actions/setup/action.yml      # bun + Node, rewritten from source
│   ├── workflows/
│   │   └── checks.yml                # lint + typecheck + test:unit + knip
│   └── CODEOWNERS                    # existing
├── .husky/{pre-commit,commit-msg,pre-push}
├── .vscode/settings.json
├── .zed/settings.json
├── .lintstagedrc.mjs
├── .mcp.json                         # linear + context7 only
├── .nvmrc                            # 24.14.1
├── .oxfmtrc.json
├── .oxlintrc.json
├── AGENTS.md -> CLAUDE.md            # symlink
├── CLAUDE.md                         # adapted: pnpm→bun, UI refs removed
├── README.md
├── bun.lock                          # regenerated
├── knip.json
├── package.json                      # workspaces + catalog
├── tsconfig.json
├── docs/
│   ├── README.md, INDEX.md           # nav placeholders
│   ├── CONVENTIONS.md                # pruned for bots
│   ├── GUIDANCE.md                   # TIB workflow (ported)
│   ├── decisions/README.md           # "drop TIBs here"
│   ├── retros/README.md              # "drop retros here"
│   └── templates/{TIB.md,DATA-FLOW.md}   # ported verbatim
├── packages/
│   ├── utils/                        # server-safe subset
│   ├── abis/                         # full
│   ├── typescript-config/            # module + base only
│   └── oxlint-config/                # new; replaces @repo/eslint-config
└── bots/                             # empty until first bot (Kill Switch Bot)
```

### Implementation Phases

Rollout: each phase below is tracked as its own Linear ticket the implementing agent picks up, and ships as an independent PR in dependency order. Effort sizing: S (≤1d), M (1–3d), L (3–5d).

**Phase 1 — Tooling foundation**

- **Deliverables:** delete the stock turbo scaffold — `apps/docs/`, `apps/web/`, `packages/ui/`, `turbo.json`, and the `turbo` + `prettier` devDeps; delete the stock `packages/eslint-config/` directory ahead of Phase 4 shipping `@repo/oxlint-config` in its place; rewrite `packages/typescript-config/` contents; rename root `package.json` from `morpho-bots` to its final name and bump `engines.node` from `>=18` to `24.14.1`; add `.nvmrc` pinned to `24.14.1`; rewrite workspace globs `apps/*` → `bots/*`; swap root scripts to `bun run --filter '*' <task>`; author the root `package.json` catalog, a shared `tsconfig.json`, `.oxlintrc.json`, `.oxfmtrc.json`, and `knip.json`.
- **Effort:** S.
- **Blocks:** Phases 2, 3, 4, 5, 6.

**Phase 2 — Agent & editor infrastructure**

- **Deliverables:** port `CLAUDE.md` with Strict Rules / Agent Team / self-verification intact and commands rewritten for bun; symlink `AGENTS.md` → `CLAUDE.md`; port `.cursor/`, `.vscode/`, `.zed/` verbatim; write `.mcp.json` with Linear + Context7 and drop Playwright.
- **Effort:** S.
- **Blocks:** none (parallel with Phase 3).

**Phase 3 — Conventions & docs scaffold**

- **Deliverables:** port `CONVENTIONS.md` with React, Sentry, client/server env-split content, and the env-access section all stripped (bots read `Bun.env.*` directly — no helper, no runtime schema); port `GUIDANCE.md` and the two templates verbatim; create placeholder READMEs in `docs/`, `docs/decisions/`, and `docs/retros/`, plus `docs/INDEX.md`. Do not port existing TIBs, retros, or `morpho-apps` context docs.
- **Effort:** M.
- **Blocks:** none (parallel with Phase 2). Docs scaffolding has already landed on the `docs/bootstrap-tib-scaffold` branch; Phase 3 finalises the remaining placeholders against the main migration commit.

**Phase 4 — Tooling packages `@repo/typescript-config` and `@repo/oxlint-config`**

- **Deliverables:** ship a trimmed `@repo/typescript-config` exporting just `./base` and `./module` with strict TS settings (`noImplicitReturns`, `noUncheckedIndexedAccess`); author `@repo/oxlint-config` in the spirit of `morpho-apps`'s ESLint config — recommended JS + typescript-eslint rules, `no-console` off, error-on-warning — adopting `no-floating-promises`, `no-misused-promises`, and `switch-exhaustiveness-check` where oxlint supports them and backstopping gaps with strict TS flags (gap list in §Assumptions & Constraints).
- **Effort:** S.
- **Blocks:** Phase 5 (code packages consume these configs), Phase 6.

**Phase 5 — Code packages `@repo/utils` and `@repo/abis`**

- **Deliverables:** port `@repo/utils` as a server-safe subset — drop `client.ts` and any helper that touches `window`, `document`, `localStorage`, `js-cookie`, or `jsdom`; port `@repo/abis` verbatim; wire both to the tooling configs shipped in Phase 4 with standard ox-stack scripts and their own knip entries.
- **Gate:** before finalising the utils trim, read the source to confirm every `@repo/abis` import from `@repo/utils` lands in the server-safe subset.
- **Effort:** M–L.
- **Blocks:** Phase 7.

**Phase 6 — CI workflows and git hooks**

- **Deliverables:** port the setup action for bun and `checks.yml` (four jobs: Lint, Typecheck, Unit-Test, Dead-Code), dropping all NextJS, REOWN, BLUE_SERVICES, and turbo env; skip `_cache-setup.yml`; install husky with a `pre-commit` hook running lint-staged and a `commit-msg` hook enforcing the conventional format; rely on the built-in GitHub Actions cache for installs.
- **Effort:** S.
- **Blocks:** Phase 7.

**Phase 7 — Validation sweep and cut-over**

- **Deliverables:** scaffold `bots/test-bot` with a minimal `package.json` + `src/index.ts` running `while (true) { console.log(Date.now()); await Bun.sleep(1000); }` as a CI canary until the Kill Switch Bot lands; from a clean checkout, run install, lint, format check, typecheck, unit tests, knip, and the `@repo/abis` build — all green; open a PR and confirm all four CI jobs pass and CODEOWNERS enforces review; update `README.md` to point at `CLAUDE.md`, `CONVENTIONS.md`, and `GUIDANCE.md`; smoke-test the agent surface against the Success signal in §Goals.
- **Effort:** S.
- **Blocks:** merge.

## Considered Alternatives

### Alternative 1: Keep source's pnpm + ESLint stack

Replicate `morpho-apps` exactly — pnpm 10.32.1, ESLint flat config, eslint-config package — so diffs are trivial.

**Why rejected:** The ox stack is Rust-based and measurably faster than ESLint + Prettier on comparable projects, with clearer diagnostics — worth it for a small repo where lint runs on every keystroke through lint-staged. Bun also consolidates three roles — package manager, runtime, and workspace task runner — that pnpm + Node + turbo split across three tools, cutting the dep count and eliminating the `TURBO_TOKEN`/`TURBO_TEAM` provisioning tax. The tradeoff is a narrower oxlint rule catalog (gaps in §Assumptions & Constraints) and a younger bun ecosystem; both are acceptable for a bot repo with no React, wagmi, or a11y surfaces to pressure-test rule edges.

### Alternative 2: Full-monorepo mirror minus brand/data/storybook

Port everything except the three obviously-marketing apps — so curator-app, curator-v2-app, liquidation-app, delegate-app, markets-v2-app, fallback-rpc, plus all UI packages.

**Why rejected:** The new repo's purpose is bots, not UIs. A full mirror would drag in Next.js, wagmi, Tailwind, Sentry, and the entire GraphQL/oRPC layer — massive surface area for code the repo will never run. The user explicitly scoped to "workflows + conventions + agent tools + utils + abis + docs scaffold."

### Alternative 3: Port `CONVENTIONS.md` verbatim

Copy the file as-is and let contributors prune during normal edits.

**Why rejected:** References to `@repo/observability`, `lib/observability/errors`, React Error Boundaries, Toasts, `getClientEnvVar`/`getServerEnvVar`, and Next.js env inlining are actively misleading in a bot repo. They'd send Claude down wrong paths (e.g., "Use `captureError`" when no such function exists). Prune-up-front costs ~30 min and prevents months of drift.

### Alternative 4: Keep turbo 2.x as the task runner

Bring over `turbo.json` (trimmed from source's 14 tasks to ~10), wire root `package.json` scripts through `turbo run <task>`, port `_cache-setup.yml`, and rely on `TURBO_TOKEN`/`TURBO_TEAM` for Vercel-hosted remote caching — matching `morpho-apps` task orchestration 1:1.

**Why rejected:** At two packages and an empty `bots/`, turbo's pipeline graph and remote cache buy almost nothing — the value kicks in with many workspaces, long-running builds, and high CI volume, none of which describe this repo today. Bun's `bun run --filter '*' <task>` already runs scripts across workspaces natively and needs zero provisioning (no Vercel team, no tokens, no extra workflow). Dropping turbo removes a class of external-state dependencies and keeps the root shape honest — root scripts mean what they say. Turbo is a mechanical add-back later (a `turbo.json` + one dev dep) if workspace count grows or CI parallelism becomes painful; tracked under Future Considerations. This is a **deliberate divergence from `morpho-apps`** and is captured in §Proposed Solution → Tech stack.

## Assumptions & Constraints

- **Bun catalog parity.** Bun 1.3.12's workspace catalog resolves the same versions that pnpm's catalog did for the transitive deps we care about (viem, typescript, etc.). If bun and pnpm resolve different transitive versions for a given package, per-workspace pin is the fallback. Phase 5 end validates by running `bun install` against real `package.json`s.
- **oxlint rule catalog sufficiency.** oxlint's rule catalog (smaller than ESLint's) is sufficient for bot code. Verified known gaps against `morpho-apps/packages/eslint-config/base.js`: `perfectionist/*` import-sort rules (use oxlint's `import/order`); `turbo/no-undeclared-env-vars` (N/A — no turbo); `no-restricted-imports` wagmi/React patterns (N/A in a bot repo). Rules wanted for bot correctness — `no-floating-promises`, `no-misused-promises`, `switch-exhaustiveness-check` — adopted where oxlint supports, otherwise backstopped by TS strict flags (`noImplicitReturns`, `noUncheckedIndexedAccess`). If a gap becomes painful in real code, follow-up TIB.
- **`@repo/abis` → `@repo/utils` import surface stays server-safe.** `@repo/abis`'s dependency on `@repo/utils` only reaches utilities that survive the server-safe trim. Phase 5 includes an explicit pre-trim gate to verify this from source.
- **`CLAUDE.md` meta-rules preserved.** `CLAUDE.md` edits keep all meta-rules (self-verification, anti-rationalization, completion status) intact. The only edits are command rewrites (pnpm→bun) and deletion of UI-specific examples.
- **Solo code-owner.** The user is the sole code owner on `main` per CODEOWNERS + branch protection configured 2026-04-16. Any PR in this migration is self-reviewed under current branch protection until a second approver joins.

## Dependencies

- **Source snapshot:** `morpho-apps` as of 2026-04-16 (local path: `/Users/cashd/workspace/morpho/prime-monorepo-0/` — the folder retains the pre-rename name on disk). If source files change materially during this migration, re-read before porting.
- **Runtime:** bun 1.3.12 (repo-pinned), Node 24.14.1 (via `.nvmrc`).
- **Core tooling** (dev deps): oxlint (latest), oxfmt 0.35+, knip 5.x, husky 9+, lint-staged 15+, typescript 6.0.2. No turbo, no separate test runner — tests use bun's built-in `bun test`.
- **Catalog versions** (runtime): viem (matching source's 2.47.x), `@morpho-org/morpho-ts@2.5.0`, date-fns, lodash-es, `@internationalized/date`.
- **CI:** GitHub Actions with `depot-ubuntu-latest` runners (fall back to `ubuntu-latest` if depot isn't provisioned).
- **MCP servers** in `.mcp.json`: Linear (`mcp.linear.app/sse`), Context7 (`mcp.context7.com/mcp`).

## Security

- Pre-commit + commit-msg hooks enforce the Strict Rule of never committing ENV keys; lint-staged can also run a secret-scanner as a follow-up.
- CODEOWNERS + main branch protection require code-owner approval before merge. Force-push + deletion disabled.
- **Repo is private under `morpho-org` today; plan is to flip to public once the first bot (Kill Switch Bot) ships.** Access control inherits org-level team permissions while private. Before the flip, a separate TIB will cover the cut-over: git-history audit for secrets / curator addresses / internal ops detail, licensing, and any redaction needed for committed configs.
- No secrets are encoded in committed workflow files; this migration introduces none — dropping turbo removed the need for `TURBO_TOKEN`/`TURBO_TEAM`.
- `CLAUDE.md` Strict Rules (never commit to main, never add ENV keys) are mirrored into Cursor/Zed/MCP agent contexts, so AI edits inherit the same guardrails.

## Future Considerations

- **First bot (Kill Switch Bot).** A separate TIB will address the first concrete bot — a one-shot curator circuit breaker — bringing its own deps (probably `@repo/web3` lite or a direct viem client, observability wiring, a job runner) and possibly extending `@repo/utils` with bot-specific helpers.
- **Public cut-over.** Once the first bot (Kill Switch Bot) ships, flip this repo to public under `morpho-org`. A separate TIB will cover the pre-flip git-history audit, licensing, and any redaction needed for committed configs. Individual bots publish as versioned npm packages and container images from the same repo — no extract-to-separate-public-repo step.
- **Per-bot platform packages.** If and when bots need observability, chain clients, or resolver-style aggregation, port them lazily — one package per TIB — with server-only trimming, not a wholesale pull from source.
- **oxlint rule gaps.** As gaps surface in real code (e.g., a rule source relied on that oxlint lacks), record each in a follow-up TIB and decide: strict-TS backstop, oxlint custom rule, or explicit acceptance.
- **Agent drift from `morpho-apps`.** The Source → target mapping is the contract between the two repos. Plan a quarterly cross-repo review; write a TIB when divergence is intentional.
- **Revisit turbo.** If workspace count grows past ~5 or CI job time gets painful, reconsider turbo as the task runner. Adding it back is a `turbo.json` + one dev dep.
- **Commit-msg validator.** The Phase 6 bash regex is lightweight but brittle. Revisit `@commitlint/cli` + `@commitlint/config-conventional` in ~6 months if the regex hits edge cases.
- **Repo + folder rename.** The GitHub repo is `curator-bots`; the local working directory `/Users/cashd/workspace/morpho/morpho-bots/` renames to `curator-bots` at author convenience. The `morpho-apps` source repo also still sits under `prime-monorepo-0/` on disk — renaming that folder is author-convenience too.
- **Linear + PR automation.** Source has PR label / Slack / team-label workflows not ported here. Worth porting once team collaborators exist; premature for a solo-owner repo.

## References

- **Target repo:** https://github.com/morpho-org/curator-bots (private today; going public after the first bot ships)
- **Source repo:** `morpho-apps` — local snapshot at `/Users/cashd/workspace/morpho/prime-monorepo-0/` (on-disk folder retains the pre-rename name).
- **Source files authoritative for the migration:**
  - `morpho-apps/CLAUDE.md`
  - `morpho-apps/.mcp.json`
  - `morpho-apps/.cursor/worktrees.json`
  - `morpho-apps/.vscode/settings.json`
  - `morpho-apps/.zed/settings.json`
  - `morpho-apps/knip.json`
  - `morpho-apps/.oxfmtrc.json`
  - `morpho-apps/.lintstagedrc.mjs`
  - `morpho-apps/.husky/pre-commit`
  - `morpho-apps/.github/actions/setup/action.yml`
  - `morpho-apps/.github/workflows/checks.yml`
  - `morpho-apps/docs/CONVENTIONS.md`
  - `morpho-apps/docs/GUIDANCE.md`
  - `morpho-apps/docs/templates/TIB.md`
  - `morpho-apps/docs/templates/DATA-FLOW.md`
  - `morpho-apps/packages/utils/` (tree)
  - `morpho-apps/packages/abis/` (tree)
  - `morpho-apps/packages/typescript-config/` (shape reference)
  - `morpho-apps/packages/eslint-config/base.js` (spirit reference for Phase 4 oxlint rewrite; gap list in §Assumptions & Constraints)

## Addenda

### 2026-04-28 — Phase 5 execution refinements (CRTR-2283)

The core Phase 5 decision (port `@repo/utils` server-safe + `@repo/abis` verbatim) stands. The
following execution-time refinements were applied during the port and are recorded here so
future readers don't mistake the as-built state for drift:

- **`@repo/oxlint-config` inlined into root `.oxlintrc.json` and the package was deleted.** The
  shipped package had exactly one consumer (the root config, via a relative path — never via
  the `@repo/` package name), unlike `@repo/typescript-config` which is referenced by
  per-package `tsconfig.json` extends. Phase 4's package wrapper bought no ergonomics in
  practice. If a future bot needs per-package lint overrides, extract a shared config back into
  a package then.
- **Per-package `lint`/`lint:fix` scripts dropped in favor of root-only `bun lint`.** oxlint's
  `options.typeAware` is gated to "the root config" — when run from a sub-package cwd, oxlint
  treats the parent `.oxlintrc.json` as a non-root extended config and rejects `typeAware`.
  The workaround (passing `--config ../../.oxlintrc.json`) leaks workspace structure. Lint is
  now exclusively a workspace-level concern; CLAUDE.md's validation suite was updated to point
  at `bun lint` (root) instead of `bun run --filter <pkg> lint`.
- **Five oxlint rules turned off** in the merged root config to keep the port close-to-verbatim:
  `typescript/no-unsafe-type-assertion`, `typescript/await-thenable`,
  `typescript/no-unnecessary-type-parameters`, `unicorn/consistent-function-scoping`, and
  `eslint/no-shadow`. `await-thenable` was a flat false positive on `bun:test`'s
  `.rejects.toThrow()` chain; the others were noisy on pre-existing `as`-cast and
  inner-function patterns we didn't want to rewrite during a verbatim port. Per-rule re-enable
  is a follow-up once bots stabilise.
- **`@repo/utils` shipped without `cdn.ts` and `env.ts`** in addition to the storage subsystem
  the TIB called out. `cdn.ts` builds CDN image URLs (frontend-only). `env.ts` wraps env-var
  reading with override hooks designed for Next.js client-side / cookie-driven E2E flows;
  bots read `Bun.env` directly per CONVENTIONS, so the wrapper added noise without value.
- **`@repo/abis` shipped source-only, no `dist/` build.** Bots run TS-native under bun and
  consume `./src/index.ts` directly, matching the `@repo/utils` shape. Build/dev/`tsconfig.test.json`
  scripts that source had were dropped.
- **Tests use `bun:test` under `test/` mirroring `src/`.** One retry-timing test is `it.skip`d
  because `bun:test` lacks `vi.advanceTimersByTimeAsync`; the inline comment explains the
  limitation. All other vitest specs were straightforward to convert.

### 2026-05-29 — kill-switch adds anvil fork tests (CRTR-2405)

The kill-switch architecture TIB ([TIB-2026-05-14](../../bots/kill-switch/docs/decisions/TIB-2026-05-14-kill-switch-bot.md)) adds **anvil fork integration tests** — a new CI Integration job plus Foundry (`anvil`) as a dev/CI system dependency — which this TIB deferred under "no Playwright/anvil E2E (no surface in a bot repo)." A safety-critical kill switch is that surface. The **single-runner decision is unchanged**: fork tests run under `bun test` via `@morpho-org/test`'s framework-agnostic `spawnAnvil` (the Vitest fixtures are intentionally not used), so no second test runner is introduced.

### 2026-06-29 — kill-switch bot cancelled

The Kill Switch Bot project is cancelled; we are no longer building it. Its architecture TIB ([TIB-2026-05-14](../../bots/kill-switch/docs/decisions/TIB-2026-05-14-kill-switch-bot.md)) was never accepted and is now marked **Withdrawn**. The forward-looking references to the Kill Switch Bot elsewhere in this TIB — as the planned first bot and as the trigger for the public cut-over — are left intact as the historical record of the decision at the time and no longer reflect current plans.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
