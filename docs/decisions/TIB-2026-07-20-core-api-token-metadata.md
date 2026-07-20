# TIB-2026-07-20: core-API token metadata for monitor-bot alert amounts

| Field      | Value            |
| ---------- | ---------------- |
| **Status** | Proposed         |
| **Date**   | 2026-07-20       |
| **Author** | @jinmel          |
| **Scope**  | App: monitor-bot |

---

## Context

monitor-bot's one-line alerts label amounts with a token symbol scaled by its decimals, but the
`/markets` and `/books` sweeps only yield token **addresses** — nothing the bot talks to serves
ERC-20 identity. The original metadata path (`TokenMetadataLoader`, `createCoreClient`,
`CORE_API_URL`, the generated core-API types) was removed in commit `81481b2` because the core
API's `/v0/tokens` sat behind a CloudFront 401 with no advertised auth scheme: every lookup was
doomed, warns accumulated per market refresh, and nothing consumed the result. That commit's
message deferred re-adding it "if that access ever materializes."

Access has materialized. The core API docs' authentication section names
`x-api-key: <MORPHO_API_KEY>`, and a provisioned key was verified live on 2026-07-20:

| Probe                                                              | Result                                              |
| ------------------------------------------------------------------ | --------------------------------------------------- |
| `https://private.api.morpho.org/v0/tokens/8453:0x8335…2913` + key  | 200 — `name`/`symbol`/`decimals`                    |
| `https://private.api.morpho.org/core/v0/tokens/…` (`/core` prefix) | 404                                                 |
| `https://api.morpho.org` (public host, either path)                | routes not served — hosts the OpenAPI document only |

This TIB records the resurrection — a reversal of `81481b2`, adapted from that commit's parent to
the now-documented auth — on branch `jinmel/monitor-bot-core-token-metadata`.

## Goals / Non-Goals

**Goals**

- Label alert amounts with the real symbol and scale by the real decimals for **every** token the
  swept markets reference, not just a hardcoded pair.
- Keep metadata strictly a presentation nicety: no metadata failure may fail a market sweep,
  shrink the polled scope, or drop an alert — the raw-units fallback stays.
- Render denominations for the live midnight-base pair from the first tick, before — or without —
  any core-API access.
- Handle `MORPHO_API_KEY` as a secret, following the `SLACK_BOT_TOKEN` convention.

**Non-Goals**

- On-chain metadata reads. monitor-bot stays chainless (no viem clients, no RPC config) per
  [TIB-2026-07-20-monitor-bot-nestjs-stack](./TIB-2026-07-20-monitor-bot-nestjs-stack.md).
- Displaying `name` in alerts — it is stored per the API contract, informational only.
- Fetching metadata for tokens outside recorded markets — the loader resolves exactly the
  registry's missing set.
- Sharing the core client beyond monitor-bot.

## Current Solution

Post-`81481b2`, `TokenRegistry` passively maps market id → loan/collateral addresses from the
sweeps the bot already makes, but no metadata source exists at all, so `tokenAmount` always takes
the raw-units path (`1000000 assets`) — every alert, every token, indefinitely.

## Proposed Solution

The removed core-API path is resurrected with four changes relative to the removed design.

### 1. Authenticated core client

`createCoreClient` (`src/core/client.ts`) targets `CORE_API_URL` — default
`https://private.api.morpho.org`, the only host/path combination the probes found serving — and
sends `MORPHO_API_KEY` as `x-api-key`. The key is a secret read at point of use in
`polling.module.ts` (same convention as `SLACK_BOT_TOKEN`, never stored on the parsed env object)
and is attached by **both** clients: the core API requires it, the Midnight API tolerates it, so
one knob covers both services without per-service key plumbing.

### 2. `KNOWN_TOKENS` as boot seeds, not the metadata source

`TokenRegistry` gains a `byToken` map seeded at construction with `KNOWN_TOKENS` — Base USDC and
WETH, the loan/collateral tokens the live midnight-base books carry today. Seeds are the no-key
floor: alerts render denominations from the first tick even when `MORPHO_API_KEY` is unset. The
loader fills every other token after each market sweep; the seeds are deliberately **not** the
sole metadata source (see Alternative 1).

### 3. Loader kept separate from the passive registry

`TokenMetadataLoader` (`src/tokens/metadata.ts`) is the one place that reaches the network for
token data; the registry stays a passive store that never performs I/O, so injecting it into every
poller cannot add latency or a failure mode to a tick. After each market sweep (`MarketDirectory`
discovery and fixed-scope hydration alike) the loader fetches
`GET /v0/tokens/{chain_id}:{address}` for the registry's `missingTokens()` set at concurrency 8.
Token identity is immutable, so a success is cached for the process lifetime; a failure is logged
and swallowed, leaving the token missing so the next sweep retries — a metadata outage degrades
alerts to raw units and can never fail a market sweep.

### 4. Symbol-required storage, nullable name

`TokenInfo` gains `name: string | null`, stored as returned. `symbol` is nullable upstream too,
but the loader **rejects** tokens whose API `symbol` is null: the formatter labels every amount
with `symbol` — the abbreviated-address fallback was deliberately removed — so a symbol-less token
stays on the honest raw-units degradation path instead of being stored unlabeled. Responses are
runtime-narrowed before storage (integer `chain_id`, address shape, `decimals` bounds) because the
generated types are compile-time only and the core API is a separate service on a separate deploy
cycle; a drifted `decimals` would otherwise flow straight into every formatted amount.

