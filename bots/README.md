# bots

Deployment packaging for the bot use-case of the generic `morpho-bots` CLI
(`tools/cli`): how the one-shot ticks are wrapped into long-running services. The CLI package
itself stays unopinionated — everything that turns it into a persistent liquidation bot lives here.

- `Dockerfile` — the single bot image (all bots ship in it; `BOT`/`CHAIN_ID` select what runs).
  Build context MUST be the repo root so the bun workspace resolves. The image AOT-builds both the
  CLI (`bun run --filter @repo/cli build` → `tools/cli/dist/main.js`) and the queue daemon
  (`bun run --filter @repo/queued build` → `services/queued/dist/main.js`) so the lens bytecode is
  baked in and spawns pay no soltag/solc cost — "warm by construction", no cache to prime.
- `docker-entrypoint.sh` — supervises the image's TWO processes. (1) A background supervisor keeps the
  per-chain `queued` transaction-queue daemon alive (`bun /repo/services/queued/dist/main.js --chain
$CHAIN_ID`), restarting it on transient exits and, on a misconfig exit 2, writing a fatal sentinel
  and stopping. (2) The foreground persistence loop runs the three-stage pipeline
  `bun dist/main.js $BOT $SOURCE_OP | … $TRANSFORM_OP | … queue` every `TICK_INTERVAL_S` seconds
  (`SOURCE_OP`/`TRANSFORM_OP` default to the liquidation pair `unhealthy-positions`/`liquidate`; which
  ops run is deployment policy). The `queue` stage is a thin client relaying records to the daemon over
  a Unix socket. stdout carries JSON-Lines records; all logs go to stderr. The loop inspects
  `PIPESTATUS` per stage under the CLI's 0/1/2 contract: any stage exiting 2 crashes the container
  visibly (`loop.fatal`), any other nonzero re-loops (transient — including a `queue` exiting 1 while
  the daemon is still booting). The loop also crashes the container (exit 2) if it finds the daemon's
  fatal sentinel. A `SIGTERM`/`SIGINT` is forwarded to the daemon so it drains and persists before
  exit. Terminal outcomes (confirmed/reverted/dropped) no longer reach the pipe's stdout — the daemon
  appends them to `$MORPHO_BOTS_HOME/queued/outcomes-<chainId>.jsonl` on the `/data` volume
  (`tail -f` it to watch settlement). Set `QUEUED_DRY_RUN=true` to disarm the daemon: it runs the full
  dedupe→re-sim→fee pipeline and emits `would_submit` without ever touching the signer.
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
