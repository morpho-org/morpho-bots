# TIB-2026-07-20: Migrate to pnpm and remove bun from the toolchain

| Field      | Value      |
| ---------- | ---------- |
| **Status** | Proposed   |
| **Date**   | 2026-07-20 |
| **Author** | @cashd     |
| **Scope**  | Repo-wide  |

---

## Context

A recent npm supply-chain attack prompted a team-wide decision (Slack, `#curators`, 2026-07-17) to
standardize package management on pnpm across repos. The deciding property is pnpm's
"no by default" policy on dependency lifecycle scripts (pnpm v11 `strictDepBuilds`): a compromised
transitive dependency cannot run arbitrary code at install time unless explicitly allowed. bun has
no equivalent default-deny posture. The migration began as a package-manager swap with bun retained
as runtime and test runner, but the split toolchain (pnpm installs, bun everything else) left the
bun binary in every image and CI job for marginal benefit — so the scope expanded, in the same
branch, to remove bun entirely. The `morpho-apps` monorepo already runs pnpm + vitest, so mirroring
it also removes cross-repo tooling divergence.

## Goals / Non-Goals

**Goals**

- Move installs, workspace resolution, the version catalog, and script running to **pnpm 11.1.1**,
  mirroring the `morpho-apps` setup.
- Default-deny dependency lifecycle scripts and carry over the existing install-hardening posture
  (minimum release age, exact saves, store integrity).
- Remove bun entirely: tests run on **vitest**, production bots run bundled JS on **Node**, and no
  image or CI job carries the bun binary.
- Keep CI, Dockerfiles, and deploy flows producing the same artifacts and behavior.

**Non-Goals**

- Upgrading dependencies as part of the migration (beyond what the toolchain swap itself requires).
  Versions are pinned to what the old `bun.lock` resolved; bumps are separate, deliberate changes.
- Changing bot behavior, architecture, or the soltag `sol\`\`` authoring pattern — only how it is
  transformed at build/test time changes.

## Current Solution

bun 1.3.12 was package manager, workspace resolver, task runner, test runner, and runtime:
`bun install` against `bun.lock`, the version catalog in `package.json#workspaces.catalog`,
install hardening (`minimumReleaseAge` 259200 s etc.) in `bunfig.toml`, `bun test` with soltag
transform preloads (`bunfig.toml` `[test]`/`preload`), automatic `.env` loading, and bots running
TypeScript directly via `bun src/index.ts` from `oven/bun` base images. bun runs dependency
lifecycle scripts by default.

## Proposed Solution

Adopt pnpm 11.1.1 (pinned via `package.json#packageManager`, activated through corepack) for
everything install- and workspace-shaped, and replace bun's remaining roles with vitest (tests),
esbuild (bundling), and Node (runtime):

### Package management

- **Workspace + catalog**: the version catalog moves from `package.json#workspaces.catalog` to
  `pnpm-workspace.yaml`, alongside install hardening: `engineStrict`, `saveExact`,
  `verifyStoreIntegrity`, `preferOffline`, `minimumReleaseAge: 4320` minutes (carried over from
  bunfig's 259200 s), `minimumReleaseAgeExclude: @morpho-org/*`, and `allowBuilds` opting in
  **esbuild only** — the sole dependency that needs a lifecycle script; any future allowance is a
  deliberate, reviewable addition.
- **Lockfile**: `bun.lock` deleted; `pnpm-lock.yaml` generated. `bunfig.toml` deleted.
- **Pinned oxlint**: `oxlint` is pinned to `1.61.0` in the catalog — the version the old
  `bun.lock` had resolved. Fresh resolution of `^1.46.0` pulled `1.74.0`, which introduced new
  lint failures and requires `oxlint-tsgolint >= 0.24`; both get bumped together deliberately
  later.
- **Script idiom**: `bun run --filter X cmd` becomes `pnpm --filter X run cmd` across package
  scripts, docs, and agent commands.

### Tests: `bun:test` → vitest 4.1.2

- All 79 test files move from `bun:test` to vitest — a drop-in for `describe`/`it`/`expect`, with
  mechanical renames: `mock()` → `vi.fn()`, `spyOn` → `vi.spyOn`,
  `mock.restore()` → `vi.restoreAllMocks()`.
- The bun test preloads for the soltag `sol\`\``transform are deleted; tests use soltag's`/vite`adapter in per-bot`vitest.config.ts`, and a root `vitest.config.ts` lists the five test-bearing
  workspace projects.
- bun auto-loaded `.env` files; the fork suite's env (`RPC_URL_8453` from `.env.test.local`) now
  loads explicitly via vite's `loadEnv` in the bot config.
- The port surfaced one real bug class: `expect(...).rejects` assertions were floating promises
  under bun's typings — 9 sites are now `await`ed, caught by oxlint's `no-floating-promises` once
  vitest's typings applied.

### Runtime: direct TS execution → esbuild bundle + Node

- Bots no longer run TypeScript directly. Each bot gains `scripts/build.ts` — an esbuild bundle
  with the soltag esbuild `onLoad` transform, the same pattern `@repo/contracts` already used —
  producing `dist/`; production is plain `node dist/src/index.js`.
- Operator scripts that import `sol\`\`` sources (`probe-live-lens`,
`seed-liquidatable-positions`) are bundled as extra entrypoints and run from `dist/`; pure-CLI
  scripts run via tsx.
- `@repo/contracts` `scripts/build.ts` moves from `Bun.build` to esbuild with the same plugin.
- **Bun API shims**: `Bun.env` → `process.env` (42 sites); `Bun.spawn`/`Bun.sleep` in fork
  harnesses → `node:child_process` `spawn` + `node:timers/promises`; bun's `$` shell in
  `deploy-railway` scripts → execa's `$` (quiet + throw by default; stdin secrets via
  `$({ input })`); bun's global `confirm()` → a `node:readline/promises` prompt;
  `import.meta.dir` → `dirname(fileURLToPath(import.meta.url))`.

