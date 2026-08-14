# TIB-2026-08-14: Quoter-bot Docker Hub image publishing on production release

| Field      | Value           |
| ---------- | --------------- |
| **Status** | Proposed        |
| **Date**   | 2026-08-14      |
| **Author** | @julien         |
| **Scope**  | Bot: quoter-bot |

---

## Context

[TIB-2026-07-15-ci-deploy-pipeline](./TIB-2026-07-15-ci-deploy-pipeline.md) ships quoter-bot to
production via `railway up`: a `release-quoter-bot` label on a merged PR (or a manual dispatch)
triggers the Railway deploy and, on success, a CalVer GitHub release. Railway builds
`bots/quoter-bot/Dockerfile` internally from uploaded source, so no public artifact of a release
exists — third-party operators of the public reference maker bot
([TIB-2026-07-27](./TIB-2026-07-27-midnight-quoter-bot.md);
[TIB-2026-08-12](./TIB-2026-08-12-quoter-bot-kms-signing-middleware.md) makes third-party
reproducibility an explicit goal) must build from source, and there is no immutable image record of
what a release shipped. Publishing to a public registry must not weaken the pipeline's posture:
deploy-only CI with no long-lived credentials stored in GitHub.

## Goals / Non-Goals

**Goals**

- Publish `morphoorg/quoter` to Docker Hub on every quoter-bot production release, tagged with the
  immutable release commit hash plus a moving `latest`.
- Store **no long-lived Docker Hub credential** in GitHub — authenticate by exchanging the run's
  GitHub OIDC token.
- Keep release availability: the image push gates neither the Railway deploy nor the GitHub
  release.
- Fit the existing pipeline's conventions — the `release-quoter-bot` label selector as the single
  entry point, per-concern GitHub Environments with a main-only branch policy, SHA-pinned actions,
  thin reusable `workflow_call` YAML.

**Non-Goals**

- Not publishing images for the other bots — quoter-bot is the public reference bot; the
  liquidators and crossed-books stay Railway-internal.
- Not a staging image channel: staging deploys on every `main` commit push no images; only
  production releases publish.
- Not switching Railway to deploy from the published image. Railway keeps building from uploaded
  source; the Docker Hub image is a parallel artifact of the same commit, not the deploy source.
- Not changing the image itself — `bots/quoter-bot/Dockerfile` is built as-is (runner-native
  `linux/amd64`, no multi-arch).

## Current Solution

`deploy-production.yml`'s `Select` job recovers the merged PR's labels; `release-quoter-bot` gates
the `Quoter-bot` job, which calls `deploy-quoter-bot-production.yml` (`railway up`, deploy-only);
`Release-quoter-bot` cuts the CalVer tag + GitHub release only on deploy success. The image Railway
builds never leaves Railway; nothing publishes to a registry.

## Proposed Solution

A publish-only reusable workflow plus one non-gating caller job. The image ships as a **parallel
channel** of the existing production release:

```text
push: main ──▶ Select ──┬─▶ Quoter-bot ──────▶ Release-quoter-bot
(release-quoter-bot     │   (Railway deploy)   (CalVer tag + GitHub release)
 label, or dispatch)    └─▶ Quoter-bot-image
                            (Docker Hub push — gates nothing)
```

**Reusable publish workflow.** `.github/workflows/publish-quoter-bot-dockerhub.yml` is a
`workflow_call` taking `ref`. It checks out `ref`, fail-loud preflights the environment
configuration (missing vars or secret fail up front instead of surfacing late as an opaque
invalid-reference push error), resolves the checked-out commit with `git rev-parse HEAD` — so the
tag is the built commit even if a branch/tag ref is passed — then builds
`bots/quoter-bot/Dockerfile` with **path context = repository root** (the Dockerfile requires root
context so pnpm workspace packages resolve, and the action's default Git context would rebuild the
triggering ref instead of `inputs.ref`) and pushes:

