# TIB-2026-09-07: OpenTelemetry stack for the quoter bot

| Field      | Value                                              |
| ---------- | -------------------------------------------------- |
| **Status** | Proposed                                           |
| **Date**   | 2026-09-07                                         |
| **Author** | @julien                                            |
| **Scope**  | Bot: quoter-bot · Package: `@repo/telemetry` (new) |

---

## Context

The quoter bot's observability today is one stream: sanitized JSON monitoring records on
stdout/stderr, optionally shipped to Better Stack
([TIB-2026-07-14](./TIB-2026-07-14-betterstack-log-forwarding.md),
[TIB-2026-08-23](./TIB-2026-08-23-quoter-bot-monitoring-events.md)). That stream answers "what did
the bot decide" well, but two operational questions stay hard:

- **Where does cycle time go?** `cycle.completed.durationMs` is one number per market per cycle.
  When a ladder cycle degrades from 2 s to 20 s there is no per-request view separating a slow RPC
  provider, Morpho API pagination, receipt waits, or mutation-queue contention — the class of
  problem behind the transient-provider-read retries (PR #168).
- **How do we aggregate without log math?** Better Stack metric expressions over log fields work
  but are the only aggregation surface, and the org's wider observability (the Vercel apps'
  sources) is already OTel-shaped.

