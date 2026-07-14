# TIB-2026-07-14: pared-down Slack CI notifications

| Field      | Value      |
| ---------- | ---------- |
| **Status** | Accepted   |
| **Date**   | 2026-07-14 |
| **Author** | @hayden    |
| **Scope**  | Repo-wide  |

---

## Context

[TIB-2026-04-16](./TIB-2026-04-16-bootstrap-curator-bots.md) ported CI from `morpho-apps` but
deliberately left out the source repo's PR/Slack/team-label workflows: _"Worth porting once team
collaborators exist; premature for a solo-owner repo"_ (Future Considerations). curator-bots has no
Slack notifications today — PR and release activity is invisible outside GitHub.

The sibling `prime-monorepo` has an elaborate Slack CI system (a TypeScript `@repo/ci-scripts`
package driving PR threading, reviewer DMs, an approval "needle" reaction, team/firehose channel
routing, git-ref dedup locks, and a Claude-authored release-notes chain). That is more machinery
than this repo needs. This TIB reverses the deferred item with a pared-down, store-free version.

## Goals / Non-Goals

**Goals**

- Lightweight PR and release visibility in Slack for a repo that had none.
- Store-free: no database, no external state service.
- Match repo CI conventions — SHA-pinned actions, thin YAML.

**Non-Goals** (explicitly **not** ported from `prime-monorepo`)

- Reviewer DMs.
- The approval-"needle" reaction and review-policy logic.
- Team/firehose channel routing and pr-team detection.
- Git-ref dedup locks.
- The auto-tag + Claude-release-notes chain.
- Any `@repo/ci-scripts` TypeScript package.

## Proposed Solution

Two GitHub Actions workflows, each an `actions/github-script` step with an inline JS body that
hand-rolls `fetch` to the Slack Web API (`chat.postMessage`). No compiled package.

**`.github/workflows/pr-slack-notify.yml`** — posts basic PR notifications to one Slack channel
(`vars.SLACK_PR_CHANNEL_ID`):

- A parent message when a PR is opened or marked ready-for-review; threaded replies on
  review-submitted and on merge/close.
- Requested reviewers are @-mentioned in the channel, resolved through
  `.github/slack-user-map.json` (a flat `login` → SlackID map).
- Threading state (the Slack parent `ts`) is persisted in the **PR body** as an HTML-comment
  marker `<!-- slack-thread-ts:... -->` — no database.
- Triggers: `pull_request` (`opened`, `ready_for_review`, `review_requested`, `closed`),
  `pull_request_review` (`submitted`), and `workflow_dispatch`.
- Fail-soft: a Slack error logs a warning via `core.warning` but never fails the job — CI
  notifications must never block a merge.

**`.github/workflows/release-slack-notify.yml`** — on GitHub `release: published`, converts the
release body from GitHub markdown to Slack mrkdwn and posts it to a second channel
(`vars.SLACK_RELEASE_CHANNEL_ID`). Decoupled from any tagging automation — curator-bots has no
release workflow and no git tags today, so `release: published` is the only trigger.

**Credentials.** `secrets.SLACK_BOT_TOKEN` is a bot with `chat:write`, invited to both channels.
Channel IDs live in repo variables (`vars.*`), not secrets and not committed YAML.

## Considered Alternatives

### Alternative 1: A `@repo/ci-scripts` TypeScript package

`prime-monorepo`'s approach — run the notification logic as a bun-executed package.

**Why rejected:** heavier than warranted; the inline-YAML footprint is small enough for a
two-workflow feature. **Trade-off acknowledged:** inline JS is invisible to oxlint, typecheck,
knip, and `bun test`, so it must be held to CONVENTIONS.md §General Code Style by hand.

### Alternative 2: `pull_request_target` trigger

Would grant a write token and repo secrets even on fork PRs.

**Why rejected:** privilege-escalation footgun. We use `pull_request` and check out
`github.event.pull_request.base.sha` with `persist-credentials: false`, reading only the trusted
base copy of the user map, never PR-controlled content. Acceptable because curator-bots is a
private single-org repo — all PRs originate in-repo, so the token and `SLACK_BOT_TOKEN` are
available under `pull_request` anyway.

### Alternative 3: An external store for thread `ts`

A database or blob to hold the Slack parent `ts` per PR.

**Why rejected:** the PR-body HTML-comment marker is store-free and self-healing enough at this
scale.

### Alternative 4: Full release automation

Port `prime-monorepo`'s `tag-releases.yml` (CalVer per-app tags + `repository_dispatch` +
Claude-written notes).

**Why rejected/deferred:** curator-bots has no release process yet; `release: published` is the
simplest decoupled trigger. The fuller chain can be added later (see Future Considerations).

## Assumptions & Constraints

- curator-bots is a private single-org repo; all PRs originate in-repo. If the repo goes public or
  accepts fork PRs, the `pull_request` trust model here must be revisited.
- The Slack bot is invited to both channels and holds `chat:write`.
- `vars.SLACK_PR_CHANNEL_ID` and `vars.SLACK_RELEASE_CHANNEL_ID` are set as repo variables.

## Security

The threat-model delta is small:

- New `secrets.SLACK_BOT_TOKEN`.
- `pull-requests: write` permission is requested (needed to PATCH the PR-body thread marker).
  `contents: write` is **deliberately not** requested — dropping git-ref locks removed the need.
- Base-SHA checkout (`persist-credentials: false`) avoids executing PR-controlled code; the
  workflow reads only the trusted base copy of `.github/slack-user-map.json`.
- Slack `text` interpolation of user-controlled content (PR title, logins) escapes `&`, `<`, `>`
  to prevent `<!channel>` / `<@id>` injection.
- `.github/slack-user-map.json` contains no secrets — public GitHub logins plus workspace-internal
  Slack IDs.

## Future Considerations

- The fuller release chain (per-app CalVer tags, `repository_dispatch`, Claude-authored release
  notes) can be layered on once curator-bots gains a release process.
- If the inline JS grows past what is comfortable to hand-maintain against CONVENTIONS.md, revisit
  extracting a `@repo/ci-scripts`-style package so lint/typecheck/knip/tests cover it.

## References

- [TIB-2026-04-16-bootstrap-curator-bots](./TIB-2026-04-16-bootstrap-curator-bots.md) — the
  deferral this reverses (Future Considerations: "Linear + PR automation").
- Source system in `prime-monorepo`: `.github/workflows/pr-slack-notify.yml`,
  `.github/workflows/claude-write-release-notes.yml`, `packages/ci-scripts`.