## Considered Alternatives

### Alternative 1: hardcoded token table as the sole metadata source

Seed `KNOWN_TOKENS` and stop — zero extra requests, no key to provision.

**Why rejected:** every new market listing would need a code change and redeploy, and any unseeded
token degrades to raw units forever. The registry already computes exactly which tokens lack
metadata, so the incremental cost of fetching them is one polite batch per sweep.

### Alternative 2: on-chain `name`/`symbol`/`decimals` reads

A viem multicall against the token contracts needs no Morpho key and is authoritative.

**Why rejected:** monitor-bot is deliberately chainless — no viem clients, no signer, no RPC
configuration — per
[TIB-2026-07-20-monitor-bot-nestjs-stack](./TIB-2026-07-20-monitor-bot-nestjs-stack.md).
Introducing an RPC dependency for a presentation nicety breaks that boundary.

### Alternative 3: fetch metadata lazily at alert-format time

Resolve a token on first use inside the poller tick instead of after the sweep.

**Why rejected:** it puts I/O on the tick path — the exact failure mode the registry's passivity
exists to prevent. Loading after the sweep keeps pollers synchronous consumers of an in-memory
map, and the sweep is already the moment new tokens appear.

## Assumptions & Constraints

- The `x-api-key` scheme and the un-prefixed `/v0/tokens` path on `private.api.morpho.org` stay
  stable — both verified live on 2026-07-20 only. If the public host starts serving the routes or
  the auth scheme changes, the `CORE_API_URL` default and client headers need revisiting.
- A provisioned `MORPHO_API_KEY` exists in each deploy environment. Without one the bot still
  runs, but only seeded tokens resolve and each unresolved token warns once.
- Token identity is immutable — process-lifetime cache, no TTL. A token migration surfaces as a
  new address, i.e. a new registry entry.
- `KNOWN_TOKENS` values are correct (they match the verified API responses); a wrong seeded
  `decimals` would silently misformat amounts with no failing request to flag it.
- The `generate:core` script reads the OpenAPI document from
  `https://api.morpho.org/core/docs/swagger/json` — the docs host, not the serving host. Doc-host
  moves break regeneration, not the running bot.

## Observability

| Event                  | Level                 | When                                                                                                                                                                                                                                                             |
| ---------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tokens.resolved`      | info                  | A sweep resolved ≥1 token; carries `requested`/`resolved`/`unresolved` counts.                                                                                                                                                                                   |
| `tokens.unresolved`    | warn                  | A sweep resolved zero of a non-empty missing set — a misconfiguration signal. An info line named "resolved" permanently reporting zero would read as success.                                                                                                    |
| `tokens.lookup_failed` | warn once, then debug | Per-token fetch failure. Only the first failure per token warns — a never-resolving token retries every sweep by design, which would otherwise emit ~2,300 warns/day for 16 tokens. A success clears the entry, keeping the set bounded to tokens still failing. |
| `tokens.unparsable`    | warn once, then debug | A 200 body failed runtime narrowing (drifted `decimals`, identity mismatch, null `symbol`, malformed address). Same per-token de-escalation as `tokens.lookup_failed` — a permanently unparsable token is refetched every sweep too.                             |

## Security

- `MORPHO_API_KEY` is a secret: read at point of use from `process.env`, never placed on the
  validated env object, never logged. It lives on Railway per the deploy-pipeline convention
  (secrets stay on Railway).
- The key is sent to both API hosts. Both defaults are Morpho-operated, but `CORE_API_URL` and
  `MIDNIGHT_API_URL` are overridable — a misconfigured base URL would send the key to that host.
  Config review, not code, is the guard here.
- Core-API responses are untrusted input and are runtime-narrowed before storage (see Proposed
  Solution §4).

## Future Considerations

- **One request per token** (concurrency 8) is accepted, not solved: the missing set is ~16 tokens
  today and resolves once per process in the common case. A batch tokens endpoint, if the API ever
  advertises one, would replace the per-token loop.
- **`KNOWN_TOKENS` retention**: once a key is provisioned in every environment the seeds are
  redundant beyond first-tick rendering. They are kept deliberately as the no-key floor; dropping
  them would re-open the degradation this TIB closes for the live pair.

## References

- Commit `81481b2` — `refactor(monitor-bot): remove core-api token metadata fetching (#9)`, the
  removal this TIB reverses; the resurrected code comes from its parent.
- Commit `daadcfe` — `feat(monitor-bot): resolve token denominations for alert amounts`, which
  introduced the passive `TokenRegistry` this builds on.
- [TIB-2026-07-20-monitor-bot-nestjs-stack](./TIB-2026-07-20-monitor-bot-nestjs-stack.md) — the
  DI structure and the chainless constraint that rules out on-chain reads.
- [TIB-2026-07-20-producer-escaped-slack-mrkdwn](./TIB-2026-07-20-producer-escaped-slack-mrkdwn.md)
  — the one-line alert format whose `$size $symbol` headline consumes this metadata.
- Morpho core API OpenAPI document — `https://api.morpho.org/core/docs/swagger/json`, consumed by
  `bun run generate:core` into `src/generated/core-api.ts`.
