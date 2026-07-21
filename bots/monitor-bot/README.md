# Monitor Bot

A NestJS service that polls Morpho Midnight REST endpoints with state-tracked pollers and posts
notifications to a configured Slack channel.

## Status

Feature-complete for v1: market transaction pollers (takes, repays, collateral, liquidations),
the make-orders poller, and Slack delivery.

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
| `MORPHO_API_KEY`              | no       | —                        | Sent as `x-api-key` on API requests (secret)     |
| `CORE_API_URL`                | no       | `https://private.api…`   | Core API base for `/v0/tokens` metadata          |
| `MARKET_IDS`                  | no       | — (auto-discover)        | Comma-separated market ids; empty = all active   |
| `MARKETS_REFRESH_MS`          | no       | `600000`                 | Market-discovery + token-metadata cache TTL      |
| `FILTER_MIN_ASSETS`           | no       | `0`                      | Min size (base units) for an alert; 0 = off      |
| `FILTER_USERS`                | no       | — (all users)            | Comma-separated position-owner allowlist         |
| `POLL_CRON_TAKE_ORDERS`       | no       | `*/30 * * * * *`         | Take-orders poller cadence (cron, seconds field) |
| `POLL_CRON_REPAYS`            | no       | `*/30 * * * * *`         | Repays poller cadence                            |
| `POLL_CRON_COLLATERAL`        | no       | `*/30 * * * * *`         | Collateral poller cadence                        |
| `POLL_CRON_LIQUIDATIONS`      | no       | `*/15 * * * * *`         | Liquidations poller cadence                      |
| `REPAYS_INCLUDE_SECONDARY`    | no       | `false`                  | Also treat debt closed via trade as a repay      |
| `COLLATERAL_INCLUDE_WITHDRAW` | no       | `true`                   | Also alert on collateral withdrawals             |
| `POLL_CRON_MAKE_ORDERS`       | no       | `*/30 * * * * *`         | Make-orders poller cadence                       |
| `SLACK_CHANNEL`               | no       | — (log-only alerts)      | Slack channel id for alerts                      |
| `SLACK_BOT_TOKEN`             | no       | —                        | Slack bot token (secret, with `SLACK_CHANNEL`)   |
| `WALLETS_CSV_PATH`            | no       | — (empty store)          | Attio wallet-CRM CSV export, loaded at boot      |
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

`dev` is the same program with `LOG_LEVEL=debug`, surfacing per-tick lines (`poll.tick`,
`poll.books_listed`) and one `midnight.response` per API call. It is **not** a dry run — it polls
the live API and posts to the configured Slack channel exactly as `start` does.

```sh
bun run --filter @morpho-org/monitor-bot dev
```

The `.env` must sit in `bots/monitor-bot/`, not the repo root: bun loads `.env` from the working
directory, and `--filter` runs the script with the package as its cwd. Unset `SLACK_CHANNEL` for
a run that logs alerts instead of posting them.

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
`Poller<TState, TItem>` and supplies only `fetch` (state → items + next state) and `toAlerts`;
the base class owns the invariant tick pipeline (`state → fetch → toAlerts → dispatch → save`).
`PollerRegistrar` registers one `cron` job per poller (`waitForCompletion` — an overlapping tick
is skipped, never run concurrently) and awaits every in-flight tick on shutdown.

The pollers at a glance (cadences are the defaults; each is a cron expression overridable via its
env var):

