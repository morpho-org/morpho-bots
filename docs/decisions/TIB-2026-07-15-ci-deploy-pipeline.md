# TIB-2026-07-15: CI/CD deploy pipeline for Railway bots

| Field      | Value      |
| ---------- | ---------- |
| **Status** | Accepted   |
| **Date**   | 2026-07-15 |
| **Author** | @hayden    |
| **Scope**  | Repo-wide  |

---

## Context

The repo has idempotent Railway deploy scripts (`deploy/scripts/deploy-railway-{blue-liq,midnight-liq}.ts`)
but no CI/CD — every deploy is a manual `railway up` from an operator's laptop. Two deployable bots
exist: **blue-liq** (Railway project `fe08126a…`, services `rindexer` / `bot-8453` / `bot-4663` plus a
managed Postgres) and **midnight-liq** (project `f9bc21b5…`, service `bot`). Both projects already carry
an empty `staging` environment alongside the live `production` one.

[TIB-2026-07-14-slack-ci-notifications](./TIB-2026-07-14-slack-ci-notifications.md) deferred exactly
this: its Alternative 4 rejected porting full release automation because _"curator-bots has no
release process yet."_ This TIB adds that release process and the deploy automation around it.

## Goals / Non-Goals

**Goals**

- Automatic staging deploys of both bots on every commit to `main`.
- Gated production deploys — a bot ships to production only when its merged PR carried a
  `release-{bot}` label — plus a per-app CalVer GitHub release + git tag.
- **Deploy-only CI**: ship code via `railway up`; keep all variables and secrets (RPC URLs, signer
  private keys, venue keys) out of GitHub entirely.
- Fit repo CI conventions — SHA-pinned actions, thin reusable YAML, manifest-driven scripts.

**Non-Goals**

- **Not provisioning in CI.** Variables and secrets are set once per environment by the existing
  full `deploy-railway-{blue-liq,midnight-liq}.ts` scripts and live only on Railway.
- **Not a manual production approval gate.** Production is fully automatic on a labelled merge.
- **Not path-based selective staging.** Every `main` commit redeploys both bots (see Future
  Considerations).
- **Not the Claude-authored release-notes chain.** The label + tag convention aligns with
  `.claude/commands/ci-*.md`, but that generation chain is not wired here.

## Current Solution

Deploys are manual: an operator runs `deploy-railway-{blue-liq,midnight-liq}.ts` locally against a
`railway login` session. Those scripts are idempotent and provision everything — services, volumes,
variables, secrets, and the deploy — so a full run is the only way to ship, and it necessarily has
the signer keys on the operator's machine. There is no automated path from a merge to a running
deploy.

## Proposed Solution

A three-workflow GitHub Actions pipeline plus a new deploy-only Railway entrypoint. CI ships **code
only**; state stays on Railway.

**Deploy-only entrypoint.** New `deploy/scripts/deploy-railway.ts` reads the bot→services map from
new `deploy/scripts/manifest.ts` and runs `railway up -d` per service (concurrent build kickoff,
then poll to a terminal status). It sets no variables or secrets and creates nothing — a missing
service fails loud, which is the correct signal that the environment was never provisioned. Because
a project-scoped `RAILWAY_TOKEN` already pins project + environment, the CLI calls must **omit**
`-p/-e` (passing them alongside a token conflicts); `railway.ts` captures this as a `hasToken` flag
feeding pure `upArgs` / `deploymentListArgs` helpers.

**Reusable deploy job.** `.github/workflows/deploy-bot.yml` is a `workflow_call` job taking
`bot` / `stage` / `ref`. It declares `environment: <bot>-<stage>`, installs the Railway CLI, and
runs `deploy:railway` with `RAILWAY_PROJECT_ID` (a var) and `RAILWAY_TOKEN` (a secret) read straight
from that GitHub Environment — never passed by callers. `contents: read` only.

**Staging** (`deploy-staging.yml`) — on `push: [main]`, fan out to `deploy-bot.yml` for both bots at
`stage: staging`, `ref: github.sha`. The merge queue keeps `main` green, and its
`gh-readonly-queue/*` refs fire `merge_group` not `push`, so this runs once per merged PR.

**Production** (`deploy-production.yml`) — on `push: [main]`, a `Select` job recovers the merged
PR's labels from the `repos/{repo}/commits/{sha}/pulls` API and emits a per-bot boolean. Each bot's
deploy job is gated on its flag; a matching bot ships to `stage: production`, then a `Release-{bot}`
job (gated on that deploy) cuts a CalVer tag `{bot}-YYYY.MM.DD-N` via
`gh release create --generate-notes --notes-start-tag <prev-bot-tag>`. Publishing the release fires
the existing `release-slack-notify.yml`. A repo-level concurrency group serializes production runs
so same-day `N` computation can't race.

**Auth + secrets scoping.** Four GitHub Environments — `{blue-liq,midnight-liq}-{staging,production}` — each
hold a `RAILWAY_TOKEN` secret and a `RAILWAY_PROJECT_ID` var, with **deployment branches restricted
to `main`**. That branch policy is load-bearing (see below).

### Why `push: main`, not `pull_request: closed`

Production triggers on `push: main` deliberately. A `pull_request` run's ref is
`refs/pull/N/merge`: under a main-only environment deployment-branch policy that job is **blocked
from the environment**, and with no policy the production `RAILWAY_TOKEN` becomes exfiltratable from
any same-repo PR branch. `push: main` gives ref `refs/heads/main` (satisfies the branch policy) and
the correct main HEAD in `github.sha` (no `merge_commit_sha` ambiguity under the merge queue). Labels
are then recovered from the landed commit via `commits/{sha}/pulls`.