- `morphoorg/quoter:<release commit sha>` — an immutable, greppable mapping from image to source,
  also stamped as OCI labels `org.opencontainers.image.revision` / `.source`;
- `morphoorg/quoter:latest` — tracks the newest release.

Concurrency is declared **job-level, not workflow-level**, because GitHub ignores workflow-level
`concurrency` in called workflows (same pattern as `deploy-bot.yml`); the
`publish-quoter-bot-dockerhub` group serializes pushes with `cancel-in-progress: false` so
`latest` cannot land out of order across overlapping runs.

**Caller job.** `Quoter-bot-image` in `deploy-production.yml` reuses the existing `quoter_bot`
selector flag, so the `release-quoter-bot` label — and the `workflow_dispatch` path, which
synthesizes the same label — stays the single entry point for "a release is expected". It runs in
parallel with the Railway deploy job. Because **a called workflow's permissions are capped by the
caller job's grant**, the job explicitly grants `contents: read` + `id-token: write`; it passes
`secrets: inherit` because environment secrets only populate in a reusable workflow when the
callee declares `environment:` **and** the caller inherits secrets
([actions/runner#1490](https://github.com/actions/runner/issues/1490), already documented on the
Railway jobs).

**Auth — OIDC exchange, no static credential.** `docker/login-action` v4.5+ exchanges the run's
GitHub OIDC token for a short-lived Docker Hub access token through the Docker organization's OIDC
connection: `username` is the org (`DOCKER_USERNAME`), there is **no password input**, and the
connection is selected by the `DOCKERHUB_OIDC_CONNECTIONID` env var. CI therefore stores no
long-lived Docker Hub credential; Docker-side rulesets on the connection bind which
repository/branch claims are accepted. The exchanged token's expiry is raised to 1800 s via
`DOCKERHUB_OIDC_EXPIREIN` because the default 300 s is shorter than the pnpm install + workspace
build that runs between login and push.

**Environment scoping.** A dedicated `quoter-bot-dockerhub` GitHub Environment holds secret
`DOCKERHUB_OIDC_CONNECTIONID` and vars `DOCKER_USERNAME` (`morphoorg`) / `DOCKER_REPOSITORY`
(`quoter`), following the repo's per-concern environment pattern (like `quoter-bot-production` for
Railway). Its deployment-branch policy is restricted to `main`, keeping the OIDC exchange
unreachable from arbitrary PR branches — the same load-bearing property the Railway environments
rely on.

**Non-gating by construction.** `Release-quoter-bot` still `needs:` only the Railway deploy, and
the deploy does not depend on the image job. A Docker Hub outage cannot block a production
release; conversely an image can publish even when the Railway deploy fails. That asymmetry is
accepted: the GitHub release — cut only on deploy success — remains the source of truth for "what
runs in production".

## Considered Alternatives

### Alternative 1: static Docker Hub access token in an environment secret

Store a PAT/organization access token as a GitHub secret and pass it to `docker/login-action` as a
password.

**Why rejected:** a long-lived push-capable credential living in GitHub, with rotation burden and
a broader blast radius if leaked. The OIDC connection keeps the trust binding on Docker's side
(repo/branch rulesets) and leaves CI holding only a connection identifier.

### Alternative 2: publish on `release: published`

Trigger a standalone publish workflow from the GitHub release that `Release-quoter-bot` cuts.

**Why rejected:** the label selector in `deploy-production.yml` is the existing single entry point
for "a release is expected", already covers the `workflow_dispatch` path, and keeps the pipeline
in one file. A release trigger would also sequence the image behind the Railway deploy instead of
in parallel with it.

### Alternative 3: gate the GitHub release on the image push

Make `Release-quoter-bot` need `Quoter-bot-image` as well as the deploy.

**Why rejected:** couples release cutting to Docker Hub availability — a registry outage would
block tagging a deploy that already succeeded.