| Event name                                                                               | Poller name    | Poll cadence                          | REST endpoint                                                                          |
| ---------------------------------------------------------------------------------------- | -------------- | ------------------------------------- | -------------------------------------------------------------------------------------- |
| `lend`, `borrow`                                                                         | `take-orders`  | every 30 s (`POLL_CRON_TAKE_ORDERS`)  | `GET /v0/midnight/markets/{market-id}/transactions`                                    |
| `exit_borrow_primary` (+ `exit_borrow_secondary` when `REPAYS_INCLUDE_SECONDARY=true`)   | `repays`       | every 30 s (`POLL_CRON_REPAYS`)       | `GET /v0/midnight/markets/{market-id}/transactions`                                    |
| `supply_collateral` (+ `withdraw_collateral` unless `COLLATERAL_INCLUDE_WITHDRAW=false`) | `collateral`   | every 30 s (`POLL_CRON_COLLATERAL`)   | `GET /v0/midnight/markets/{market-id}/transactions`                                    |
| `partial_liquidation`, `full_liquidation`                                                | `liquidations` | every 15 s (`POLL_CRON_LIQUIDATIONS`) | `GET /v0/midnight/markets/{market-id}/transactions`                                    |
| make-offer snapshot diff (`created` / `updated` / `closed` — no API event type)          | `make-orders`  | every 30 s (`POLL_CRON_MAKE_ORDERS`)  | `GET /v0/midnight/books` → `GET /v0/midnight/books/{market-id}/{side}/takeable-offers` |

Locked-in semantics:

| Guarantee              | Mechanism                                                       |
| ---------------------- | --------------------------------------------------------------- |
| At-least-once delivery | State saves only after a successful dispatch                    |
| Failed-request restart | A failed tick never saves state; the next tick retries          |
| No overlapping ticks   | `cron` `waitForCompletion` skips ticks while one runs           |
| Graceful shutdown      | Registrar holds its own job refs and awaits `stop()` on SIGTERM |
| Configurable period    | `cron` expression is an instance property, sourced from config  |

#### Cursors vs boot snapshots

Cross-tick state comes in two kinds. The base class depends on the neutral `PollerStateStore`
shape; the two concrete stores have separate types and separate DI tokens because they mean
different things — and because only one of them would ever be safe to persist.

| Store               | Holds                         | Used by             | Persistable?      |
| ------------------- | ----------------------------- | ------------------- | ----------------- |
| `CursorStore`       | A resume position (watermark) | Transaction pollers | Yes, in principle |
| `BootSnapshotStore` | The previous observation      | `make-orders`       | **No — never**    |

A **cursor** is a position you fetch forward from: the transaction pollers keep
`{lastCreatedAt, seenIds}` per market and ask the API for everything after it. `InMemoryCursorStore`
is in-process only today, matching the repo's cross-tick-state philosophy, but the interface keeps
a file/db-backed store a drop-in replacement if replay-across-restarts is ever wanted.

A **boot snapshot** is not a cursor and calling it one was a mistake worth correcting. The book has
no change feed — only an active-only view of what is true right now — so there is no position to
resume from. The state _is_ the previous observation, and items come from diffing it. Its lifetime
is exactly one process lifetime: the first tick after boot establishes a silent baseline, and a
restart drops it so the next boot re-baselines. Persisting one would be a bug, not an upgrade: a
stale snapshot diffed against live data reports every change made while the process was down as if
it had just happened.

#### Token registry

`/markets/{id}/transactions` items carry only a `market_id` — no token address anywhere in the
envelope — so the transaction pollers cannot tell what their `assets` and `units` amounts are
denominated in. `TokenRegistry` closes that gap: `market id → { loanToken, collaterals[] }`,
recorded from `/markets` and `/books` responses the bot already fetches, so it costs no extra
requests. It is injected into every poller via `PollerDependencies.tokens`.

ERC-20 identity (name, symbol, decimals) comes from the Morpho **core** API: after each market
sweep, `TokenMetadataLoader` fetches `GET /v0/tokens/{chain_id}:{address}` on `CORE_API_URL`
(default `https://private.api.morpho.org`, authenticated with `MORPHO_API_KEY` as `x-api-key`)
for every token the registry references but has no metadata for. The two live midnight-base
loan/collateral tokens are seeded in code, so
alerts render denominations from the first tick even before — or without — that fetch.

