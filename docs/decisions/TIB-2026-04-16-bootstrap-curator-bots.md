# TIB-2026-04-16: Bootstrap `curator-bots` repo from `morpho-apps` foundations

| Field      | Value                                |
| ---------- | ------------------------------------ |
| **Status** | Proposed                             |
| **Date**   | 2026-04-16                           |
| **Author** | @cashd                               |
| **Scope**  | Repo-wide (morpho-org/curator-bots)  |

---

## Context

`morpho-org/curator-bots` was created on 2026-04-16 as a fresh bun+turbo scaffold to house new
off-chain bot services for Morpho curator operations (reallocators, liquidation monitors,
rebalancers — exact first bot TBD). The repo currently contains only `npm create turbo@latest`
defaults plus a CODEOWNERS file, meaning a new contributor — human or AI — starts from no
conventions, no agent guidance, no shared packages, and no CI.

Meanwhile, `morpho-apps` has matured a set of **cross-cutting foundations** that are
domain-agnostic: AI-agent role definitions (reviewer / documentor / morpho-protocol-engineer /
product-manager), self-verification discipline, the TIB decision-record workflow, a
coding-conventions document, the ox lint/format stack, knip dead-code detection, and a lean CI
pipeline. These foundations are not tied to Next.js or to any specific app; they encode how this
team wants to work. Rebuilding them from scratch in `curator-bots` would waste weeks and guarantee
drift between the two repos.

Two code packages (`@repo/utils`, `@repo/abis`) are also clear migration candidates because every
bot will need bigint/WAD math, retry helpers, env validation, and Morpho contract ABIs on day one.

The rest of `morpho-apps` — Next.js apps, UI packages, observability wiring, web3/wagmi layer,
resolvers, indexer, Playwright/anvil E2E — is out of scope here. Those exist to serve frontends;
bots do not need them.

## Goals / Non-Goals

**Goals**

- Establish a dev experience in `curator-bots` that feels identical to `morpho-apps` for
  anyone (including Claude) used to working in the source: same commit conventions, same
  self-verification ritual, same TIB workflow, same lint/format commands.
- Adopt the ox tooling stack fully: **oxlint** (not ESLint), **oxfmt** (not Prettier), with
  **knip** and **vitest** on top, all orchestrated by **bun workspace scripts** (`bun run --filter
  '*' <task>`) — no turbo — and running under **bun 1.3.12** with **Node 24.14.1**.
- Ship two workspace packages — `@repo/utils` (server-safe subset) and `@repo/abis` (full port) —
  ready for the first bot to consume.
- Leave a clean `docs/` scaffold (CONVENTIONS.md, GUIDANCE.md, empty decisions/retros folders,
  TIB + DATA-FLOW templates) so the team writes its own content from day one, and commits to the
  TIB discipline.
- Land a minimal CI (lint / typecheck / test:unit / knip on every PR), plus pre-commit + commit-msg
  git hooks enforcing the convention locally.
- Keep the package namespace `@repo/*` so code lifted from `morpho-apps` compiles with zero
  import rewrites.

**Non-Goals**

- Porting any Next.js app (curator-app, curator-v2-app, liquidation-app, delegate-app,
  markets-v2-app, brand-app, data-app, storybook-app, fallback-rpc). Bots are headless services,
  not web UIs.
- Porting UI / observability / platform packages (`@repo/ui`, `@repo/hooks`,
  `@repo/tailwind-config`, `@repo/morpho-brand-ui`, `@repo/web3`, `@repo/observability`,
  `@repo/resolvers`, `@repo/indexer`). They either have no place in bots or are large enough to
  deserve their own per-bot decisions.
- Porting existing TIBs, retros, `docs/CI-CD.md`, `docs/adding-a-new-chain.md`, or `docs/context/`
  content. New repo authors new docs.
- Porting E2E infrastructure (Playwright, anvil/Foundry fork, Upstash KV cache). Bot testing
  strategy is a separate TIB when the first bot needs it.
- Porting deployment surfaces (Vercel configs, Sentry/PostHog wiring, GraphQL codegen,
  release/label automation).
- Choosing the first bot. This TIB stops at the empty `apps/` directory.

## Current Solution

`curator-bots` is a fresh turbo template:

