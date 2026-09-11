# @repo/ci-scripts

Logic behind the release pipeline, run from GitHub Actions with `tsx` (no build step):

- `pnpm --filter @repo/ci-scripts run release-gate` — on `push: main`, turns the squash commit's
  `Releases <bot>` intent into the set of bots authorized to deploy (see
  `.github/workflows/deploy-production.yml`).
- `pnpm --filter @repo/ci-scripts run release-label-sync` — on PR events, projects the body's intent
  onto cosmetic `release-<bot>` labels.
- `pnpm --filter @repo/ci-scripts run release-manifest <stage>` — the deploy matrix for a stage.

`manifest.json` is the single list of CI-deployable bots: id (the `Releases <id>` token and release
tag prefix), workspace package, and GitHub Environment per stage. Adding a bot to CI is one entry
here plus the GitHub Environments it names. Bots absent from it (the vault bots, `quoter-signer`)
are deliberately not deployed by CI.

Rationale: `docs/decisions/TIB-2026-09-09-release-intent-gated-deploys.md`.
