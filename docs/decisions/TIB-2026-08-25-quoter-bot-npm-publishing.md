# TIB-2026-08-25: Quoter-bot npm publishing on production release

| Field      | Value           |
| ---------- | --------------- |
| **Status** | Proposed        |
| **Date**   | 2026-08-25      |
| **Author** | @julien         |
| **Scope**  | Bot: quoter-bot |

---

## Context

[TIB-2026-08-14-quoter-bot-dockerhub-publishing](./TIB-2026-08-14-quoter-bot-dockerhub-publishing.md)
gives every quoter-bot production release a public Docker image, but running the CLI still requires
Docker or a full monorepo source build. quoter-bot is a Node CLI — for third-party maker operators
([TIB-2026-07-27](./TIB-2026-07-27-midnight-quoter-bot.md)), `npm install -g` is the native
distribution channel. Publishing to npm must keep the pipeline's posture: no long-lived credential
stored in GitHub, no new gate on release availability, and no leak of the private monorepo into a
public artifact.

## Goals / Non-Goals

**Goals**

- Publish the CLI to npm as `@morpho-org/quoter`, installing a `morpho-quoter` command, on
  quoter-bot production releases.
- Ship one self-contained artifact: a global install downloads a single ~750 kB tarball with
  **zero dependencies**.
- Store **no npm token** in GitHub — authenticate via npm trusted publishing (OIDC) with
  provenance attestation, matching the Docker Hub OIDC posture.
- Keep release availability: the npm publish gates neither the Railway deploy nor the GitHub
  release, and can only ship builds production accepted.

**Non-Goals**

- Not renaming the workspace package — `@morpho-org/quoter-bot` stays; only the published artifact
  name is user-facing.
- Not publishing an importable library: the package ships a `bin` only, no exports.
- Not publishing the other bots — quoter-bot is the public reference bot.
- Not switching Railway (or the Docker image) to consume the npm package; npm is a parallel
  artifact channel of the same commit.
- Not deriving npm versions from the CalVer release tags — npm versions are deliberate semver.

## Current Solution

`deploy-production.yml` ships a quoter-bot release as Railway deploy → CalVer tag + GitHub release
→ Docker Hub image. Nothing exists on npm: the workspace manifest is `private` with
`workspace:`/`catalog:` specifiers that no registry consumer could resolve, and `VersionService`
hardcodes `0.0.0`, so even built artifacts cannot report which release they are. Operators without
Docker must clone the monorepo and build from source.

## Proposed Solution

A standalone publish workflow that chains off the production pipeline and stages a purpose-built
package directory:

```text
push: main ──▶ Deploy production (Select ▶ Quoter-bot ▶ Release-quoter-bot ▶ Quoter-bot-image)
                                 │ workflow_run: completed
                                 ▼
               Publish quoter-bot npm ──▶ @morpho-org/quoter@<version> (latest | backfill)
               (quoter-bot-* release-tag gate; gates nothing)
```

**Published name ≠ workspace name.** The package publishes as `@morpho-org/quoter` and installs
`morpho-quoter`; the workspace package keeps its `@morpho-org/quoter-bot` name. Renaming the
workspace package would ripple through dozens of `--filter @morpho-org/quoter-bot` references in
scripts, workflows, and docs for no gain — only the published artifact name is user-facing. The
`bin` entry and the commander program name follow the published command name.

**The artifact is the existing bundle plus a generated manifest.** `scripts/pack-npm.ts`
(`pnpm --filter @morpho-org/quoter-bot run npm:pack`) stages `dist/npm/`: the self-contained
esbuild bundle renamed to `morpho-quoter.js` (asserted to open with the `#!/usr/bin/env node`
shebang the build now emits), a **generated** dependency-free manifest
(`buildNpmPackageManifest` in `scripts/npm-package.utils.ts`), the repository LICENSE, and the
CLI-focused `docs/npm-README.md`. The private workspace manifest — `workspace:`/`catalog:`
specifiers, `private` flag, workspace-only scripts — never reaches the registry. Because the
bundle is self-contained, the generated manifest declares no dependencies at all.

**Version stamping at bundle time.** `scripts/build.ts` esbuild-`define`s
`process.env.QUOTER_BOT_VERSION` to the package.json version, replacing the previously hardcoded
`0.0.0` in `VersionService`; unbundled source runs fall back to `0.0.0-dev`. Every built artifact
— npm package and Docker image alike — reports its real release version.