### Dependencies, Docker, CI

- **Deps**: +vitest 4.1.2, +vite 7.3.6, +tsx 4.21.0, +esbuild 0.28.1, +execa 9.6.0,
  +@types/node 24.7.0; −@types/bun. tsconfig `types` changes `["bun"]` → `["node"]`.
- **Docker**: bot images build from `node:24.14.1-slim` only — no bun binary. All dists are built
  at image build (`pnpm -r --if-present run build`) and `CMD` is `node dist/src/index.js`; no
  runtime transform or container-start build.
- **CI**: the setup action becomes `pnpm/action-setup` (version read from `packageManager`) +
  `setup-node`, installing with `pnpm install --frozen-lockfile`; `setup-bun` is removed and unit
  tests run `pnpm test`.

## Considered Alternatives

### Alternative 1: Stay on bun and mitigate lifecycle-script risk manually

bun 1.3.x has no default-deny lifecycle-script mechanism, so mitigation would rest on release-age
delay alone.

**Why rejected:** Leaves the install-time code-execution vector open, and diverges from the
team-wide standard decided in `#curators`.

### Alternative 2: pnpm for installs, bun retained as runtime + test runner

The migration's original scope: pnpm covers the install-time attack surface while `bun test`,
`bun src/index.ts`, and the soltag preloads stay untouched.

**Why rejected:** A split toolchain keeps the bun binary in every image and CI job, keeps
`bunfig.toml` alive solely for test preloads, and diverges from `morpho-apps`' vitest stack. The
bun-only surfaces (test API, `Bun.*` APIs, direct TS execution) all had straightforward Node
equivalents, so removing bun completes the single-toolchain decision at modest porting cost.

## Assumptions & Constraints

- pnpm's `allowBuilds` stays minimal (esbuild only); any addition must be an explicit, reviewed
  entry.
- The oxlint pin at `1.61.0` is temporary; the coordinated `oxlint` + `oxlint-tsgolint` bump is a
  known follow-up.
- Docker images and `.nvmrc` stay in sync on Node 24.14.1.
- soltag's `/vite` adapter and its esbuild `onLoad` transform produce equivalent output — the fork
  suite and bundled operator scripts exercise this.

## Security

This migration is itself a security measure: pnpm v11's default-deny on dependency lifecycle
scripts (`strictDepBuilds` + a one-entry `allowBuilds` for esbuild) closes the install-time
arbitrary-code vector exploited in the recent npm supply-chain attack. `minimumReleaseAge`
(4320 min, excluding `@morpho-org/*`) adds a publication-delay buffer against freshly compromised
releases, and `verifyStoreIntegrity` + `saveExact` harden resolution. Removing bun entirely also
shrinks the shipped image surface to a single runtime (Node) with no second toolchain to patch.

## Future Considerations

- Bump `oxlint` to 1.74.x together with `oxlint-tsgolint >= 0.24` and fix the new lint findings.

## Addendum A (2026-08-05) — landing the migration against a grown repo

The decision is unchanged. This records how it is applied, since the original branch sat unmerged
for two weeks and the repo moved ~190 commits underneath it.

**Landed as two PRs, not one.** PR 1 does the package-manager swap only, leaving bun as runtime and
test runner, so it touches no test file and closes the install-time vector on its own. PR 2 removes
bun. This mirrors the original branch's own commit split.