```
curator-bots/
├── apps/                    # empty
├── packages/                # empty
├── bun.lock
├── package.json             # turbo + prettier + typescript devDeps only
├── README.md                # turbo stub
└── turbo.json               # default (build, dev, lint, check-types)
```

Root `package.json` declares `packageManager: "bun@1.3.12"`, `engines.node: ">=18"`, and workspace
globs `apps/*`, `packages/*`. CODEOWNERS assigns `@cashd` to all paths, with branch protection
requiring code-owner approval on main. Nothing else exists.

Doing nothing means new bots land in a repo with no conventions, no agent guidance, and no shared
utilities. Every contributor reinvents formatting, error handling, and env validation. Claude gets
no CLAUDE.md to align behavior.

## Proposed Solution

Port a **curated foundation slice** of `morpho-apps` into `curator-bots` across seven ordered
phases. The slice is: ox-stack tooling, agent infra, pruned conventions + TIB scaffold, two code
packages trimmed to bot needs, two new config packages, and lean CI.

### Key design decisions

`curator-bots` deliberately **diverges** from `morpho-apps` on runtime and JS tooling. `morpho-apps`
is a NextJS-centric monorepo; `curator-bots` is headless services and adopts the ox stack fully.
The table below shows the chosen stack alongside the source repo's stack for quick comparison; bold
entries are the curator-bots choice.

