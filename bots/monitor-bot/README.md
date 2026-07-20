# Monitor Bot

A NestJS service that polls Morpho Midnight REST endpoints with cursor-tracked pollers and posts
notifications to a configured Slack channel. This package currently ships the bootstrap: the NestJS
application shell, a `/health` endpoint, and the operator surface (Docker, Railway deploy).

## Status

Bootstrap only — pollers and the Slack dispatcher land in follow-up PRs.

Scope note: this bot does **protocol-activity** alerting (Midnight market events). It is not
bot-health alerting — liquidation-bot failures are covered by the BetterStack log/heartbeat
conventions (see `docs/decisions/TIB-2026-07-14-betterstack-log-forwarding.md`).

## Prerequisites

- [bun](https://bun.sh) `1.3.12` (see root `packageManager`)
- Node.js `24.14.1` (see `.nvmrc`) for tooling parity

Never commit `.env` files or credentials.

## Configuration

`PORT` and `LOG_LEVEL` are validated at startup with [t3-env](https://env.t3.gg/) + zod — a
malformed value fails the boot loudly. The `BETTERSTACK_*` vars are read at point of use by
`@repo/bot-kit`, which disables shipping/heartbeat with a warning (never a crash) when they are
missing or malformed.

| Var                          | Required | Default | Purpose                                  |
| ---------------------------- | -------- | ------- | ---------------------------------------- |
| `PORT`                       | no       | `3000`  | HTTP port for `/health`                  |
| `LOG_LEVEL`                  | no       | `info`  | `debug` \| `info` \| `warn` \| `error`   |
| `BETTERSTACK_SOURCE_TOKEN`   | no       | —       | Opt-in BetterStack log shipping (secret) |
| `BETTERSTACK_INGESTING_HOST` | no       | —       | BetterStack ingest host (with the token) |
| `BETTERSTACK_HEARTBEAT_URL`  | no       | —       | Opt-in BetterStack uptime heartbeat      |

Example `.env` shape:

```sh
PORT=3000
LOG_LEVEL=info
```

## Running Locally

```sh
nvm use
bun install
bun run --filter @morpho-org/monitor-bot start
curl localhost:3000/health
```

## Testing

Tests run under **vitest** (not `bun test` — NestJS decorator metadata needs the SWC transform):

```sh
bun run --filter @morpho-org/monitor-bot test
```

Note: the root `bun test` deliberately excludes this package (`[test].pathIgnorePatterns` in the
root `bunfig.toml`) — bun's runner would otherwise shim the `vitest` imports and run these files
without the vitest config. Inside `bots/monitor-bot/`, use `bun run test`, not bare `bun test`.

## Running With Docker Compose

```sh
cd bots/monitor-bot
docker compose up --build
curl localhost:3000/health
```

## Deploying to Railway

```sh
RAILWAY_PROJECT_ID=… bun run --filter @morpho-org/monitor-bot deploy:railway
```

- `RAILWAY_ENVIRONMENT` (default `production`) selects the environment; non-production service
  names get an environment prefix.
- `DEPLOY_ONLY=1` re-ships the already-provisioned service without touching variables (CI path,
  needs only `RAILWAY_TOKEN` + `RAILWAY_PROJECT_ID`).

## How It Works

### Startup

`src/index.ts` validates env (`src/config/env.ts`), builds the shared `@repo/bot-kit` JSON-lines
logger, and boots the NestJS application with a `LoggerService` adapter so framework logs share
the same structured format. `enableShutdownHooks()` wires SIGTERM/SIGINT into Nest's graceful
shutdown lifecycle.

### Health

`GET /health` returns `{ status: 'ok', uptime_s }` — used by Docker/Railway probes and the
integration checks in later PRs.

## Important Operational Notes

- The bot keeps no on-disk state; everything is re-derived at boot.
- Structured log lines are JSON on stderr; BetterStack shipping is opt-in via env.