**Four workspaces did not exist when this TIB was drafted**: `bots/market-making`,
`bots/midnight-crossed-books`, `bots/kill-switch`, and `@repo/{offers,monitoring,logging,observability}`.
Test files grew 79 -> 136 and `Bun.env` sites 42 -> 59. PR 2 must also port bun surfaces the original
branch never encountered: `Bun.serve`, `Bun.which`, `Bun.file`, `Bun.argv`, `import.meta.main`, and
`import type { Subprocess | Server } from 'bun'`.

**`strictDepBuilds: true` was missing from the original `pnpm-workspace.yaml`.** Without it an
un-opted-in lifecycle script is a warning, not an install failure — which would have left the
deciding security property of this TIB advisory only. It is now set explicitly.

**`allowBuilds` starts empty, not `{esbuild: true}`.** Evidence: no package in the current dependency
tree declares `preinstall`, `install`, or `postinstall`, and `esbuild` is absent from the tree
entirely. esbuild becomes the first and only entry in PR 2, where it is introduced.

**`enablePrePostScripts: true` is required and was never mentioned.** pnpm does not run npm-style
pre/post scripts by default. `prestart` is load-bearing: it builds `@repo/contracts`' gitignored
`dist/` for the liquidators and runs `generate:api` for `midnight-crossed-books`. Without this
setting the bots cannot resolve their own workspace dependency at container start.

**PR 1's Docker intermediate state uses a Node base with a copied bun binary.** Keeping
`FROM oven/bun` was not viable: pnpm is activated through corepack, which those images do not
provide, and `bun install --frozen-lockfile` is not a fallback once `bun.lock` is deleted. Both pnpm
and bun must remain on PATH in the _final_ image for PR 1, because `start` fires `prestart`, which
shells out to pnpm. PR 2 drops the bun binary and switches `CMD` to `node dist/src/index.js`.

**Catalog entries are pinned to what `bun.lock` had resolved.** Regenerating the lockfile re-resolves
every caret range, which contradicts this TIB's non-goal of riding dependency upgrades along.
`@internationalized/date`, `@types/bun`, `date-fns`, and — most importantly — `solc` all drifted
upward and are now pinned exactly. `solc` matters beyond parity: it determines the compiled bytecode
of the soltag `sol```lens templates and the Executor, so a silent bump would invalidate the recorded
explorer-verification settings (0.8.35, optimizer runs=200). Remaining drift is confined to
dev-tooling transitives within their declared ranges; the only runtime-reachable one is `valibot`1.4.1 -> 1.4.2 (patch, via`@morpho-org/viem-dlc`).

**pnpm settings live in `pnpm-workspace.yaml`, not `.npmrc`.** The tracked `.npmrc` stays empty so
configuration does not drift across two files.

**CI stays on `pnpm/action-setup`, blocked from its successor by the org allowlist.** Upstream now
scopes `action-setup` to pnpm v10 and older and points v11+ at `pnpm/setup`; `packageManager` pins
`pnpm@11.1.1`. The successor is the better fit on this TIB's own terms — v2 downloads pnpm's
self-contained release binary and verifies it against the SHA-256 digest GitHub publishes for the
asset, where `action-setup` bootstraps through an `npm ci` of `@pnpm/exe`, and removing an
npm-registry artifact from the path that installs the package manager is exactly the threat model
here. It cannot be adopted yet: `morpho-org`'s Actions allowlist permits `pnpm/action-setup@*` and
not `pnpm/setup@*`, so switching fails every job at the Setup step. `action-setup` installs pnpm
11.1.1 correctly in the meantime, and CI is green on it. **Follow-up:** have an org admin add
`pnpm/setup@*` to the allowlist, then switch.

**The images must not run as root.** `oven/bun` ends with `USER bun`, so the pre-migration images ran
every layer and the bot process unprivileged. The official `node` images define a `node` user (uid 1000) but do not switch to it, so the base swap would silently have promoted a process holding a
funded EOA key to root. Each Dockerfile now runs `corepack enable` as root — its shim lands in
`/usr/local/bin` — then `chown`s `/repo`, drops to `USER node`, and does every install, build, and
`CMD` from there.

**`Bun.env` -> `process.env` retires a documented convention** (`docs/CONVENTIONS.md`), so that edit
lands in PR 2 alongside the code change rather than ahead of it.

## References

- Slack `#curators` decision thread, 2026-07-17 — team-wide pnpm standardization.
- `morpho-apps` monorepo — the pnpm + vitest setup this mirrors.
- [TIB-2026-04-16-bootstrap-curator-bots](./TIB-2026-04-16-bootstrap-curator-bots.md) — the
  original bun-first tooling stack this amends.

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