## Assumptions & Constraints

- The Docker organization's OIDC connection exists and its rulesets accept only this repository
  (and `main`); `DOCKERHUB_OIDC_CONNECTIONID` identifies it.
- `docker/login-action` ≥ v4.5 for the OIDC exchange (pinned at v4.6.0).
- Same trust model as TIB-2026-07-15: private single-org repo, `push: main` trigger, main-only
  environment branch policy — revisit if fork PRs become possible.
- The image build must finish inside the 1800 s token expiry (and the job's 30-minute timeout); if
  the workspace build outgrows this, raise `DOCKERHUB_OIDC_EXPIREIN`.
- The published image and the Railway deployment are **separate builds of the same commit** — same
  source guaranteed, bit-identical images not.

## Security

- **No static registry credential in CI.** The only stored value, `DOCKERHUB_OIDC_CONNECTIONID`,
  selects the connection; possession alone does not grant push — the exchange requires a GitHub
  OIDC token whose claims satisfy the Docker-side rulesets. It is still kept as an environment
  secret behind the main-only branch policy.
- **The trust boundary moves to the Docker org's connection configuration.** Whoever administers
  the OIDC connection and its rulesets controls who may push `morphoorg/quoter`; that Docker Hub
  admin surface is now release-critical.
- **`id-token: write` is job-scoped.** Only the `Quoter-bot-image` caller job (and the callee's
  `Publish` job) may mint OIDC tokens; the workflow default stays `contents: read`.
- **The image is public.** The Dockerfile bakes in source and build outputs only; all runtime
  configuration — including keys — is injected from the environment at deploy time and never
  enters the image.

## Observability

Because the job gates nothing, a failed push does not block the release: the only signal is the
failed `Quoter-bot-image` job turning the `deploy-production.yml` run red while the deploy and
release still complete. There is no dedicated alert. To verify a release's image, resolve the
release tag's commit and `docker pull morphoorg/quoter:<sha>`, or inspect the image's OCI
`revision` label.

## Future Considerations

- **Multi-arch (`linux/arm64`)** if third-party operators ask; today the push is runner-native
  `linux/amd64` only.
- **Mirroring the CalVer release tag onto the image** (`quoter-bot-YYYY.MM.DD-N`): the tag is
  computed in `Release-quoter-bot` only after deploy success, so mirroring it would sequence the
  image behind the deploy — cutting against the parallel-channel design. Deferred.
- **Generalizing to a per-bot publish workflow** (mirroring `deploy-bot.yml`) if other bots gain
  public images.
- **Deploying Railway from the published image** would make the running service bit-identical to
  the public artifact; deliberately out of scope today.

## References

- [TIB-2026-07-15-ci-deploy-pipeline](./TIB-2026-07-15-ci-deploy-pipeline.md) — the release
  pipeline this TIB extends (not supersedes): label selector, per-concern environments, main-only
  branch policy, CalVer releases.
- [TIB-2026-07-27-midnight-quoter-bot](./TIB-2026-07-27-midnight-quoter-bot.md) — the bot whose
  image this publishes.
- [TIB-2026-08-12-quoter-bot-kms-signing-middleware](./TIB-2026-08-12-quoter-bot-kms-signing-middleware.md)
  — keeps the architecture reproducible by third-party operators of the public reference bot.
- Implementation surface: `.github/workflows/publish-quoter-bot-dockerhub.yml`,
  `.github/workflows/deploy-production.yml` (`Quoter-bot-image` job), `bots/quoter-bot/Dockerfile`,
  `bots/quoter-bot/README.md` (deployment section).
- [actions/runner#1490](https://github.com/actions/runner/issues/1490) — environment secrets in
  reusable workflows require callee `environment:` + caller `secrets: inherit`.
- [docker/login-action](https://github.com/docker/login-action) — OIDC connection sign-in
  (v4.5+).

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