**Standalone `workflow_run` chain, not a `workflow_call` job.** Unlike the Docker Hub publish,
`publish-quoter-bot-npm.yml` is not called from `deploy-production.yml`: npm trusted publishing
validates the **top-level** workflow filename, so a reusable workflow would be validated against
its caller's filename. The workflow instead triggers when "Deploy production" completes.
`workflow_run` also sidesteps the GITHUB_TOKEN event-propagation restriction: the GitHub release
is cut with `github.token`, and events created by GITHUB_TOKEN do not trigger workflows, so an
`on: release` trigger would never fire. The job runs in a dedicated `quoter-bot-npm` GitHub
Environment — it holds no secrets, but scopes the OIDC token subject and carries a main-only
deployment-branch policy — with job-level concurrency serializing publishes.

**Auth — trusted publishing with provenance, no stored token.** `npm publish --provenance`
exchanges the run's GitHub OIDC token for a short-lived publish token; CI stores no npm
credential, and npm attaches a provenance attestation linking each version to this workflow run
and commit. (A granular npm automation token in an environment secret was rejected for the same
reasons as the Docker Hub static credential —
[TIB-2026-08-14](./TIB-2026-08-14-quoter-bot-dockerhub-publishing.md), Alternative 1.) One-time
bootstrap: npm cannot create a brand-new package through trusted publishing, so the first publish
is manual by a maintainer (`npm:pack` then `npm publish bots/quoter-bot/dist/npm`), after which
the trusted publisher is configured on npmjs.com — repository `morpho-org/morpho-bots`, workflow
`publish-quoter-bot-npm.yml`, environment `quoter-bot-npm`. Until then, the workflow's registry
check fails loud with the bootstrap instructions instead of dying inside the OIDC exchange.

**Gates.** Four, in order:

- _Verified release commit:_ publish only a commit that is main history, carries a `quoter-bot-*`
  release tag, and has a Deploy production run on exactly that SHA whose `Release-quoter-bot` job
  succeeded (checked through the Actions API before any working-tree code executes). Tags are
  pushable by any write collaborator; the main-owned pipeline's run history is not — so npm can
  never ship a build production did not accept, and every other completed pipeline no-ops.
- _Smoke test:_ the staged CLI must run and report exactly the staged manifest's version before it
  may be published.
- _Immutability no-op:_ published npm versions are immutable, so an already-published version
  completes as a no-op. Bumping `bots/quoter-bot/package.json#version` in the release PR is what
  opts a release into an npm publish — versions are deliberate semver, not derived from the CalVer
  release tags.
- _Dist-tags only move forward:_ npm resolves installs from dist-tags and never orders them
  itself, so a commit with a newer descendant release tag publishes under `backfill` (a rerun
  backfilling an older release, stable or prerelease), a remaining prerelease takes `next` only
  when it semver-advances the registry's current `next`, and a stable version must be
  semver-greater than the registry's current `latest` to take that tag — mirroring the Docker Hub
  latest gate. (`npm publish` always assigns a dist-tag, so skipping the tag — the Docker Hub
  behavior — is not an option; `next`/`backfill` are the npm equivalent.)

## Considered Alternatives

### Alternative 1: rename the workspace package to `@morpho-org/quoter`

Make the workspace name match the published name so the workspace manifest could publish directly.

**Why rejected:** the workspace name appears in dozens of `--filter` invocations across package
scripts, CI workflows, agent instructions, and docs; renaming is churn with no benefit because
only the published artifact name is user-facing.

### Alternative 2: publish the workspace manifest, scrubbed in place

Strip `private`, `workspace:`/`catalog:` specifiers, and workspace scripts from
`bots/quoter-bot/package.json` at publish time and publish the package directory.

**Why rejected:** scrubbing is a denylist that silently leaks whatever it forgets to strip.
Generating a minimal manifest from scratch is an allowlist — only deliberately declared fields
ship, and the private workspace manifest structurally never reaches the registry.

### Alternative 3: `workflow_call` from `deploy-production.yml` (the Docker Hub pattern)

Add a non-gating caller job to the production pipeline, like `Quoter-bot-image`.

**Why rejected:** npm trusted publishing validates the top-level workflow filename, so the
trusted-publisher binding would have to name `deploy-production.yml` — coupling publish capability
to the entire pipeline file instead of the narrow publish workflow.

## Assumptions & Constraints

