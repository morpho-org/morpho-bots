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

| Var                           | Required | Default                  | Purpose                                          |
| ----------------------------- | -------- | ------------------------ | ------------------------------------------------ |
| `PORT`                        | no       | `3000`                   | HTTP port for `/health`                          |
| `LOG_LEVEL`                   | no       | `info`                   | `debug` \| `info` \| `warn` \| `error`           |
| `MIDNIGHT_API_URL`            | no       | `https://api.morpho.org` | Midnight API base URL                            |
| `MARKET_IDS`                  | no       | — (auto-discover)        | Comma-separated market ids; empty = all active   |
| `MARKETS_REFRESH_MS`          | no       | `600000`                 | Market-discovery cache TTL                       |
| `FILTER_MIN_ASSETS`           | no       | `0`                      | Min size (base units) for an alert; 0 = off      |
| `FILTER_USERS`                | no       | — (all users)            | Comma-separated position-owner allowlist         |
| `POLL_CRON_TAKE_ORDERS`       | no       | `*/30 * * * * *`         | Take-orders poller cadence (cron, seconds field) |
| `POLL_CRON_REPAYS`            | no       | `*/30 * * * * *`         | Repays poller cadence                            |
| `POLL_CRON_COLLATERAL`        | no       | `*/30 * * * * *`         | Collateral poller cadence                        |
| `POLL_CRON_LIQUIDATIONS`      | no       | `*/15 * * * * *`         | Liquidations poller cadence                      |
| `REPAYS_INCLUDE_SECONDARY`    | no       | `false`                  | Also treat debt closed via trade as a repay      |
| `COLLATERAL_INCLUDE_WITHDRAW` | no       | `true`                   | Also alert on collateral withdrawals             |
| `BETTERSTACK_SOURCE_TOKEN`    | no       | —                        | Opt-in BetterStack log shipping (secret)         |
| `BETTERSTACK_INGESTING_HOST`  | no       | —                        | BetterStack ingest host (with the token)         |
| `BETTERSTACK_HEARTBEAT_URL`   | no       | —                        | Opt-in BetterStack uptime heartbeat              |

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

### Polling

The generic polling foundation lives in `src/polling/`. Each endpoint poller extends
`Poller<TCursor, TItem>` and supplies only `fetch` (cursor → items + next cursor) and `toAlerts`;
the base class owns the invariant tick pipeline (`cursor → fetch → toAlerts → dispatch → save`).
`PollerRegistrar` registers one `cron` job per poller (`waitForCompletion` — an overlapping tick
is skipped, never run concurrently) and awaits every in-flight tick on shutdown.

Locked-in semantics:

| Guarantee              | Mechanism                                                       |
| ---------------------- | --------------------------------------------------------------- |
| At-least-once delivery | Cursor saves only after a successful dispatch                   |
| Failed-request restart | A failed tick never advances the cursor; the next tick retries  |
| No overlapping ticks   | `cron` `waitForCompletion` skips ticks while one runs           |
| Graceful shutdown      | Registrar holds its own job refs and awaits `stop()` on SIGTERM |
| Configurable period    | `cron` expression is an instance property, sourced from config  |

Cursors are held in-process only (`InMemoryCursorStore`), matching the repo's
cross-tick-state philosophy — nothing is persisted to disk and API truth wins on restart. The
`CursorStore` interface keeps a file/db-backed store a drop-in replacement.

Until the Slack dispatcher lands, alerts go through `LogAlertDispatcher` — one structured
`alert` log line each.

### Market transaction pollers

Four poller instances share `MarketTransactionsPoller`, differing only in `event_types` and
cadence: **take-orders** (`lend`, `borrow`), **repays** (`exit_borrow_primary`, plus
`exit_borrow_secondary` when `REPAYS_INCLUDE_SECONDARY=true`), **collateral**
(`supply_collateral`, plus `withdraw_collateral` unless disabled — withdrawal is the risk
signal), and **liquidations** (`partial_liquidation`, `full_liquidation`).

Each tick enumerates markets (`MarketDirectory`: fixed `MARKET_IDS` or all active markets,
TTL-cached), then per market queries
`/v0/midnight/markets/{id}/transactions?sort_direction=asc&created_at_gte={watermark}` walking
pagination cursors, dedupes by stable item id at the (inclusive) watermark second, and advances a
**per-market** watermark — a global watermark would skip items in slower-indexed markets.

With no saved position (first tick, restart, new market) a poller anchors at _now_ — history is
never replayed; the skipped window is logged as `poll.anchor`. Every fetch re-covers a 60s
overlap window below the watermark with stable-id dedupe, so items indexed up to 60s late are
still caught exactly once (later than that is missed by design — the documented assumption
boundary). Alerts pass a `TransactionFilter` (size threshold on the per-type amount; user
allowlist matched on the affected account — for liquidations both `account` and `borrower`, so a
watched borrower's liquidation can never be missed), except **bad-debt liquidations**
(`bad_debt > 0` or `pure_bad_debt_realization`) which bypass all filters and post as `critical` —
bad debt is socialized to lenders and is the curator signal.

Note on `FILTER_MIN_ASSETS` denominations: the compared amount is loan-token base units for
trades, **collateral-token** base units for collateral events, and face-value units for primary
exits / repaid units for liquidations — one global threshold across markets with heterogeneous
decimals is a blunt instrument; per-poller thresholds are a known follow-up. Amounts render as
raw base units (this API exposes no token metadata); every alert carries a basescan tx link.

## Important Operational Notes

- The bot keeps no on-disk state; everything is re-derived at boot.
- Structured log lines are JSON on stderr; BetterStack shipping is opt-in via env.
