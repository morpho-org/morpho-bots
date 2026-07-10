# bots

Deployment packaging for the bot use-case of the generic `morpho-bots` CLI
(`interfaces/cli`): how the one-shot ticks are wrapped into long-running services. The CLI package
itself stays unopinionated — everything that turns it into a persistent liquidation bot lives here.

- `Dockerfile` — the single bot image (all bots ship in it; `BOT`/`CHAIN_ID` select what runs).
  Build context MUST be the repo root so the bun workspace resolves.
- `docker-entrypoint.sh` — the prod persistence loop: `morpho-bots $BOT tick` every
  `TICK_INTERVAL_S` seconds, honoring the CLI's 0/1/2 exit-code contract (exit 2 crashes the
  container visibly).
- `docker-compose.blue.yml` / `docker-compose.midnight.yml` — local/self-hosted orchestration
  (blue's bundles the shared rindexer + Postgres from `services/blue-rindexer`). Run from the repo
  root: `docker compose -f bots/docker-compose.midnight.yml up`.
- `scripts/deploy-railway-{blue,midnight}.ts` — reproducible, idempotent Railway deploys:
  `bun run --filter @repo/bots deploy:railway:midnight` (see each script's header for env vars).