- The trusted publisher configured on npmjs.com must exactly match repository
  `morpho-org/morpho-bots`, workflow filename `publish-quoter-bot-npm.yml`, and environment
  `quoter-bot-npm`; renaming or moving the workflow file breaks publishing until the npm-side
  config is updated.
- The one-time manual bootstrap publish must happen before the first CI publish; the registry
  check fails loud (E404 with instructions) until it has.
- Trusted publishing requires npm ≥ 11.5.1; the repo's pinned Node 24 ships 11.6+.
- The `quoter-bot-npm` GitHub Environment exists with a main-only deployment-branch policy. It
  holds no secrets — the trust binding lives entirely on npm's side.
- The generated manifest's `repository.url` must exactly match the GitHub repository, or
  provenance verification fails at publish time.
- The bundle stays fully self-contained. If a dependency ever stops bundling (e.g. a native
  addon), the zero-dependency manifest breaks and the packaging design must be revisited.
- Same trust model as TIB-2026-07-15: single-org repo with protected `main`; the `workflow_run`
  chain inherits runs of "Deploy production", which triggers on `push: main`. The repository is
  public — which npm provenance attestation requires.

## Security

- **No npm credential in CI at all.** The environment holds no secrets; the trust binding is the
  package's trusted-publisher configuration on npmjs.com. Whoever administers `@morpho-org/quoter`
  there (maintainer accounts, trusted-publisher settings) controls publishing — that npm admin
  surface is now release-critical, like the Docker org's OIDC connection.
- **`id-token: write` is job-scoped**; the workflow default stays `contents: read`.
- **Provenance attestations** publicly link normal-path published versions to their source commit
  and workflow run, letting consumers verify what they install. GitHub fixes `GITHUB_SHA` to the
  event commit and npm's generator records it verbatim, so a recovery publish whose event SHA is
  not the release commit (main advanced mid-pipeline, or a dispatch of an older release) publishes
  without provenance rather than attesting the wrong commit.
- **Only the bot ships.** The staged directory contains the self-contained bundle, the generated
  manifest, LICENSE, and the CLI README — no workspace source, no other bots' code, no workspace
  manifest. All runtime configuration, including keys, comes from the operator's environment;
  nothing sensitive enters the package. The package is public (`publishConfig.access: public`).

## Observability

The publish gates nothing, and because it is a separate `workflow_run` chain, a failure turns the
standalone "Publish quoter-bot npm" run red without marking the `deploy-production.yml` run —
check the publish workflow's own run list, not the pipeline's. Skipped outcomes (no release tag,
already-published version, backfill dist-tag) surface as `::notice` annotations. To verify a
release, `npm view @morpho-org/quoter` shows versions and dist-tags, and the npm package page
shows the provenance attestation.

## Future Considerations

- A release PR that forgets the version bump silently no-ops on npm, drifting the registry behind
  production. If that happens in practice, lint or automate the bump in the release path.
- Generalizing the pack-and-publish pattern if another bot gains a public CLI.

## References

- [TIB-2026-08-14-quoter-bot-dockerhub-publishing](./TIB-2026-08-14-quoter-bot-dockerhub-publishing.md)
  — the sibling artifact channel whose posture this mirrors: release-commit gating, OIDC-only
  auth, latest-only-forward, non-gating by construction.
- [TIB-2026-07-15-ci-deploy-pipeline](./TIB-2026-07-15-ci-deploy-pipeline.md) — the production
  pipeline whose completion triggers the publish.
- [TIB-2026-07-27-midnight-quoter-bot](./TIB-2026-07-27-midnight-quoter-bot.md) — the CLI being
  published.
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers) — OIDC publishing,
  provenance, and the top-level-workflow validation rule.
- [GITHUB_TOKEN event propagation](https://docs.github.com/en/actions/security-for-github-actions/security-guides/automatic-token-authentication#using-the-github_token-in-a-workflow)
  — events created with GITHUB_TOKEN do not trigger workflows, ruling out `on: release`.
- Implementation surface: `.github/workflows/publish-quoter-bot-npm.yml`,
  `bots/quoter-bot/scripts/pack-npm.ts`, `bots/quoter-bot/scripts/npm-package.utils.ts`,
  `bots/quoter-bot/scripts/npm-pack-failed.error.ts`, `bots/quoter-bot/scripts/build.ts` (shebang
  banner + version define), `bots/quoter-bot/src/application/version.service.ts`,
  `bots/quoter-bot/docs/npm-README.md`, `bots/quoter-bot/README.md` (npm publishing section),
  `.github/workflows/deploy-production.yml` (header note).

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
