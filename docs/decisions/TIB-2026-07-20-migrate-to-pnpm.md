# TIB-2026-07-20: Migrate package management to pnpm

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
no equivalent default-deny posture. The `morpho-apps` monorepo already runs this pnpm setup, so
mirroring it also removes cross-repo tooling divergence.

## Goals / Non-Goals

**Goals**

- Move installs, workspace resolution, the version catalog, and script running to **pnpm 11.1.1**,
  mirroring the `morpho-apps` setup.
- Default-deny dependency lifecycle scripts and carry over the existing install-hardening posture
  (minimum release age, exact saves, store integrity).
- Keep CI, Dockerfiles, and deploy flows producing the same artifacts and behavior.

**Non-Goals**

- Replacing bun as the **runtime and test runner**. `bun test`, `bun src/index.ts`, and the soltag
  test preloads (`bunfig.toml` `[test]`) are unchanged. This is a package-manager migration only.
- Upgrading dependencies as part of the migration. Versions are pinned to what the old `bun.lock`
  resolved; bumps are separate, deliberate changes.

## Current Solution

bun 1.3.12 was package manager, workspace resolver, and task runner: `bun install` against
`bun.lock`, the version catalog in `package.json#workspaces.catalog`, install hardening
(`minimumReleaseAge` 259200 s etc.) in `bunfig.toml`, and the `bun run --filter X cmd` idiom
across scripts, docs, and agent commands. Dockerfiles built from `oven/bun` base images. bun runs
dependency lifecycle scripts by default.

## Proposed Solution

Adopt pnpm 11.1.1 (pinned via `package.json#packageManager`, activated through corepack) for
everything install- and workspace-shaped, while bun stays the runtime:

- **Workspace + catalog**: the version catalog moves from `package.json#workspaces.catalog` to
  `pnpm-workspace.yaml`, alongside install hardening: `engineStrict`, `saveExact`,
  `verifyStoreIntegrity`, `preferOffline`, `minimumReleaseAge: 4320` minutes (carried over from
  bunfig's 259200 s), `minimumReleaseAgeExclude: @morpho-org/*`, and `allowBuilds: {}` — nothing
  in the current tree needs lifecycle scripts, so any future allowance is a deliberate,
  reviewable addition.
- **Lockfile**: `bun.lock` deleted; `pnpm-lock.yaml` generated. `bunfig.toml` survives only for
  the `[test]` preload.
- **Pinned oxlint**: `oxlint` is pinned to `1.61.0` in the catalog — the version the old
  `bun.lock` had resolved. Fresh resolution of `^1.46.0` pulled `1.74.0`, which introduced new
  lint failures and requires `oxlint-tsgolint >= 0.24`; both get bumped together deliberately
  later.
- **Script idiom**: `bun run --filter X cmd` becomes `pnpm --filter X run cmd` across package
  scripts, docs, and agent commands.
- **Docker**: bot images switch from `oven/bun` base to `node:24.14.1-slim` with corepack-enabled
  pnpm (version from `packageManager`), and the bun binary `COPY`'d from `oven/bun:1.3.12-slim`.
  `bun run start` still drives `prestart` (`pnpm -r --parallel --if-present run build`) and then
  `bun src/index.ts`.
- **CI**: the setup action becomes `pnpm/action-setup` (version read from `packageManager`) +
  `setup-node` + `setup-bun`, installing with `pnpm install --frozen-lockfile`.

## Considered Alternatives

### Alternative 1: Stay on bun and mitigate lifecycle-script risk manually

bun 1.3.x has no default-deny lifecycle-script mechanism, so mitigation would rest on release-age
delay alone.

**Why rejected:** Leaves the install-time code-execution vector open, and diverges from the
team-wide standard decided in `#curators`.

### Alternative 2: Move fully to pnpm + Node, dropping bun as runtime

**Why rejected:** The bots and their tests are built on bun's runtime and test runner (including
soltag preloads); porting them buys no security — the attack surface is install-time, which pnpm
already covers.

## Assumptions & Constraints

- pnpm's `allowBuilds: {}` holds only while no dependency genuinely needs a build script; any
  addition must be an explicit, reviewed entry.
- The oxlint pin at `1.61.0` is temporary; the coordinated `oxlint` + `oxlint-tsgolint` bump is a
  known follow-up.
- Docker images depend on bun 1.3.12 and Node 24.14.1 staying in sync with `.nvmrc` and the
  `COPY` source tag.

## Security

This migration is itself a security measure: pnpm v11's default-deny on dependency lifecycle
scripts (`strictDepBuilds` + empty `allowBuilds`) closes the install-time arbitrary-code vector
exploited in the recent npm supply-chain attack. `minimumReleaseAge` (4320 min, excluding
`@morpho-org/*`) adds a publication-delay buffer against freshly compromised releases, and
`verifyStoreIntegrity` + `saveExact` harden resolution.

## Future Considerations

- Bump `oxlint` to 1.74.x together with `oxlint-tsgolint >= 0.24` and fix the new lint findings.
- If bun ships a default-deny lifecycle-script policy, the split between pnpm (installs) and bun
  (runtime) could be revisited.

## References

- Slack `#curators` decision thread, 2026-07-17 — team-wide pnpm standardization.
- `morpho-apps` monorepo — the pnpm setup this mirrors.
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