TIB-2026-07-14 rejected OpenTelemetry _as a log-shipping vehicle_ ("OTel is trace/metric-shaped and
heavy for plain JSON logs") — a judgment about logs that this TIB does not revisit. Traces and
metrics are exactly the shape OTel is for, and
[TIB-2026-05-14](./TIB-2026-05-14-kill-switch-bot.md) explicitly deferred an OTel stack to "its own
follow-up TIB once one curator running v1 actually asks for it". That ask has now landed for the
quoter bot.

One production constraint dominates the design: the shipped image runs a single self-contained
esbuild bundle (`bots/quoter-bot/scripts/build.ts`, `bundle: true`; no `node_modules` in the
runtime stage). OTel auto-instrumentation that patches modules through `require-in-the-middle` /
`import-in-the-middle` cannot work there. Undici instrumentation is the exception: it observes
Node's `diagnostics_channel`, which survives bundling — and viem plus the bot's own HTTP JSON
reads all go through global `fetch` (undici).

## Goals / Non-Goals

**Goals**

- Per-cycle traces with child spans for every outbound RPC/API request, and OTel metrics for the
  quantities the monitoring contract already defines — exported to any OTLP endpoint the operator
  configures.
- The same safety contract as Better Stack shipping: strictly opt-in, strictly best-effort (no
  telemetry failure may interrupt or halt quoting), strictly sanitized (no credentials, URLs with
  embedded keys, or raw error text ever leave the process).
- A runnable local stack for development, and nothing provisioned or claimed for production.

**Non-Goals**

- Replacing Better Stack log shipping, the heartbeat, or any part of the monitoring-event
  contract. Logs stay logs; TIB-2026-07-14's rejection of OTel-for-logs stands.
- OTel _logs_ export (the third signal). The stdout contract and Better Stack cover it.
- Auto-instrumenting the AWS SDK (KMS / quoter-signer Lambda calls). It rides `node:http`, which
  the bundle cannot patch; those calls stay inside the cycle span's duration, unattributed.
- Dashboards, alerts, or a hosted collector. Like Better Stack, the backend is the operator's.

## Current Solution

`@repo/observability` mirrors already-sanitized monitoring records into the Better Stack logger
and heartbeat. There is no trace or metric pipeline; no `@opentelemetry/*` package exists anywhere
in the workspace.

## Proposed Solution

A new standalone package **`@repo/telemetry`** (following
[TIB-2026-08-04](./TIB-2026-08-04-extract-quoter-bot-shared-packages.md)'s one-package-per-concern
rule rather than growing `@repo/bot-kit` or `@repo/observability`), consumed by the quoter bot:

1. **`startBotTelemetry`** — the process-global pipeline, registered at the top of `index.ts`
   before any application work. Enabled only when the standard `OTEL_EXPORTER_OTLP_ENDPOINT` (or a
   signal-specific variant) is set; otherwise nothing registers and the OTel API stays no-op.
   Traces and metrics gate independently. Export is OTLP/HTTP with JSON encoding — the
   protobuf-free exporter tree, chosen because `strictDepBuilds` makes every new transitive
   dependency a review surface and JSON needs none of `protobufjs`. Startup, export, and shutdown
   failures never throw past this boundary; shutdown flushes with a 10-second bound.
2. **Undici auto-instrumentation with unconditional URL redaction.** Every outbound
   `fetch`/undici request becomes a client span and feeds the semconv
   `http.client.request.duration` histogram. The instrumentation's `startSpanHook` overrides every
   URL-bearing attribute at span creation: `url.full` is reduced to its origin, `url.path` to
   `[redacted]`, `url.query` to empty — RPC providers commonly embed API keys in the path, so
   redaction is unconditional rather than per-host allowlisted. Failures need the same treatment:
   the instrumentation records `exception.message`/`exception.stacktrace` events and puts
   `error.message` into the span status, so a sanitizing span processor wraps the batch exporter
   and strips every `exception` event and status message on span end — failure identity survives
   as the error status code plus low-cardinality `error.type`/`errorName` attributes. Wire-level
   tests assert the exported OTLP payload of both a successful and a failing request contains no
   path, query, or free-form error material.
3. **`withActiveSpan`** — a small wrapper around each cycle body: the three monitor services
   (setup, bootstrap, ladder) and the one-shot CLI paths (`setup-check`, `bootstrap`, `ladder`
   without `--monitor`) all produce a `quoter-bot.cycle` root span tagged `workflow` that parents
   the request spans via `AsyncLocalStorage` context. On a thrown failure it records only an
   error status plus the injected `operatorErrorName` classification, and an injected predicate
   flips the same error status for handled failures the cycle returns instead of throwing (a
   `failed`/`halted` market result, a not-ready readiness report) — raw error text never reaches
   a span either way. This is the one deliberate departure from TIB-2026-08-23's "no second emit
   seam" non-goal, confined to call sites wrapping existing invocations.
4. **Metrics derived from the shipped record stream.** `createTelemetryRecordObserver`
   (quoter-bot infrastructure) mirrors the same allowlisted monitoring records the Better Stack
   path ships into counters, histograms, and gauges — the log stream and the metric stream cannot
   disagree because they are the same records. On the `quoter_bot.*` instruments, attributes are
   restricted to the contract's safe grouping dimensions plus two derived discriminators (`type`,
   `phase`); `txHash`, `groupId`, and `errorName` never become attributes. The semconv
   `http.client.request.duration` histogram is the one instrument outside that vocabulary: it
   carries the standard bounded HTTP client dimensions (method, status code, server address and
   port, URL scheme, and a class-of-error `error.type`) — per-host request latency is the point
   of that metric, and none of those dimensions can carry a path, query, or free-form text. The
   observer swallows every failure, inheriting `writeCycle`'s telemetry-cannot-halt-quoting
   invariant.
5. **Verbose parity.** `enhanceVerboseArgv` gains a `hasAdditionalSink` flag so a configured OTel
   endpoint auto-enables the safe `--verbose` stream exactly as Better Stack configuration does —
   without it, an OTel-only deployment would export nearly empty metrics.
6. **Local stack.** A `docker compose --profile otel up` service runs `grafana/otel-lgtm`
   (collector, Tempo, Prometheus, Loki, Grafana) pinned by tag; the bot points at it with one
   environment variable. Production deployments set the same variables through the existing helm
   `env` / Railway variable surfaces — the un-validated observability channel, not the validated
   config schema, matching the `BETTERSTACK_*` precedent.

## Considered Alternatives

### Alternative 1: `@opentelemetry/sdk-node` with auto-instrumentations

The turnkey NodeSDK plus `auto-instrumentations-node`.

**Why rejected:** module-patching instrumentation is dead code inside the esbuild bundle, and
`sdk-node` drags every exporter flavor (gRPC, proto, Zipkin) into a tree this repo would have to
audit under `minimumReleaseAge`/`strictDepBuilds`. The manual composition is ~100 lines and every
registered component is one the bot actually uses.