The registry itself is a passive store and never performs I/O, so injecting it cannot add latency
or a failure mode to a tick. A miss returns `null` and the caller falls back to raw units rather
than throwing — token metadata is a presentation nicety, alerting is the job that must not break.

`collaterals[]` lists what a market **accepts**, usually more than one token, so it cannot identify
which token a given event moved. Collateral-denominated amounts (`supply_collateral`,
`withdraw_collateral`, a liquidation's `seized_assets`) must use the event's own `data.collateral`.

Setting `MARKET_IDS` fixes the polled scope but does **not** eliminate API calls: one `market_ids`
request per `MARKETS_REFRESH_MS` still hydrates the registry, because ids alone do not say what a
market is denominated in. If that request fails the configured ids are still returned, so a
metadata outage never shrinks the polled scope, and the cache is cleared so the next tick retries.

Alert delivery is pluggable behind the `ALERT_DISPATCHER` DI token. Every alert is one sentence:

```text
($size $symbol $action)[explorer tx link] by ($address)[explorer address link] on midnight-base at $time
ℹ️ 20M USDC lend by 0x958e…1917 on midnight-base at 2026-07-19 22:58:35 UTC
```

Amounts render compact (`20M`, `1.5K`) in the token resolved through the `TokenRegistry`, falling
back to raw base units + `assets`/`units` when metadata is missing. Liquidations read `… of
<borrower>` instead of `by`. Producers build the mrkdwn (`Alert.text`, links included) and escape
every interpolated API-sourced string (`& < >`) via `alerts/mrkdwn.ts` so content can never inject
a `<!channel>` or `<@id>` mention; the plain `Alert.title` is the notification fallback and the
log line.

With `SLACK_CHANNEL` + `SLACK_BOT_TOKEN` set, `SlackDispatcher` posts to Slack via
`chat.postMessage` (bot token, so the channel is env-configurable; the bot needs the `chat:write`
scope and must be invited to the channel). Severity maps to a leading emoji (ℹ️ / ⚠️ / 🚨);
≤10 alerts per message keeps Slack's block limit clear; 429s honor `Retry-After`. A Slack failure
(network, `ok:false`) logs `slack.error` AND throws — the poller keeps its state and re-sends the
same window next tick (at-least-once; the alert `key` is the dedupe handle if consumers need it).
Setting exactly one of channel/token fails the boot. With neither set, alerts go through
`LogAlertDispatcher` — one structured `alert` log line each.

### Market transaction pollers

Four poller instances share `MarketTransactionsPoller`, differing only in `event_types` and
cadence: **take-orders** (`lend`, `borrow`), **repays** (`exit_borrow_primary`, plus
`exit_borrow_secondary` when `REPAYS_INCLUDE_SECONDARY=true`), **collateral**
(`supply_collateral`, plus `withdraw_collateral` unless disabled — withdrawal is the risk
signal), and **liquidations** (`partial_liquidation`, `full_liquidation`).

A filled offer is one on-chain Take but surfaces as two API items — the buyer's `lend` and the
seller's `borrow`. Legs whose trade-scoped fields all agree fold into a single alert (`… lend by
<buyer> + … borrow by <seller>`, each leg keeping its own attributed amount), kept when either leg
passes the filter. A counterparty leg that is an exit event instead, or one indexed late into a
different tick, still alerts on its own — merging never drops a leg.

Each tick enumerates markets (`MarketDirectory`: fixed `MARKET_IDS` or all active markets,
TTL-cached), then per market queries
`/v0/midnight/markets/{id}/transactions?sort_direction=asc&created_at_gte={watermark}` walking
pagination cursors, dedupes by stable item id at the (inclusive) watermark second, and advances a
**per-market** watermark — a global watermark would skip items in slower-indexed markets.

### Make-order poller

The `make-orders` poller reads the **book**, not a maker allowlist. Each tick lists
`/v0/midnight/books` (active markets only — past maturities excluded; `MARKET_IDS` narrows it via
the `ids` filter, otherwise the cursor is walked to sweep everything), then expands each market's
populated sides through `/v0/midnight/books/{id}/{side}/takeable-offers` to individual signed
offers. A side with no price levels is skipped only if it was also empty last tick — levels are
aggregated _executable_ liquidity from a different endpoint than the offers, and takeable-offers
retains non-executable offers with `units: 0`, so a side can report zero levels while its offers
still stand. Skipping unconditionally would close every bucket on it and re-open them next tick.

Offers are off-chain EIP-712 signatures with no server-side id and no change feed, so the poller
**diffs snapshots**. Identity is `(market, side, maker, group, tick)` — the fields that survive
the cancel-and-re-sign a maker performs to change an offer; offers sharing those fields are one
bucket with summed caps. Alert-worthy changes are new buckets, signed-cap changes
(`max_units`/`max_assets`), and disappearances (cancelled / expired / fully consumed —
indistinguishable in a snapshot). Expiry rolls and the takeable `units` field are deliberately
ignored: offers re-sign constantly, and takes are already covered by the transaction pollers.
Make-order alerts carry no tx link (nothing is on-chain until an offer is taken).

Boundaries worth knowing:

- The first tick per market is a quiet baseline — no boot-time spam of the standing book.
- A market that leaves the book listing (matured, delisted, or a transient gap) has its snapshot
  forgotten rather than reported as a wall of `closed` alerts, and re-baselines quietly if it
  returns. Changes during such a gap are missed.
- `takeable-offers` is unpaginated and trims to the best-priced 1000. A side at that limit is
  treated as a **failed market** (snapshot carried, retried, `poll.offers_capped` logged) rather
  than diffed — a truncated tail would fabricate `closed`/`created` pairs every tick.
- A truncated book listing aborts the whole tick (snapshot untouched) for the same reason.
- `FILTER_MIN_ASSETS` compares loan-token assets, and **binds narrowly here**. The books list
  response carries only the **top 3 levels per side**, so a unit-capped offer (`max_assets` = 0)
  can be sized only when its tick is among those 3 — otherwise it is passed through the filter
  rather than dropped (a wrong drop loses an alert permanently; a wrong pass is only noise). Most
  `closed` events are unpriced for this reason, since a bucket usually vanishes precisely because
  its tick drained. Asset-capped offers always size exactly. Making the filter bind everywhere
  needs full-depth levels (`books/{id}?depth=`, one request per market) — deferred, as the filter
  defaults to off.
- A created-and-fully-consumed-between-polls offer is missed by design — its take still shows in
  the tx pollers.

With no saved position (first tick, restart, new market) a poller anchors at _now_ — history is
never replayed; the skipped window is logged as `poll.anchor`. Every fetch after the anchor tick
re-covers a 60s overlap window below the watermark with stable-id dedupe (bounded — old ids
expire from the seen-set as the watermark advances), so items indexed up to 60s late are still
caught exactly once (later than that is missed by design — the documented assumption boundary). Alerts pass a `TransactionFilter` (size threshold on the per-type amount; user
allowlist matched on the affected account — for liquidations both `account` and `borrower`, so a
watched borrower's liquidation can never be missed), except **bad-debt liquidations**
(`bad_debt > 0` or `pure_bad_debt_realization`) which bypass all filters and post as `critical` —
bad debt is socialized to lenders and is the curator signal.

Note on `FILTER_MIN_ASSETS` denominations: the compared amount is loan-token base units for
trades, **collateral-token** base units for collateral events, and face-value units for primary
exits / repaid units for liquidations — one global threshold across markets with heterogeneous
decimals is a blunt instrument; per-poller thresholds are a known follow-up. Alert amounts render
in human units via the `TokenRegistry` (raw base units when unresolved); every transaction alert
links its basescan tx and acting address.

## Important Operational Notes

- The bot keeps no on-disk state; everything is re-derived at boot.
- Structured log lines are JSON on stderr; BetterStack shipping is opt-in via env.