## Considered Alternatives

### Alternative 1: Full provisioning in CI

Store every variable and secret — including production `SIGNER_PRIVATE_KEY` — as GitHub secrets and
run the existing full `deploy-railway-{blue-liq,midnight-liq}.ts` scripts in CI.

**Why rejected:** puts crown-jewel signer keys in GitHub. The deploy-only model keeps them on
Railway; CI holds only a scoped `RAILWAY_TOKEN`.

### Alternative 2: `pull_request: closed` trigger for production

Trigger the production workflow when a PR closes/merges.

**Why rejected:** the branch-policy / secret-exfiltration bind described above — the merge ref
`refs/pull/N/merge` either fails the main-only environment gate or, without a gate, exposes the
production token to arbitrary PR branches.

### Alternative 3: A single workspace team token

Use one `RAILWAY_API_TOKEN` for the whole workspace instead of four project-scoped tokens.

**Why rejected (kept as a documented fallback):** fewer tokens but a far broader blast radius across
both projects, and it needs an `initialize()` tweak to select project + environment. Retained as a
fallback, not the default.

### Alternative 4: Railway native GitHub auto-deploy

Connect each Railway service to a branch and let Railway redeploy on push.

**Why rejected:** doesn't fit the label / release-tag production trigger and diverges from the
CLI-driven, manifest-based deploy model the rest of `deploy/` uses.

## Assumptions & Constraints

- **Private single-org repo.** All PRs originate in-repo; the `push: main` + main-only environment
  trust model assumes no fork PRs. Revisit if the repo goes public.
- **Staging is provisioned once, manually.** The empty `staging` environments must be filled by the
  full provisioning script using **separate staging keys / wallets / RPCs** — never production
  credentials.
- **Provisioning is out of band.** When variables or secrets change, re-run the full
  `deploy-railway-{bot}.ts` for that environment; the CI path never touches them.
- **Railway CLI pinned to `5.26.1` in CI.** The subcommands in `railway.ts` must stay compatible
  with that version. This is the one item unverified until the first live run.

## Security

The "signer keys never enter GitHub" property holds for **storage** — CI never receives or sets any
bot secret. But be honest about the token: a project-scoped `RAILWAY_TOKEN` is a bearer credential
that can read the project's secrets back (`railway variables`), including `SIGNER_PRIVATE_KEY`. So
the GitHub-held token's blast radius is **≈ the signer key**, and it must be treated as high-value.

Mitigations:

- The token is **revocable / rotatable without touching bot keys** — rotating it doesn't rotate the
  signer key, and vice versa.
- It is **scoped to one project + environment**, so a leaked staging token can't reach production.
- It is **only usable from `main`** via the environment deployment-branch policy, closing the PR
  branch exfiltration path.

## Future Considerations

- **Path-based staging filtering** so only bots whose code changed redeploy — today every `main`
  commit triggers up to four Railway builds.
- **Optional production approval reviewers** on the `*-production` environments if a manual gate is
  later wanted.
- **Wiring the Claude-authored release-notes chain** (`.claude/commands/ci-write-release-notes.md`,
  `ci-comment-on-pr-release-labels.md`) into the release jobs, since the label + tag convention
  already matches.

## References

- [TIB-2026-07-14-slack-ci-notifications](./TIB-2026-07-14-slack-ci-notifications.md) — its
  Alternative 4 deferred exactly this release automation; publishing a release here fires that TIB's
  `release-slack-notify.yml`.
- [TIB-2026-07-13-bot-architecture](./TIB-2026-07-13-bot-architecture.md) — the `apps/` + `packages/`
  - `deploy/` shape and the per-chain daemons these deploys ship.
- [TIB-2026-07-14-betterstack-log-forwarding](./TIB-2026-07-14-betterstack-log-forwarding.md) — the
  sibling deploy-time observability layer set on Railway alongside these deploys.
- Implementation surface: `.github/workflows/deploy-bot.yml`, `deploy-staging.yml`,
  `deploy-production.yml`; `deploy/scripts/deploy-railway.ts`, `manifest.ts`, `railway.ts`.
- Release-notes convention: `.claude/commands/ci-write-release-notes.md`,
  `ci-comment-on-pr-release-labels.md`.

## Addenda

### 2026-07-16 — re-pointed at per-bot deploy scripts after the pipeline revert

The op-pipeline architecture was reverted (see
[TIB-2026-07-16-revert-to-bots-as-programs](./TIB-2026-07-16-revert-to-bots-as-programs.md)). The
deploy pipeline's shape is unchanged — same triggers, `<bot>-<stage>` GitHub Environments,
`release-{bot}` labels, CalVer tagging, and concurrency — but the machinery it drives moved:

- `@repo/deploy` (`deploy/scripts/deploy-railway.ts`, `manifest.ts`, `railway.ts`) is gone. The
  reusable `deploy-bot.yml` now maps each bot id to its workspace package and runs that bot's own
  `bots/<bot>/scripts/deploy-railway.ts` (`blue-liq` → `@morpho-org/blue-liquidation`, `midnight-liq`
  → `@morpho-org/midnight-liquidation`). No workflow references `deploy/` or `@repo/deploy`.
- Those per-bot scripts are full-provisioning and require RPC/keys, which CI does not hold — so CI
  runs them in a thin `DEPLOY_ONLY=true` mode that re-ships already-provisioned services and sets no
  secrets or variables.
- The signing key stored as a GitHub/Railway secret is each bot's `LIQUIDATOR_PRIVATE_KEY`, not
  `SIGNER_PRIVATE_KEY` — there is no separate signer daemon; the `apps/` + `packages/` + `deploy/`
  monorepo shape referenced above is now `bots/` + `packages/`.