### Alternative 2: Prometheus scrape endpoint instead of OTLP push

Expose `/metrics` and let infrastructure scrape.

**Why rejected:** the bot deliberately exposes no ports (headless helm service, no `EXPOSE`), and
adding an HTTP listener to a key-holding process widens its attack surface for less capability —
scrape gives metrics only, no traces. OTLP push also matches Railway, where inbound scraping is
awkward.

### Alternative 3: Metrics-only (no spans, no service edits)

Derive metrics from the record stream and skip tracing entirely, touching zero application code.

**Why rejected:** it answers "how often" but not "where did the time go", which is the question
logs already cannot answer. The tracing cost is three wrapped call sites and one no-op-safe
helper; without a cycle root span the undici spans would be one-request orphan traces.

### Alternative 4: OTel logs as a Better Stack replacement

Ship the monitoring records as OTLP logs and drop the loglayer transport.

**Why rejected:** relitigates TIB-2026-07-14 with no new force. The stdout JSON Lines contract and
Better Stack dashboards are load-bearing operator interfaces.

## Assumptions & Constraints

- Node's global `fetch` (undici) carries all latency-relevant outbound traffic except AWS SDK
  calls; if a future adapter switches HTTP stacks, its requests silently vanish from traces (not
  from cycle spans or metrics).
- `@opentelemetry/api` resolves to exactly one copy (enforced by the catalog pin), so the global
  provider registration in `@repo/telemetry` is the one quoter-bot instruments against.
- OTLP/HTTP+JSON is accepted by the operator's collector (true of the OTel Collector and the
  bundled lgtm stack; a protobuf-only gateway would need the proto exporter — a deliberate
  follow-up dependency review, not a config change).
- Raw `*_assets`/`*_bps` magnitudes fit double-precision floats well enough for dashboards;
  beyond 2^53 they lose precision but keep scale. Exact values remain in the log stream.

## Observability

This TIB is itself the observability change. Its own operability surface: `otel.started`,
`otel.start-failed`, `otel.shutdown-failed` lifecycle records, plus rate-limited
`otel.diagnostic` records that reduce SDK-internal errors to a classification token — never the
message, because exporter diagnostics can embed endpoint URLs (which may carry access tokens) and
response bodies. The full metric/span inventory is documented in the bot README's "OpenTelemetry
observability" section.

## Security

- **Egress:** a configured OTLP endpoint is a new outbound destination carrying operational
  metadata (hosts contacted, timing, market IDs, sizes — no keys, no calldata, no raw errors).
  The endpoint and its headers are operator-supplied secrets: they are read only by the exporter
  and never logged.
- **Redaction:** URL attributes are redacted at span creation (before any buffering), and
  exception events plus status messages are stripped at span end, before the batch processor
  buffers the span; the unit and wire-level tests pin both.
- **Dependency surface:** ~20 new `@opentelemetry/*` packages plus `import-in-the-middle`/
  `require-in-the-middle` (inert here), all install-script-free under `strictDepBuilds`, all
  subject to `minimumReleaseAge`. No gRPC, no protobuf.
- **Runtime posture:** no listening sockets are added; the pipeline is push-only and opt-in.

## Future Considerations

- Other bots can adopt `startBotTelemetry` unchanged; their record-to-metric mappings are
  per-bot by design (each bot owns its event contract).
- Span coverage inside a cycle (read / plan / reconcile phases) if origin-level request spans
  prove too coarse; the cycle span already includes shared mutation-queue wait.
- The proto exporter, only if a curator's collector rejects JSON.

## References

- [TIB-2026-07-14: Better Stack log forwarding](./TIB-2026-07-14-betterstack-log-forwarding.md)
- [TIB-2026-08-23: Quoter-bot monitoring events](./TIB-2026-08-23-quoter-bot-monitoring-events.md)
- [TIB-2026-08-04: Extract quoter-bot shared packages](./TIB-2026-08-04-extract-quoter-bot-shared-packages.md)
- [TIB-2026-05-14: Kill-switch bot](./TIB-2026-05-14-kill-switch-bot.md) (OTel deferred to a follow-up TIB)
- [grafana/docker-otel-lgtm](https://github.com/grafana/docker-otel-lgtm)
