# bots

Deployment packaging for the bot use-case of the generic `morpho-bots` CLI
(`interfaces/cli`): how the one-shot ticks are wrapped into long-running services. The CLI package
itself stays unopinionated — everything that turns it into a persistent liquidation bot lives here.

- `Dockerfile` — the single bot image (all bots ship in it; `BOT`/`CHAIN_ID` select what runs).
  Build context MUST be the repo root so the bun workspace resolves. The image AOT-builds the CLI
  (`bun run --filter @repo/cli build` → `interfaces/cli/dist/main.js`) so the lens bytecode is baked
  in and per-tick spawns pay no soltag/solc cost — "warm by construction", no cache to prime.
- `docker-entrypoint.sh` — the prod persistence loop. Each tick runs the three-stage pipeline
  `bun dist/main.js $BOT $SOURCE_OP | … $TRANSFORM_OP | … queue` every `TICK_INTERVAL_S` seconds;
  `SOURCE_OP`/`TRANSFORM_OP` default to the liquidation pair `unhealthy-positions`/`liquidate` and
  can be overridden to run a different behavior (which ops run is deployment policy). stdout carries
  JSON-Lines records (the queue's outcome lines land in container logs) and all logs go to stderr.
  It inspects `PIPESTATUS` per stage under the CLI's 0/1/2 contract: any stage exiting 2 crashes the
  container visibly (`loop.fatal`), any other nonzero re-loops (transient).
- `docker-compose.blue.yml` / `docker-compose.midnight.yml` — local/self-hosted orchestration
  (blue's bundles the shared rindexer + Postgres from `services/blue-rindexer`). Run from the repo
  root: `docker compose -f bots/docker-compose.midnight.yml up`.
- `scripts/deploy-railway-{blue,midnight}.ts` — reproducible, idempotent Railway deploys:
  `bun run --filter @repo/bots deploy:railway:midnight` (see each script's header for env vars).

## Signing agent (opt-in)

The CLI ships a keyless-queue option: `morpho-bots signer` runs a policy-enforcing signing daemon
(the sole key holder) on a Unix socket, and a `queue` with `SIGNER_SOCKET` set signs through it
instead of reading a local key. The compose files and `docker-entrypoint.sh` are unchanged — they
still run the local-key default (`LIQUIDATOR_PRIVATE_KEY` on the queue). Wiring the agent into prod
as a sidecar sharing a socket volume is deferred alongside the shelved Railway pipeline migration.