| Decision           | curator-bots                         | morpho-apps            | Why                                                                                   |
| ------------------ | ------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------- |
| Package manager    | **bun 1.3.12**                       | pnpm 10.32.1           | Target is already bun; ox/bun direction for the new repo                              |
| Node version       | **24.14.1**                          | 24.14.1                | Matches source's `.nvmrc`; required by some morpho deps                               |
| Linter             | **oxlint**                           | ESLint (flat config)   | User is fully on the ox stack                                                         |
| Formatter          | **oxfmt 0.35+**                      | Prettier               | ox stack; fast, zero-config                                                           |
| Dead-code detector | **knip 5**                           | knip 5                 | Matches source; invoked directly as `bun run knip` (no turbo task graph needed)       |
| Task runner        | **bun workspace scripts**            | turbo 2.x              | **Divergence.** Turbo's pipeline graph + remote cache payoff is invisible at 2-package scale; `bun run --filter '*' <task>` covers our needs with zero extra tooling and no `TURBO_TOKEN` provisioning. Revisit if workspace count or CI time grows. |
| Version pinning    | **bun catalog**                      | pnpm catalog           | Bun 1.2+ supports the catalog pattern; mirrors source's `pnpm-workspace.yaml` catalog |
| Package namespace  | **`@repo/*`**                        | `@repo/*`              | Max copy-paste compatibility from source                                              |
| Test runner        | **vitest 4.x**                       | vitest 4.x             | Matches source                                                                        |
| Pre-commit         | **husky + lint-staged + commit-msg** | husky + lint-staged    | oxlint/oxfmt on staged files; enforce `type(scope): description` 72-char commits      |

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
└── apps/                             # empty until first bot
```

### Implementation Phases

**Phase 1 — Tooling foundation (bun + ox)**
Root `package.json` gains workspaces catalog (seed: viem, vitest, typescript, zod, lodash-es,
date-fns), dev deps (typescript, oxlint, oxfmt, knip, husky, lint-staged), and root scripts (lint,
format, typecheck, test:unit, knip, clean) that fan out to workspaces via `bun run --filter '*'
<task>`. Delete the default `turbo.json` seeded by `npm create turbo` and drop `turbo` from dev
deps. Create `.nvmrc`, `.oxlintrc.json`, `.oxfmtrc.json`, `knip.json` (root-only), and root
`tsconfig.json`.

**Phase 2 — Agent & editor infrastructure**
Port `CLAUDE.md` with `pnpm → bun` rewrite and removal of React/UI references; keep Strict Rules,
Agent Team, agent conventions (plan review gate, test verification, transparency, mirror
discipline, completion status), self-verification workflow, anti-rationalization table, proactive
verification tests. Symlink `AGENTS.md → CLAUDE.md`. Port `.cursor/`, `.vscode/`, `.zed/` verbatim
(small files). Create `.mcp.json` with **linear + context7** servers only (drop playwright —
headless repo).

**Phase 3 — Conventions & docs scaffold**
Port `docs/CONVENTIONS.md` pruned: keep file-structure, general code style, comments,
function-organization, code-complexity, type-safe errors, `tryCatch` reference. Drop React Error
Boundaries, Toast patterns, `getClientEnvVar`/`getServerEnvVar` split, Sentry hooks, `captureError`.
Rewrite the Env Access section for server-only `getEnvVar` + zod. Port `docs/GUIDANCE.md`,
`docs/templates/TIB.md`, `docs/templates/DATA-FLOW.md` verbatim. Create placeholder READMEs in
`docs/`, `docs/decisions/`, `docs/retros/`, plus a minimal `docs/INDEX.md`. Do **not** port
existing TIBs, retros, `docs/CI-CD.md`, `docs/adding-a-new-chain.md`, or `docs/context/`.

**Phase 4 — Code packages (`@repo/utils` server-safe + `@repo/abis` full)**
`@repo/utils`: copy `src/`; delete `client.ts` export and any helper touching
`window`/`document`/`localStorage`; drop `js-cookie` + `@types/js-cookie` deps + `jsdom` dev dep.
Keep `sideEffects: false`, pure-TS (no build step), exports `.`, `./server`, `./types`. Runtime
deps: `@internationalized/date`, `@morpho-org/morpho-ts@2.5.0`, `date-fns`, `lodash-es`, `viem`,
`zod` (catalog where possible). `@repo/abis`: copy `src/` verbatim including v1/v2/SafeWallet ABIs;
keep `.`, `./v1`, `./v2` exports; keep tsc build to `dist/`; keep `tsconfig.test.json` split. Both
packages' scripts: lint (oxlint), lint:fix, format/format:check (oxfmt), typecheck, test:unit
(vitest), clean.

**Phase 5 — Tooling packages (`@repo/typescript-config` + `@repo/oxlint-config`)**
`@repo/typescript-config`: new package exporting `./base` and `./module` only (drop `./nextjs`,
`./playwright`, `./react-library` — not needed). Strict TS config with declaration + noEmit, ESNext
target. `@repo/oxlint-config`: new package exporting `./base`. Rewrite from the *spirit* of source's
`@repo/eslint-config` (error on warnings, no-console, prefer-const, strict equality); oxlint has a
smaller rule catalog than ESLint, so gaps get filled with tsconfig strictness or accepted. Phase 4
packages consume both.

**Phase 6 — CI workflows & git hooks**
Port `.github/actions/setup/action.yml` rewritten for bun: `oven-sh/setup-bun@v2` with
`bun-version: 1.3.12`, `actions/setup-node@v4` reading `.nvmrc`, `bun install --frozen-lockfile`.
Keep the `install` + `frozen-lockfile` input parameters. Do **not** port `_cache-setup.yml` — no
turbo, no remote cache. Port `checks.yml` adapted: drop all `NEXT_PUBLIC_*` / REOWN /
BLUE_SERVICES / `TURBO_TOKEN` / `TURBO_TEAM` env; keep `CI`; 4 jobs (Lint, Typecheck, Unit-Test,
Dead-Code) running `bun run ...` (which fans out via `bun run --filter '*'` under the hood). Rely on
GitHub Actions' built-in `actions/cache` for `bun install` and `node_modules` caching. Husky: `bunx
husky init`; pre-commit runs `bunx lint-staged`; commit-msg validates `type(scope): description`
≤ 72 chars (bash regex — commitlint optional later). `.lintstagedrc.mjs` runs
`oxfmt --no-error-on-unmatched-pattern` on `*.{js,jsx,ts,tsx,json,md,yaml,yml}` and
`oxlint --fix --max-warnings 0` on JS/TS.

**Phase 7 — Validation sweep & cut-over**
From clean state: `bun install`, `bun run lint` (0 warnings), `bun run format:check` (clean),
`bun run typecheck` (0 errors), `bun run test:unit` (passes), `bun run knip` (0 unused),
`bun run build` on `@repo/abis` (dist emitted). Push a branch, open PR, verify all 4 CI jobs pass
and that CODEOWNERS enforces review. Update `README.md` with a one-paragraph intro pointing at
`CLAUDE.md`, `docs/CONVENTIONS.md`, `docs/GUIDANCE.md`. Smoke-test the agent surface: open Claude
Code, ask it to add a trivial utility to `@repo/utils`, confirm it follows the conventions
(colocated types, `tryCatch` usage, zero-warning lint).

## Considered Alternatives

### Alternative 1: Keep source's pnpm + ESLint stack

Replicate `morpho-apps` exactly — pnpm 10.32.1, ESLint flat config, eslint-config package — so
diffs are trivial.

**Why rejected:** User has explicitly chosen the ox stack (oxlint + oxfmt) and bun. Staying on
pnpm/ESLint would violate that direction and preserve tooling the user is moving away from.

### Alternative 2: Full-monorepo mirror minus brand/data/storybook

Port everything except the three obviously-marketing apps — so curator-app, curator-v2-app,
liquidation-app, delegate-app, markets-v2-app, fallback-rpc, plus all UI packages.

**Why rejected:** The new repo's purpose is bots, not UIs. A full mirror would drag in Next.js,
wagmi, Tailwind, Sentry, and the entire GraphQL/oRPC layer — massive surface area for code the repo
will never run. The user explicitly scoped to "workflows + conventions + agent tools + utils + abis
+ docs scaffold."

### Alternative 3: `@curator-bots/*` or `@morpho/*` package namespace

Rename packages to match the repo or the org.

**Why rejected:** Every `import { ... } from '@repo/utils'` line copied from `morpho-apps`
would need a rewrite. For a foundation migration where we're explicitly aiming to keep things
portable between the two repos, the cost outweighs the aesthetic gain. A future rename is a
mechanical codemod if it's ever wanted.

### Alternative 4: Port `CONVENTIONS.md` verbatim

Copy the file as-is and let contributors prune during normal edits.

**Why rejected:** References to `@repo/observability`, `lib/observability/errors`, React Error
Boundaries, Toasts, `getClientEnvVar`/`getServerEnvVar`, and Next.js env inlining are actively
misleading in a bot repo. They'd send Claude down wrong paths (e.g., "Use `captureError`" when no
such function exists). Prune-up-front costs ~30 min and prevents months of drift.

### Alternative 5: Keep turbo 2.x as the task runner

Bring over `turbo.json` (trimmed from source's 14 tasks to ~10), wire root `package.json` scripts
through `turbo run <task>`, port `_cache-setup.yml`, and rely on `TURBO_TOKEN`/`TURBO_TEAM` for
Vercel-hosted remote caching — matching `morpho-apps` task orchestration 1:1.

**Why rejected:** At two packages and an empty `apps/`, turbo's pipeline graph and remote cache buy
almost nothing — the value kicks in with many workspaces, long-running builds, and high CI volume,
none of which describe this repo today. Bun's `bun run --filter '*' <task>` already runs scripts
across workspaces natively and needs zero provisioning (no Vercel team, no tokens, no extra
workflow). Dropping turbo removes a class of external-state dependencies and keeps the root shape
honest — root scripts mean what they say. Turbo is a mechanical add-back later (a `turbo.json` + one
dev dep) if workspace count grows or CI parallelism becomes painful; tracked under Future
Considerations. This is a **deliberate divergence from `morpho-apps`** and is captured in the Key
design decisions table.

## Assumptions & Constraints

- Bun 1.3.12's workspace catalog resolves the same versions that pnpm's catalog did for the
  transitive deps we care about (viem, vitest, typescript, etc.). Any divergence gets manually
  pinned at the workspace level.
- oxlint's rule catalog (smaller than ESLint's) is sufficient for bot code. Gaps will be accepted,
  worked around with tsconfig strictness, or addressed in a follow-up TIB if they become painful.
- `@repo/abis`'s dependency on `@repo/utils` only reaches utilities that survive the server-safe
  trim. Verified in Phase 4 by re-running `bun run build` on `@repo/abis` after the trim.
- `CLAUDE.md` edits keep all the meta-rules (self-verification, anti-rationalization, completion
  status) intact. The only edits are command rewrites (pnpm→bun) and deletion of UI-specific
  examples.
- The user is the sole code owner on main (per CODEOWNERS + branch protection configured
  2026-04-16). Any PR in this migration must be self-reviewed or require a second approver added
  later.

## Dependencies

- **Source snapshot**: `morpho-apps` as of 2026-04-16. If source files change materially
  during this migration, re-read before porting.
- **Runtime**: bun 1.3.12 (repo-pinned), Node 24.14.1 (via `.nvmrc`).
- **Core tooling** (dev deps): oxlint (latest), oxfmt 0.35+, knip 5.x, husky 9+, lint-staged 15+,
  vitest 4.x, typescript 5.9. **No turbo.**
- **Catalog versions** (runtime): viem (matching source's 2.47.x), `@morpho-org/morpho-ts@2.5.0`,
  zod, date-fns, lodash-es, `@internationalized/date`.
- **CI**: GitHub Actions with `depot-ubuntu-latest` runners (can fall back to `ubuntu-latest` if
  depot isn't provisioned).
- **MCP servers** in `.mcp.json`: Linear (`mcp.linear.app/sse`), Context7 (`mcp.context7.com/mcp`).

## Security

- Pre-commit + commit-msg hooks enforce the Strict Rule of never committing ENV keys (lint-staged
  can also run a secret-scanner as a follow-up).
- CODEOWNERS + main branch protection require code-owner approval before merge. Force-push +
  deletion disabled.
- Repo is private under `morpho-org`. Access control inherits org-level team permissions.
- No secrets are encoded in committed workflow files; this migration introduces none (dropping
  turbo removed the need for `TURBO_TOKEN`/`TURBO_TEAM`).
- `CLAUDE.md` Strict Rules (never commit to main, never add ENV keys) are mirrored into
  Cursor/Zed/MCP agent contexts, so AI edits inherit the same guardrails.

## Future Considerations

- **First bot**: a separate TIB will address the first concrete bot (likely a curator reallocator
  or liquidation monitor). It will bring its own deps (probably `@repo/web3` lite or a direct viem
  client, observability wiring, a job runner) and may extend `@repo/utils` with bot-specific
  helpers.
- **Per-bot platform packages**: if and when bots need observability, chain clients, or
  resolver-style aggregation, port them lazily — one package per TIB — with server-only trimming,
  not a wholesale pull from source.
- **oxlint rule gaps**: as gaps surface in real code (e.g., a rule source relied on that oxlint
  lacks), record each in a follow-up TIB and decide: strict-TS backstop, oxlint custom rule, or
  explicit acceptance.
- **Revisit turbo**: if workspace count grows past ~5 or CI job time gets painful, reconsider
  turbo as the task runner. Adding it back is a `turbo.json` + one dev dep; bun's `--filter` covers
  today's scale.
- **Repo rename**: the GitHub repo is already `curator-bots`; the local working directory
  `/Users/cashd/workspace/morpho/morpho-bots/` renames to `curator-bots` at author convenience.
- **Linear + PR automation**: source has PR label / Slack / team-label workflows not ported here.
  Worth porting once team collaborators exist; premature for a solo-owner repo.

## Open Questions

- **Bun catalog parity**: does bun 1.3.12's catalog resolve the same transitive peer-dep graph as
  pnpm's catalog, particularly around viem + wagmi peer deps? Tested at the end of Phase 4 when
  `bun install` runs with real package.jsons.
- **`@repo/abis` ↔ `@repo/utils` coupling**: source's abis imports from utils. Need to confirm
  *which* utils functions it uses (likely error helpers or bigint math — server-safe) before
  finalizing the utils trim in Phase 4.
- **Knip per-package config**: source's `knip.json` has rich per-workspace entries. Phase 1 ships a
  root-only config; per-package entries get added in Phase 4 as workspaces land. Confirm knip is
  happy with the minimal set.
- **Commit-msg validator**: bash regex is lightweight but brittle. Worth evaluating
  `@commitlint/cli` + `@commitlint/config-conventional` in a Phase 6 follow-up if the regex needs
  extension.

## References

- **Target repo**: https://github.com/morpho-org/curator-bots (private)
- **Source repo (local snapshot)**: `/Users/cashd/workspace/morpho/morpho-apps`
- **Source files authoritative for the migration**:
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
  - `morpho-apps/packages/eslint-config/` (spirit reference for Phase 5 oxlint rewrite)

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
