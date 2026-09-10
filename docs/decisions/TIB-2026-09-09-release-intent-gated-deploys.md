# TIB-2026-09-09: Release intent in the PR description, gated in the deploy workflow

| Field          | Value                                                       |
| -------------- | ----------------------------------------------------------- |
| **Status**     | Accepted                                                    |
| **Date**       | 2026-09-09                                                  |
| **Author**     | @hayden                                                     |
| **Scope**      | Repo-wide                                                   |
| **Supersedes** | TIB-2026-07-15 (production trigger, release tags, dispatch) |

---

## Context

[TIB-2026-07-15](./TIB-2026-07-15-ci-deploy-pipeline.md) ships a bot to production when the merged
PR carries a `release-<bot>` **label**, recovered from the landed commit via `commits/{sha}/pulls`.
Nothing checks that a reviewer ever saw that intent: a label can be added by anyone with triage
rights at any point up to the merge click, and the deploy fires seconds later. The pipeline was copied
from `prime-monorepo`, which has since moved on: release intent there is a `Releases <app>` keyword
in the PR description, frozen into the squash commit and re-verified at tag time against a
post-intent owning-team approval.

Prime also designed per-app `releases/<app>` branches (its PR #4865, closed unmerged) because its
production deployer, Vercel, is token-less and decides at push time, so the gate could not run in
front of the deploy. That constraint does not exist here: **CI is the deployer**, so the gate can be
a job in front of the deploy job on `push: main`, whose workflow code is itself reviewed `main` code.

Three facts about this repo, verified while designing this:

- The squash-merge message setting is already `PR_BODY`, so the keyword lands in the commit.
- No merge queue is configured and no status checks are required on `main`, although
  `checks.yml`, `deploy-staging.yml`, and TIB-2026-07-15 assume a queue. One approving review is
  required; stale reviews are not dismissed.
- `release-slack-notify.yml` had **never run** across every release cut so far: GitHub does not fire
  `release` events for releases created with the workflow's own `GITHUB_TOKEN`.

## Goals / Non-Goals

**Goals**

- Release intent is authored once, in the PR description, as `Releases <bot>`; labels are derived.
- A bot deploys to production only if a reviewer other than the author approved the PR **after**
  the intent was added, judged at the `merged_at` snapshot so post-merge edits and retries are inert.
- Release tags become `<bot>-<PR#>`, matching prime; the release Slack post actually fires.
- One manifest enumerates CI-deployable bots instead of six hardcoded lists.
- Zero new credentials, no repository rulesets.

**Non-Goals**

- Not adopting per-bot release branches (see Alternative 1).
- Not shipping a subset of the tree per bot (see Alternative 2).
- Not turning on the merge queue or required checks the older docs assume; this design does not
  depend on either. The stale assumption is recorded here rather than acted on.
- Not changing npm publishing: `@morpho-org/quoter` versions still come from
  `bots/quoter-bot/package.json` and are independent of git tags
  ([TIB-2026-08-25](./TIB-2026-08-25-quoter-bot-npm-publishing.md)).

## Proposed Solution

**`@repo/ci-scripts`** (`packages/ci-scripts`, tsx, no build step) carries the logic, ported from
prime and trimmed:

- `release-intent/helpers.ts` — the `Releases <bot>` grammar (comma / "and" lists, `Releases
nothing`), kept byte-for-byte on prime's golden fixture so the two repos parse identically.
- `release-intent/common.ts` — replays the PR body's `userContentEdits` history to find when each
  bot's intent was added, with a cutoff at `merged_at`.
- `release-intent/gate.ts` — pure gate: latest verdict per reviewer, minus bots and the author,
  submitted at or before `merged_at`; a bot passes if some approval postdates its intent.
- `manifest.json` — `{ id, package, environments: { staging?, production } }` per CI-deployable
  bot. The `id` is the `Releases <id>` token, the release tag prefix, and the label suffix; the
  environment names are the existing GitHub Environments, including the irregular
  `crossed-books-prod`.

**`deploy-production.yml`** on `push: main` becomes three jobs:

1. `Gate` (no environment, `pull-requests: write`) reads the HEAD commit message, parses intents,
   binds the commit to the merged PR whose `merge_commit_sha` is this SHA (the subject's `(#N)` is
   never trusted), fetches reviews and body history, and evaluates the gate. Refused bots get a
   ⚠️ comment on the PR. Outputs: a matrix of authorized deploy targets, the bot ids, the PR number.
2. `Deploy` — a matrix over those targets calling `deploy-bot.yml`, job-named `<bot>`.
3. `Quoter-bot-image` — as before, gated on `quoter-bot` being authorized.

**`deploy-bot.yml`** gains `package`, `github_environment`, and `release_pr` inputs (no more shell
`case`; the quoter-bot variant folds in, on Railway CLI 5.30.4 with its 30-minute timeout) and two
follow-on jobs: `Release`, which cuts `<bot>-<PR#>` only after a successful deploy and is idempotent
on rerun (an existing tag on the same SHA is done; on another SHA it fails loud), and `Notify`, which
chains `release-slack-notify.yml` via `workflow_call`, the fix for the dead `release` trigger.

**`deploy-staging.yml`** reads the manifest's staging targets and runs the same matrix.

**`pr-release-label-sync.yml`** (thin port of prime's) reconciles `release-<bot>` labels from the
body on `opened|reopened|edited`, checking out `main` so no PR code runs under a write token.

The production `workflow_dispatch` is removed: it would bypass the gate. Re-ship or roll back with a
new PR carrying the intent. The `deploy-production` concurrency group is removed too: PR numbers need
no same-day counter, and GitHub keeps only one pending run per group, which would silently drop a
release push when a third lands (prime's rationale). Per-bot deploys still serialize inside
`deploy-bot.yml`.

**Downstream:** `publish-quoter-bot-npm.yml` proves a release by job name; it now accepts
`quoter-bot / Release` and, for runs predating this change, `Release-quoter-bot`. Its `quoter-bot-*`
tag filter and main-ancestry check are naming-agnostic. The Docker Hub `latest` gate walks tags by
descent and is unaffected.

## Considered Alternatives

### Alternative 1: Per-bot `releases/<bot>` branches (prime's PR #4865)

Production deploys from a bot-owned branch fast-forwarded only after the gate, with the environment
branch policy moved to that branch so the production `RAILWAY_TOKEN` is reachable only from a ref
the bot can move.

**Why rejected:** the branch is only a security boundary if only the automation can move it, and
that needs a ruleset bypass actor. Rulesets accept roles, teams, GitHub Apps, Dependabot, and
deploy keys, never the workflow's `GITHUB_TOKEN`. Prime's "zero new credentials" held only because
its git-bot App already existed. Here it means either an App or a deploy key, both a long-lived
static credential with production reach (a deploy key is also whole-repo write scope, a
category-wide bypass, and attributed to whoever added it). An unprotected `releases/*` is a
regression: any write user could push a commit carrying their own workflow file and reach the token.
Since CI is the deployer, the in-workflow gate closes the same gap with none of that.

### Alternative 2: Subset trees per release branch

Each release branch carries only the tree needed to build its bot.

**Why rejected:** a filtered tree is not a commit on `main`, so fast-forward auditability becomes
"trust the generator", and the main-ancestry checks in the npm and Docker Hub publishers break. pnpm
needs every importer manifest present or a re-derived lockfile (`pnpm deploy` emits an installed
directory, not source; there is no turbo here for `turbo prune`). The only gain is a smaller
`railway up` upload, obtainable more cheaply with a `pnpm --filter <bot>... run build` in each
Dockerfile.

### Alternative 3: Keep labels as the trigger, add the approval check

Read labels at push time as today and additionally require a post-label approval.

**Why rejected:** label history is only in the issue timeline API and does not survive into the
commit, so the reviewed artifact and the released artifact stay disconnected. The description is
what reviewers read, and the squash setting freezes it into the commit for free.

### Alternative 4: `<bot>-YYYY.MM.DD-N` CalVer tags retained

**Why rejected:** the same-day counter is the only reason for the workflow-level concurrency group,
which drops pending runs. PR numbers are unique and already the identifier reviewers use. The one
consumer that cared about tag shape, npm publishing, reads `package.json` instead.

## Assumptions & Constraints

- **Private, single-org repo, in-repo PRs.** The `push: main` trust model is unchanged from
  TIB-2026-07-15; the environment branch policies stay `main`.
- **Approval, not review-team ownership.** Prime's gate requires an approval from the app's
  CODEOWNERS team; this repo has one team and no CODEOWNERS file, so any non-author approval counts.
  Stale reviews are not dismissed on push, so code pushed after approval is not re-reviewed by this
  gate either; that is the existing repo setting, not something this design changes.
- **Reviews after merge are ignored** (`submitted_at <= merged_at`), as are body edits after merge.
- **Unknown tokens release nothing.** `Releases blue-liquidation` (the directory name, not the id)
  is silently no intent; the label sync makes the mismatch visible on the PR before merge.
- **Nested reusable workflows.** `deploy-production.yml` → `deploy-bot.yml` →
  `release-slack-notify.yml` is two levels; GitHub allows four.
- **Staging callers grant `contents: write`.** A called workflow's declared job permissions must
  fit the caller's grant even for jobs that end up skipped, so the staging matrix grants what the
  callee's `Release` job declares although it never runs there.

## Security

- The production token is still reachable only from a job on `refs/heads/main` in a GitHub
  Environment, exactly as before. What changes is that reaching the deploy job now requires the
  gate's verdict, computed by reviewed `main` code from GitHub's own record of reviews and body
  edits.
- The gate fails closed: an unbindable commit throws, a bot without body-history intent is refused,
  and refusal produces a visible PR comment.
- No credential was added. The label-sync job holds `pull-requests: write` only and never runs PR
  code.

## Future Considerations

- Turning on the merge queue and required status checks the older docs describe.
- A tag ruleset restricting `<bot>-*` creation to CI, closing the forged-tag vector the npm
  publisher currently compensates for with its job-proof lookup.
- Wiring the Claude-authored release-notes chain (`.claude/commands/ci-*.md`) now that the tag shape
  matches prime's.

## References

- [TIB-2026-07-15](./TIB-2026-07-15-ci-deploy-pipeline.md) — the pipeline this amends; its
  environment model and `push: main` rationale still hold.
- [TIB-2026-07-14-slack-ci-notifications](./TIB-2026-07-14-slack-ci-notifications.md) — the release
  Slack workflow now chained from `deploy-bot.yml`.
- [TIB-2026-08-14-quoter-bot-dockerhub-publishing](./TIB-2026-08-14-quoter-bot-dockerhub-publishing.md),
  [TIB-2026-08-25-quoter-bot-npm-publishing](./TIB-2026-08-25-quoter-bot-npm-publishing.md) — the
  downstream publishers; their gates are naming-agnostic apart from the job-name proof updated here.
- prime-monorepo `docs/tibs/TIB-2026-08-17-release-intent-keywords.md` and its 2026-08-20 addendum
  recording the release-branch design (PR #4865) as known-and-open.
- Implementation surface: `packages/ci-scripts/`, `.github/workflows/{deploy-production,deploy-bot,deploy-staging,pr-release-label-sync,release-slack-notify}.yml`.
