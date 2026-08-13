# TIB-2026-07-27: Midnight ladder quoter-bot bot — v0

| Field      | Value                |
| ---------- | -------------------- |
| **Status** | Proposed             |
| **Date**   | 2026-07-27           |
| **Author** | @devatom             |
| **Scope**  | App: midnight-quoter |

---

## Context

Midnight needs durable two-sided liquidity through its bootstrap window. The current operational
fallback is the V-1 manual quoter-bot UI: a human chooses the target rate, ladder shape, market
set, credit top-ups, and cancellation action, while the UI constructs and executes the offers. That
surface is useful for investigation and emergency operation, but it cannot run the reference
strategy unattended.

V0 is deliberately a reference implementation rather than a competitive quoter. Its role is
to:

- keep allowlisted Midnight books quoted on both sides;
- acquire enough credit to make the credit-backed side of the book usable;
- track a slow-moving external rate rather than optimize for latency;
- remain close to breakeven and within the Market Services-agreed loss budget; and
- ship as an open-source implementation and strategy that third parties can fork, operate, and
  eventually use to replace Morpho as the default liquidity provider.

The delivery target for V0 is **Friday, July 31, 2026**. At least one human-readable progress update
must be posted to the Linear project every day while V0 is in flight. The wider product exit review
is at the end of October 2026: the expected state by then is two-sided Midnight markets throughout
the bootstrap window, losses inside the agreed budget, and credible third-party adoption of the
public implementation.

The initial engineering sketch proposed actively taking 10,000 USDC of offers to acquire 10,000
credits, then placing a double ladder around a static 5% target. Product iteration changed that
bootstrap into a credit-acquiring make offer while keeping the regular two-sided ladder present.
Only the temporary top-up offer is discounted.

The static bootstrap is passive after publication: its hardcoded rate remains until the offer is
filled, invalidated, or the credit target is reached. The variable-rate bootstrap is actively
maintained: every hour it recomputes the designated Blue market's six-hour average, invalidates the
previous bootstrap offer, and publishes its replacement.

This TIB records that revised V0 and its process, safety, architecture, and open-source release
boundaries.

## Goals / Non-Goals

**Goals**

- Run three isolated application workflows together in one bot runtime: `setup-check`, `bootstrap`,
  and `ladder`.
- Match the pragmatic hexagonal architecture already used by `midnight-crossed-books`: pure domain
  decisions, application-owned workflows and ports, infrastructure adapters, constructor
  injection, a manual composition root, and a thin entrypoint.
- Check the maker's setup before quoting: loan-asset allowance, ratifier authorization on Midnight,
  supported chain and deployed contracts, market allowlist and maturity, and gas balance.
- Ship two target-rate implementations:
  - a default variable-rate implementation derived from a designated Morpho Blue reference market's
    accrual-aware supply-share value over six hours using historical RPC reads; and
  - a static implementation for the rate at which the operator is willing to acquire credit.
- Reject stale, incomplete, or out-of-bounds reference rates. The default hard range is 2%–8% APR,
  configurable through environment variables or `quoter-bot.yaml` / `quoter-bot.yml` selected
  by working-directory discovery or `--config`.
- Publish a temporary bootstrap offer with a negative premium until the credit target is met, while
  maintaining the ordinary bid and ask ladders from the first quote cycle.
- Serialize every bootstrap and ladder invalidation/sign/publication through one blocking
  `MakeService`, including a prospective-book check that rejects inverted spreads with a typed
  `NEGATIVE_SPREAD` error except for the explicitly evidenced bootstrap/ladder overlap described
  below.
- Support explicit startup cleanup of every maker offer or one group, plus opt-in cleanup of both
  strategy namespaces through on-chain invalidation transactions during graceful shutdown, followed
  by a terminal report.
- Reconcile the desired quote set against chain and Mempool truth on every cycle. Restarts must not
  depend on a database or local state.
- Support the V-1 ladder inputs: center/target rate, spread, step increment, rung count, size skew,
  total exposure per side, target exposure per market, and shared-rung or per-book grouping.
- Quote at an hourly-ish configurable cadence and only re-center after the reference moves beyond a
  configured tolerance.
- Re-read credit at least every minute because ladder fills can satisfy the bootstrap target
  concurrently.
- Enforce balance, credit, cost-basis, exposure, rate, maturity, and explicit-market bounds before
  publishing an offer.
- Provide enough structured logging for a human to report daily fills, inventory, reference rate,
  ladder state, and estimated P&L without deploying the V2 monitoring system.
- Ship V0 as an open-source reference implementation with a public strategy description,
  reproducible setup and deployment instructions, example configuration, security policy, and
  legally reviewed disclaimers.

**Non-Goals**

- A competitive, latency-sensitive, or profit-optimizing strategy.
- Automatic rollover into the next maturity. Rollover remains an explicit manual action.
- Automatic market discovery. Adding a book is an allowlist change and explicitly enables
  bootstrap behavior for that book.
- Automatic position-health management in V0. The setup-check port reserves this check, but it is
  implemented only when collateralized/debt-bearing operation requires it.
- A treasury multisig, delegated funding contract, custom bounded-offer ratifier, or managed key
  service. Those are V1 and gate any material capital increase.
- Slack alerting, dashboards, or automated daily reporting. Those are V2.
- Cross-market hedging, debt-aware optimization, or more sophisticated inventory algorithms. Those
  are V3.
- The V-1 quoter-bot UI. It remains the manual stopgap and operator escape hatch.

## Current Solution

V-1 provides manual ladder construction and execution through the UI. A human chooses the rate and
inventory action and remains responsible for deciding when to re-center, top up credit, cancel, or
roll to another maturity.

The repository already contains `midnight-crossed-books`, whose architecture is the model for this
bot:

- an application service owns each workflow and declares narrow consumer-owned ports;
- pure domain services own deterministic matching and calculations;
- provider clients and mappings stay in infrastructure;
- `bootstrap.ts` is the manual composition root; and
- `index.ts` only starts the application and handles shutdown.

V0 reuses that responsibility split, but it does **not** import code from
`bots/midnight-crossed-books`. Bots remain independently deployable; genuinely reusable runtime or
protocol code belongs in an existing shared package only after a concrete second consumer exists.

## Proposed Solution

### 1. One bot package, three concurrent workflows, one make queue

Create `bots/midnight-quoter` as one long-running Bun program. The three product processes are
isolated application workflows inside that runtime, not independently deployed EOA writers:

```text
setup-check ── readiness ──┬── bootstrap ──┐
                           │               ├── blocking MakeService ── signer/Mempool/chain
                           └── ladder ──────┘
```

All workflows use the same maker, allowlist, typed configuration, chain snapshot adapters, and
official Mempool/Router views. They do not communicate through files, a database, or an external
wire protocol. Chain state and Mempool state remain authoritative.

`MakeService` is a singleton application service shared by bootstrap and ladder. Every mutation is
enqueued and the caller's promise stays pending until its job completes or rejects. It processes
one job at a time:

1. reload the active maker offers immediately before mutation;
2. merge the proposed change with the still-live offer set;
3. reject with the typed `NEGATIVE_SPREAD` error if any proposed or live V0 offer would create an
   inverted spread, unless a bootstrap buy overlaps the unique highest-rate owned ladder sell and
   all current rate and remaining-size evidence is complete;
4. invalidate the prior root/group when the job is a replacement;
5. sign and publish the exact validated replacement; and
6. settle the caller's promise only after the resulting active set is observable.

This blocking queue serializes key access, offer invalidation, signing, publication, and any
on-chain nonce allocation. Bootstrap and ladder can calculate concurrently, but they cannot race
two writes or sign against two different views of the active book.

Startup supports two explicit destructive controls before readiness is emitted:

- `--cleanup` invalidates every existing offer for the configured maker; and
- `--cleanup-group <group>` invalidates every offer in the named group.

After cleanup, normal startup continues only when invalidation is confirmed. A cleanup failure exits
non-zero and lets the deployment supervisor retry. On `SIGINT`/`SIGTERM`,
`SHUTDOWN_CLEANUP=true` makes the runtime stop accepting new make jobs, drain the current job, try
to invalidate every active bootstrap and ladder group through on-chain transaction(s), wait for
their receipts, and only then exit. Cleanup is best effort under a bounded timeout. Every shutdown
prints a final report to the terminal with whether cleanup was enabled, the attempted groups,
transaction hashes and receipt statuses, confirmed invalidations, incomplete groups, elapsed time,
and final exit status. When the option is false, shutdown stops the workflows without invalidating
resting offers and the report records that cleanup was disabled.

Each workflow owns a deterministic group namespace derived from at least:

```text
(strategy-version, workflow, chain, market, side, rung, group-mode)
```

Normal reconciliation may only replace or invalidate roots in the caller's namespace. Explicit
startup cleanup, shutdown cleanup, and a hard safety halt may invalidate both strategy namespaces
through `MakeService`.

### 2. Package and dependency boundaries

The package follows this dependency direction:

```text
entrypoint -> bootstrap -> config + application + infrastructure
application -> domain
infrastructure -> application ports + domain + external libraries
domain -> language-level values and lightweight numeric/address types
```

The intended layout is:

```text
bots/midnight-quoter/
  src/
    application/
      setup-check.service.ts
      bootstrap.service.ts
      ladder-quoter.service.ts
      make.service.ts
    domain/
      inventory.ts
      ladder.ts
      rate.ts
      reconciliation.ts
    infrastructure/
      blue-reference/
      midnight/
      mempool/
    config/
      config.service.ts
    bootstrap.ts
    index.ts
  test/
    application/
    domain/
    infrastructure/
    config/
```

The names are illustrative; ownership is the decision:

- **Domain** owns fixed-point rate calculations, bounds, ladder generation, inventory/exposure
  policies, cost-basis checks, quote-set identity, and reconciliation decisions. It has no RPC,
  SDK client, environment, logger, or process dependency.
- **Application** owns the three workflows. Ports such as `SetupStateService`,
  `ReferenceRateService`, `InventoryService`, `OfferBookService`, `OfferPublisher`, and
  `OfferInvalidator` are declared next to their consumers. `MakeService` owns their shared blocking
  mutation queue.
- **Infrastructure** owns viem reads, historical-block lookup, Midnight SDK conversion, Mempool and
  Router clients, EIP-712/Merkle-root construction, provider DTO validation, and invalidation
  transport.
- **Configuration** loads strategy settings from environment variables, discovered
  `quoter-bot.yaml` / `quoter-bot.yml`, or a YAML path supplied by `--config`. Environment values
  override corresponding YAML values. Secrets may use either source, but operators should prefer the
  deployment secret store/environment; any local YAML containing a key must be ignored and permission
  restricted. Business decisions do not read environment variables or YAML directly.
- **Bootstrap** manually wires concrete adapters into application services. No dependency-injection
  framework is added.
- **Entrypoint** parses `--config`, `--cleanup`, and `--cleanup-group`, creates the application,
  starts it, and handles `SIGINT`/`SIGTERM`.

The central config service is a deliberate scoped match to `midnight-crossed-books`, whose
`ConfigService.from(environment)` parses once at startup. Adding one YAML input does not establish a
new repo-wide runtime-schema convention; environment and YAML values map into the same validated
domain-neutral config.

### 3. Process 1 — setup check

`setup-check` is the runtime readiness gate. Bootstrap and ladder are constructed but do not start
until its readiness promise resolves successfully. It then repeats on a configurable slow cadence
to detect setup drift.

V0 checks:

1. the configured chain is Base and the Midnight bytecode exists at the expected address;
2. the private key derives the configured maker address;
3. the maker has enough native token for the configured invalidation reserve;
4. the loan-asset allowance to Midnight covers the maximum configured lend exposure and is not
   pointed at an unexpected spender;
5. the selected Ecrecover or Setter ratifier matches the canonical Base address in the pinned
   Morpho SDK, its deployed bytecode matches the expected ratifier surface, and
   `Midnight.isAuthorized(maker, ratifier)` is true;
6. every configured book is on the explicit allowlist, is active, uses the expected loan asset, has
   accessible tick spacing, and has not matured;
7. the reference-market configuration and archive RPC are readable; and
8. the complete active maker offer-group set contains no unknown V0 namespace, no offer on a removed
   or unconfigured market, and no already-live inverted spread. The check uses the cursor-paginated
   `/v0/midnight/users/{maker}/offer-groups` source rather than takeable offers, so fresh active
   offers are visible before executable amount measurement.

The check is read-only. It reports the exact remediation transaction but does not approve tokens,
authorize a ratifier, move funds, or invalidate offers. Setup remains an explicit operator action.

Position-health checking is represented by a port and a `not-required` V0 result. It becomes
mandatory before any strategy revision can increase collateralized debt.

A failed startup check rejects readiness after bounded transient-provider retries, kills the runtime
with a non-zero exit, and leaves bootstrap and ladder unstarted. The deployment supervisor then
places the service in its expected crash loop until the operator repairs setup. A periodic
post-readiness failure receives the same bounded tolerance, then closes the make queue, attempts the
configured safety cleanup, logs the precise failed check, and exits non-zero; the bot does not remain
alive in a degraded readiness state.

### 4. Target-rate strategies

Both target-rate implementations satisfy one application port and return a domain value carrying
the rate, observation block and time, calculation window, and source identity.

#### Variable Blue reference rate — default

The default adapter derives an annualized supply APY from one designated Morpho Blue variable-rate
market:

1. read a deterministic latest block and reject it when its timestamp is stale;
2. use the chain's configured block-time estimate to bracket
   `latest.timestamp - REFERENCE_LOOKBACK_SECONDS`, then binary-search block timestamps to locate the
   block at or immediately before the target;
3. read and accrue the reference market at both explicit block tags;
4. compute the loan-asset value of one supply share at each checkpoint; and
5. annualize the share-value return over the observed interval using fixed-point arithmetic.

The default lookback is six hours (`21600` seconds), and the latest reference checkpoint must be no
more than five minutes behind wall-clock time. Historical block lookup and state reads require
an archive-capable RPC. A reference market with less than six hours of observable history, missing
historical state, a non-positive interval, zero share supply, negative/undefined return, or an
incomplete accrual result is a hard reference failure.

The calculation is on-chain/RPC-derived and does not depend on a Morpho-operated API. It must be
accrual-aware at each checkpoint; dividing two raw, unaccrued market totals is not an acceptable
implementation.

#### Static target rate — explicit fallback

`TARGET_RATE_MODE=static` returns `STATIC_TARGET_RATE_BPS`. This is the operator's declared rate at
which acquiring bootstrap credit is acceptable. Static mode is selected explicitly through
configuration; the bot never silently falls back from a broken dynamic source to a static rate.

#### Bounds and staleness

`TARGET_RATE_MIN_BPS` and `TARGET_RATE_MAX_BPS` default to 200 and 800. The bot does not clamp a bad
reference into that range: an out-of-bounds result is treated as unsafe, all active roots are
invalidated, and quoting halts.

The same hard bounds apply to every generated rung, not only the center rate. Configuration fails
at startup when its spread, step, and rung count cannot fit a full ladder inside the configured
range. A runtime reference move that would push any rung outside the range triggers the same hard
halt.

The six-hour window is recalculated every hour in variable mode. V0 derives it through RPC rather
than consuming a precomputed API value, keeping the public strategy independently reproducible. A
different window or API adapter may be evaluated later with explicit source and manipulation
analysis.

### 5. Process 2 — bootstrap

Bootstrap exists to acquire credit without removing the regular quoter-bot ladder.

For each allowlisted market:

1. every minute, load current credit, debt, cash balance, active maker roots, the credit target, and
   its asset-denominated acceptance threshold;
2. consider the target satisfied when
   `credit >= creditTarget - CREDIT_TARGET_ACCEPTANCE_ASSETS`;
3. otherwise compute the target rate and apply `BOOTSTRAP_PREMIUM_BPS`, which must be zero or
   negative;
4. generate one small fixed-size credit-acquiring offer, capped by the remaining credit target,
   wallet balance, per-market exposure limit, and total exposure limit;
5. submit the desired replacement to `MakeService`, whose last-moment prospective-book validation
   includes the negative-spread guard; and
6. invalidate the active bootstrap group as soon as the observed credit enters the accepted target
   range.

When the premium-adjusted bootstrap buy reaches or crosses the unique highest-rate existing ladder
sell, `MakeService` treats that overlap as intentional only when the complete current book proves the
sell is ladder-owned and provides its group cap, consumption, tick, and maturity. It derives the
sell's current effective rate from that exact tick and remaining time to maturity, reprices the new
bootstrap offer to that rate, and publishes only `expected bootstrap assets - sell remaining
assets`. A zero or negative remainder produces no publication. Unknown ownership, ties at the
highest rate, pending offers without indexed size, malformed size/rate evidence, pre-existing
crossings, or a crossing against any other offer still fail closed with `NEGATIVE_SPREAD`. Live and
`--readonly` use the same resolver; read-only output records the adjusted request without mutating
the book.

The temporary offer lends at a worse rate for a limited period, making it attractive for a taker
and paying the bootstrap cost through reduced yield. It is the only discounted offer. Normal
ladder roots remain present and continue to use their configured quote premium.

Static and variable modes have different refresh behavior:

- **Static:** publish at the hardcoded rate and leave the offer resting. Reconcile it only after a
  fill, target/exposure change, explicit cleanup, or safety event.
- **Variable:** every hour recompute the six-hour Blue reference, enqueue invalidation of the
  previous bootstrap group, and publish the newly priced replacement. This refresh happens even
  when the movement is below the ladder's re-centering tolerance.

The independent one-minute credit monitor is necessary because ladder fills can add credit while a
bootstrap offer is live. Bootstrap reacts to the combined inventory and invalidates its own group
once the acceptance threshold is met; it never assumes that only its own fills move credit.

When `AUTO_REFILL=true`, the workflow resumes this behavior whenever credit falls below target. When
false, bootstrap runs until the initial target transition and then remains observational until
restarted with an explicit operator decision.

Bootstrap does not proactively take standing offers. That avoids a separate taker transaction and
supersedes the original 10,000 USDC active-take sketch. The overlap handling above instead accounts
for the maker's own already-resting ladder sell while keeping both offers passive.

### 6. Process 3 — ladder quoter

Ladder owns the long-running quote-set calculation and reconciliation workflow. It never mutates
the book directly; all invalidation, signing, and publication goes through the shared blocking
`MakeService`.

On each cycle it:

1. runs the setup checks;
2. reads one deterministic chain snapshot plus active Mempool offers for the maker and allowlist;
3. loads inventory, conservative credit cost basis, balances, exposure, maturity, settlement fee,
   continuous fee, and tick spacing;
4. obtains the selected target rate;
5. keeps the current roots when the target moved less than
   `REFERENCE_MOVE_TOLERANCE_BPS` and no inventory/safety input requires resizing;
6. computes a desired bid and ask ladder;
7. diffs desired roots against the active roots it owns;
8. submits one replacement job to `MakeService`, which reloads the book, rejects any inverted
   prospective spread, invalidates stale roots, and publishes the replacement serially; and
9. waits for that queued job to settle before starting another reconciliation; and
10. logs the desired/actual diff and resulting inventory limits.

For center rate `C`, spread `S`, step `D`, rung index `k` starting at zero, the domain service places
rates on each side at:

```text
lower-rate side: C - S/2 - kD
higher-rate side: C + S/2 + kD
```

It then converts rates to accessible Midnight ticks using `@morpho-org/midnight-sdk` and validates
the rounded result. The offer builder, not the formula caller, owns the exact mapping from
lower/higher rate to Midnight `buy`/sell semantics.

The initial pilot configuration is:

| Parameter             | Initial value                                               |
| --------------------- | ----------------------------------------------------------- |
| Chain                 | Base                                                        |
| Market                | `0x05959752…6ebf6c84c`                                      |
| Maximum exposure      | 20,000 USDC per market                                      |
| Static fallback       | 5% APR                                                      |
| Full spread           | 2 percentage points                                         |
| Step                  | 1 percentage point                                          |
| Rungs                 | 3 per side                                                  |
| Result at 5% center   | 2%, 3%, 4% and 6%, 7%, 8%                                   |
| Initial credit target | 10,000 USDC-equivalent credits, subject to MS risk approval |

These are pilot values, not hard-coded constants.

The ladder supports:

- a quote premium added to the selected reference center;
- configurable spread, step, rung count, and size skew;
- total exposure per side and target exposure per market;
- a shared-rung mode, where rung `k` is one group across books and its cap is the rung budget; and
- a per-book mode, where each book has separate groups.

The configured group mode is always included in startup and quote logs. In V0, a multi-market
shared offer is capped at the lowest applicable per-market cap. Higher-cap single-market top-ups
are deferred.

### 7. Quote and inventory invariants

No offer is published unless all invariants hold for the exact encoded offer:

- the market is explicitly allowlisted and not matured;
- the quote rate, after tick rounding, is inside the hard bounds;
- the reference observation is fresh and complete;
- lend exposure is bounded by available loan-asset balance, configured rung/side budget,
  per-market target exposure, and total exposure;
- the credit-reducing side is bounded by available credit and cannot create negative credit or
  unintended debt;
- a credit sale is not loss-making against the conservatively reconstructed held-credit cost basis;
- exactly one of `maxUnits` and `maxAssets` is non-zero;
- shared groups contain only compatible direction, loan asset, and cap semantics;
- the prospective set, evaluated together with every already-published maker offer, does not cross
  or create an inverted/negative spread on any market, except for the single evidenced
  bootstrap/ladder overlap above; unresolved crossings are rejected with `NEGATIVE_SPREAD` before
  invalidating or publishing anything;
- offer start, expiry, maturity, tick spacing, settlement-fee assumptions, continuous-fee cap,
  callback, receiver, maker, and ratifier match policy;
- the generated root contains only the expected allowlisted offers; and
- the published bytes/root are identical to the bytes/root that passed validation.

If a conservative cost basis cannot be reconstructed from chain and official indexed history after
a restart, the bot does not quote the credit-reducing side. It may continue the independently safe
side only when doing so cannot increase debt or breach the total exposure cap.

Offers are continuously renewed until market maturity. Rolling funds or credits into the next book
is never inferred from a new market appearing; it requires an operator allowlist and bootstrap
decision.

### 8. Restart and reconciliation

The bot persists no strategy state. On every runtime start:

- the maker address is derived from the configured key;
- positions, credit, debt, balances, allowances, authorizations, consumed group amounts, and
  invalidation state are rebuilt from chain truth;
- active offers and their roots are loaded from the Mempool/Router;
- roots are classified by deterministic namespace; and
- optional `--cleanup` / `--cleanup-group` invalidation completes before readiness; then the active
  set is reconciled to the desired quote set.

Unknown roots signed by the maker are never silently adopted or invalidated during normal
reconciliation. They fail the setup check and require an operator decision. During a configured
hard halt, `MakeService` invalidates only roots that decode as this V0 strategy's namespaces.

Mempool publication failures do not mutate an assumed live state. Before broadcast, the bot durably
reserves the SDK-derived group ID; a failed broadcast removes that reservation, while a successful
broadcast is promoted to confirmed ownership. If finalization storage fails, the reservation remains an
ownership candidate and is considered active only when fresh provider data contains that ID. The rejected
make promise carries the typed reason and the next cycle reloads the active set. `MakeService` owns the
in-process signing queue, pending transaction queue, and signer-policy guard. After a restart it reconciles
the pending nonce and on-chain invalidation state before accepting another job from either workflow.

### 9. Failure posture

| Failure                                     | Required behavior                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Startup setup check fails                   | Retry transient provider-only failures; otherwise reject readiness, start no writers, and exit non-zero |
| Setup drifts after readiness                | Retry transient provider-only failures; otherwise close make queue, clean up, and exit non-zero         |
| Stale/unavailable reference                 | Invalidate all V0 roots through `MakeService`, exit non-zero                                            |
| Target or any rung outside bounds           | Invalidate all V0 roots and exit; never clamp                                                           |
| Prospective or existing inverted spread     | Reject make with `NEGATIVE_SPREAD`; mutate nothing; existing inversion also exits                       |
| One market read fails                       | Invalidate/halt that market; other allowlisted markets may continue                                     |
| Mempool publication fails                   | Reject queued promise; reload fresh state; never assume publication                                     |
| Invalidation simulation/revert              | Publish nothing new; retry invalidation with the exact reason logged                                    |
| Cost basis unavailable                      | Do not publish the credit-reducing side                                                                 |
| Credit inside acceptance threshold          | Invalidate bootstrap group; ladder continues                                                            |
| Credit below target, auto-refill off        | Log the deficit; do not publish a temporary top-up                                                      |
| Credit below target, auto-refill on         | Bootstrap resumes capped top-up publication                                                             |
| Maker key or ratifier authorization changes | Treat as setup drift and crash-loop                                                                     |
| Runtime restart                             | Rebuild from chain/Mempool and reconcile; no local-state recovery                                       |
| `SHUTDOWN_CLEANUP=true`                     | Drain make, submit on-chain group invalidation(s), await receipts, print report                         |

### 10. Configuration contract

Strategy configuration may be supplied through environment variables, an explicit YAML file passed as
`--config <path>`, or both. Without an explicit path, the CLI discovers `quoter-bot.yaml` and then
`quoter-bot.yml` in its invocation working directory; `.yaml` wins when both exist, and no file
preserves environment-only startup. Environment variables always override corresponding YAML values,
including whole-list replacement for market and bootstrap arrays. Both sources map into one typed
validation path and produce the same validated runtime configuration.

The public README, `.env.example`, and `quoter-bot.example.yaml` document every currently implemented
setting, unit, default, precedence rule, and safety interaction. The current YAML schema is limited to
`chain`, `identity`, `contracts`, `apis`, `markets`, `setup`, and `bootstrap`. In that schema,
`MORPHO_API_BASE_URL` serves book and cursor-paginated offer-group reads, while
`ROUTER_API_BASE_URL` serves the contract registry; neither current client has a configurable API-key
header. The groups below describe the full V0 destination; settings not present in the current README
schema remain explicitly planned until their workflows are implemented:

- **Chain and identity:** `CHAIN_ID`, `RPC_URL`, optional fallback RPC, `MAKER_PRIVATE_KEY`,
  Midnight address, and ratifier selection. The ratifier address is accepted only when it matches
  the canonical Base catalog in the pinned Morpho SDK.
- **Markets:** explicit allowlisted market IDs, per-market exposure, and group mode. Immutable market
  configuration—including loan asset, maturity, and protocol parameters—is retrieved on-chain from
  each ID and is not duplicated in operator config.
- **Reference:** `TARGET_RATE_MODE`, Blue reference market parameters,
  `REFERENCE_LOOKBACK_SECONDS` (default `21600`), hourly refresh interval, reference staleness,
  static target.
- **Bounds:** minimum/maximum rate, maximum total exposure, maximum exposure per market, native gas
  reserve.
- **Bootstrap:** credit target, asset-denominated acceptance threshold, one-minute credit monitor,
  fixed top-up size, bootstrap premium, auto-refill.
- **Ladder:** quote premium, spread, step, rungs, size skew, side budgets, loop interval, movement
  tolerance.
- **Transport:** official Morpho API origin, request timeout/retry limits, maximum fee and gas bounds
  for invalidation. The retired Router config-contracts endpoint is not a readiness dependency.
- **Lifecycle:** startup `--cleanup` / `--cleanup-group` CLI options, `SHUTDOWN_CLEANUP`, and cleanup
  timeout.
- **Observability:** log level and optional BetterStack fields; logging works to stdout without a
  vendor.

All rates use one documented unit at the configuration boundary, proposed as integer basis points.
For the implemented V0 bootstrap contract, asset, credit, and exposure amounts are exact raw loan-asset
base-unit integers; no human-readable token-decimal scaling occurs. YAML accepts decimal integer strings
or bare decimal integers. `BOOTSTRAP_MARKETS` requires every integer-valued property to be a quoted
decimal string and rejects JSON number tokens. Floating-point and exponent notation are not used for
pricing, sizing, or invariant checks. Any future human-readable amount setting must be introduced as a
separate, explicitly scaled contract rather than reinterpreting these fields.

### 11. Implementation phases and deadline

- **Phase 1 — architecture and public-release gate (July 27):** accept the TIB direction, settle
  public dependency/legal questions, define env/YAML configuration, and establish the three
  workflows plus shared `MakeService`.
- **Phase 2 — setup and rate sources (July 28):** implement readiness/crash-loop behavior, canonical
  SDK ratifier validation, the six-hour Blue reference adapter, static adapter, fixed-point bounds,
  and domain tests.
- **Phase 3 — bootstrap and ladder (July 29):** implement the serialized signing queue,
  negative-spread guard, startup/shutdown cleanup, offer construction, namespace ownership,
  acceptance threshold, one-minute inventory monitoring, ladder generation, and reconciliation.
- **Phase 4 — integration and safety (July 30):** add adapter tests and a pinned Base fork covering
  approval/authorization, signing, take/fill, invalidation, restart, stale reference, and hard halt.
- **Phase 5 — public release candidate (July 31):** complete the open-source checklist, publish the
  strategy and operator docs, deploy the live canary, and begin/complete the unattended acceptance
  run.

The implementation is not considered done merely because code is merged by Friday. V0 is done only
when:

1. it runs unattended on live allowlisted books for a few days;
2. a bootstrap-to-quote transition is observed;
3. at least one organic fill occurs;
4. both sides remain inside inventory, rate, and loss-budget bounds;
5. stale/out-of-range input has been demonstrated to invalidate and halt safely; and
6. a third party can clone the public repository, configure a fresh maker, and reproduce the
   deployment using only public documentation and services.

## Considered Alternatives

### Alternative 1: Three independently deployed programs

Run setup, bootstrap, and ladder as separate Bun programs or Railway services.

**Why rejected:** Bootstrap and ladder share one maker key and must validate the combined prospective
book before every make. Independent runtimes would need a fourth signer daemon or external lock to
serialize invalidation, signing, publication, and nonces. Three isolated workflows in one runtime
preserve the product boundaries while allowing one blocking `MakeService`.

### Alternative 2: Three unconstrained writers using the same EOA

Let setup remediate approvals and let both bootstrap and ladder invalidate their own roots on-chain.

**Why rejected:** Concurrent writers can allocate the same nonce or publish two individually valid
sets that form an inverted spread together. The singleton make queue serializes both the signer and
the last-moment whole-book invariant check.

### Alternative 3: Six-hour Morpho API reference

Read a precomputed short average from a Morpho-operated endpoint.

**Why rejected:** It adds an operator-specific service dependency to a public reference bot. The
six-hour RPC-derived supply-share return is reproducible and independently auditable. Static mode
remains the explicit fallback.

### Alternative 4: Actively take offers to bootstrap

Immediately take 10,000 USDC of offers, matching the original July 20 engineering sketch.

**Why rejected:** It introduces an active transaction, price-selection surface, and immediate
execution cost. A capped temporary offer acquires credit passively, keeps the ordinary ladder
visible, and limits the bootstrap cost through an explicit premium. Opportunistically taking an
offer strictly better than the expected bootstrap rate is a recorded follow-up.

### Alternative 5: Persist strategy state or coordinate through a database

Store the last reference, roots, inventory cost basis, and process readiness in a shared database.

**Why rejected:** Chain and Mempool truth are authoritative and sufficient to rebuild the strategy.
A database creates a stale-state and operational dependency that makes the reference harder to
fork. Indexed history may be read to reconstruct cost basis, but it is an input, not bot-owned
state.

### Alternative 6: Import or fork `midnight-crossed-books`

Reuse its application and infrastructure modules directly.

**Why rejected:** The bots have different workflows and transaction authority. Cross-bot imports
violate the repository's standalone-bot boundary. V0 copies the responsibility pattern, not the
implementation; only proven reusable code moves to shared packages.

### Alternative 7: Event-driven competitive re-quoting

Subscribe to every book and reference update and replace offers immediately.

**Why rejected:** V0 is a public reference strategy. An hourly-ish loop with movement tolerance is
easier to operate and explain, and accepting bounded staleness is an explicit product choice.

## Assumptions & Constraints

- V0 is Base-only and starts with the explicitly named pilot market.
- Setup, bootstrap, ladder, and the singleton `MakeService` share one Bun runtime and composition
  root.
- The official Mempool accepts signed offer roots; all key access and state-changing writes are
  serialized through `MakeService` regardless of whether a particular operation consumes an EOA
  nonce.
- Root/group invalidation may be on-chain and is therefore owned by the same blocking make queue.
- The RPC provider offers historical Base state for the complete six-hour lookback.
- The selected Blue reference market has enough supply-share history for a meaningful return and
  matches the economic exposure the operator intends to track.
- Official indexed history can reconstruct a conservative held-credit cost basis. If it cannot, the
  credit-reducing side fails closed.
- A hot key is accepted only at the V0 limit of 20,000 USDC per market and within the separately
  agreed aggregate loss budget.
- No significant capital increase occurs before V1 treasury, ratifier, and key-custody controls
  ship.
- Static mode is an operator decision, never an automatic availability fallback.
- Environment and YAML inputs resolve to one strategy configuration before any workflow starts.
  Deployment tooling logs its non-secret digest at startup.
- The hard 2%–8% defaults in this TIB supersede the earlier approximate 2%–3% floor / 10% ceiling
  sketch for V0. Operators may customize them explicitly.

## Dependencies

- `@morpho-org/midnight-sdk` for protocol-exact tick/price/rate and offer utilities and
  `MidnightApi.fetchBooks` endpoint/mapping reuse. Version 1.2.0 does not expose the active
  offer-group endpoint or entity, so that cursor traversal keeps a minimal local, deadline-bounded,
  strictly validated response projection.
- `@morpho-org/morpho-sdk/abis` for the exported `blueAbi` used by reference-market reads.
- `@morpho-org/morpho-ts`, satisfying the SDK peer range.
- `viem` for deterministic current/historical RPC reads, contract reads, simulation, and
  invalidation submission.
- `@repo/bot-kit` for clients, structured logging, pending transaction queue, fee policy, signer
  guard, balance monitoring, and process runner where its existing abstractions fit.
- `@repo/contracts` for reviewed Midnight and ratifier ABI surfaces when the SDK does not expose
  them.
- The deployed Midnight singleton and Ecrecover ratifier on Base.
- Official Morpho Mempool/Router endpoints for active offers and publication.
- An archive-capable Base RPC endpoint.
- [TIB-2026-07-16](./TIB-2026-07-16-revert-to-bots-as-programs.md) for the standalone-bot and
  chain-truth-on-restart posture.
- [TIB-2026-07-21](./TIB-2026-07-21-midnight-sdk-apr-labels.md) for the current Midnight SDK version
  and exact tick math rationale.

## Observability

V0 emits JSON lines to stdout/file and remains useful without BetterStack. Every event includes
`bot`, `workflow`, `chainId`, `maker`, `marketId`, and a non-secret configuration digest where
applicable.

Required events include:

| Event                        | Minimum fields                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `setup.checked`              | each check, pass/fail, observed value, required value                            |
| `reference.observed`         | mode, market, rate, blocks/timestamps, window, age, bounds                       |
| `reference.rejected`         | precise stale/calculation/bounds reason                                          |
| `bootstrap.evaluated`        | credit, target, deficit, premium, size, auto-refill                              |
| `bootstrap.published`        | market, root, rate/tick, cap, expiry                                             |
| `ladder.evaluated`           | center, spread, step, rungs, skew, desired/actual counts                         |
| `ladder.unchanged`           | reference movement and tolerance                                                 |
| `ladder.reconciled`          | roots invalidated/published/retained                                             |
| `make.queued`                | workflow, market, operation, queue depth                                         |
| `make.rejected`              | typed reason including `NEGATIVE_SPREAD`, live/proposed best rates               |
| `cleanup.started`            | trigger, all/group/strategy scope, root count                                    |
| `cleanup.completed`          | transaction hashes/receipts, invalidated/incomplete groups, elapsed, exit status |
| `strategy.halted`            | triggering invariant and invalidation coverage                                   |
| `offer.filled`               | market, side, group/root, units/assets, rate, resulting credit/debt              |
| `position.observed`          | cash, credit, debt, exposure, conservative cost basis                            |
| `pnl.estimated`              | realized/unrealized components, methodology/version, loss-budget consumption     |
| `invalidation.submitted`     | root/group, transaction hash, nonce                                              |
| `invalidation.settled`       | transaction hash, receipt status                                                 |
| `reconciliation.unknownRoot` | root, namespace decode failure                                                   |

The daily Linear update is a manual summary built from these events: deployed version, live
markets, current mode, reference rate, credit versus target, ladder coverage, fills, estimated P&L,
incidents/halts, and next blocker. V2 may automate this to Slack without changing the event
contract.

Logs must never contain private keys, signed authorization payloads that are not already public,
RPC credentials, API keys, or secret environment values.

## Security

- **Capital cap:** V0 stays at or below 20,000 USDC per market and the MS-approved aggregate budget.
  Configuration refuses a higher limit unless the V1 security mode is explicitly present.
- **Hot-key boundary:** the hot key is held only by the signer adapter behind `MakeService`, which
  may sign offers and submit narrowly allowlisted invalidation calls. It must not have unrelated
  treasury, owner, or governance roles.
- **Allowance:** setup requires only the configured loan asset and expected Midnight spender. The
  required amount is bounded by configured exposure; unexpected spenders or excessive policy
  mismatches fail setup.
- **Ratifier authorization:** setup checks the exact deployed ratifier address and bytecode before
  accepting `Midnight.isAuthorized(maker, ratifier)`. A different authorized contract is not
  silently substituted.
- **Signer policy:** the make queue's transaction signer pins chain, target contract, invalidation
  selector, zero native value, fee/gas/calldata ceilings, and the maker/root namespace. Prepared
  invalidation calldata is simulated and submitted byte-for-byte.
- **Offer policy:** maker, receiver, callback, ratifier, market, group, cap, tick, expiry, and
  continuous-fee cap are validated after encoding and before signing.
- **Whole-book spread policy:** `MakeService` reloads active offers immediately before every
  mutation and rejects a prospective inverted spread with `NEGATIVE_SPREAD`; bootstrap and ladder
  cannot bypass this check.
- **Fail closed:** stale reference, unknown root, missing cost basis, setup drift, or rate-bound
  failure cannot publish a new offer.
- **No negative credit:** the credit-reducing side uses protocol semantics such as `reduceOnly`
  where applicable and is capped so a fill cannot silently turn a credit position into debt.
- **Maturity:** no offer may create new debt after maturity, and no offer expiry extends beyond the
  market's maturity.
- **Provider trust:** an RPC or Mempool can censor or lie. Explicit block tags, fallback RPC,
  response validation, exact-root reconciliation, and fail-closed behavior reduce the impact; V0
  does not claim Byzantine provider tolerance.
- **V1 gate:** treasury multisig, delegated funding/cap/block contract, bounded on-chain
  quoter ratifier, and KMS-equivalent signing are required before a material capital ramp.

## Open-source release requirements

Open source is a V0 ship gate, not a documentation follow-up. The release unit is the public
repository and runnable bot; workspace packages may remain `"private": true` to prevent accidental
npm publication.

### Repository audit at draft time

The repository already has:

- a root Apache-2.0 `LICENSE` and Apache-2.0 metadata on each bot/package manifest;
- a root README, CODEOWNERS, pinned GitHub Action revisions, and CI checks;
- `.gitignore` rules for `.env`, `.env.*`, PEM files, logs, and local exports; and
- per-bot Docker/deployment patterns that keep runtime secrets in the deployment environment.

The following required public surfaces are absent or not yet proven:

| Surface                        | V0 release requirement                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `CONTRIBUTING.md`              | Local setup, test commands, PR/title convention, DCO/CLA policy, review expectations                          |
| `SECURITY.md`                  | Private vulnerability-reporting channel, supported versions, response expectations                            |
| `CODE_OF_CONDUCT.md`           | Public community behavior and enforcement contact                                                             |
| GitHub issue/PR templates      | Bug/config support form, security redirect, reproducible PR checklist                                         |
| Root package metadata          | Add license, description, repository, homepage, and bugs fields while retaining `private: true`               |
| Full git-history secret audit  | Scan every ref and commit; review findings; purge when required; rotate anything ever exposed                 |
| Public-content audit           | Remove secrets, PII, private endpoints, internal-only ops details, and inaccessible links required to operate |
| Dependency/license audit       | Record direct/transitive licenses and generated-schema provenance; resolve incompatible/copyleft material     |
| Fork-safe CI                   | Untrusted fork PRs pass secretless checks; trusted RPC/fork tests never expose secrets to fork code           |
| Dependency/security automation | Enable dependency review, update alerts, code/secret scanning, and branch protection for the public repo      |
| Release/distribution policy    | State whether source, containers, and npm artifacts are supported; publish reproducible container commands    |
| Public support boundary        | State supported chains/markets, response expectations, and what remains operator-owned                        |

The history scan must cover committed `.env` files, private keys, RPC/API tokens, Railway project
identifiers, webhook URLs, internal hostnames, real maker/curator addresses when sensitive, PII,
Slack user mappings, and generated files. Deleting a secret from `HEAD` is insufficient; anything
ever exposed is rotated before visibility changes.

### Bot documentation required at ship

`bots/midnight-quoter` ships with:

- `README.md`: architecture, the three-workflow lifecycle, prerequisites, setup check, local run,
  Docker and deployment, upgrade, shutdown, recovery, invalidation, and troubleshooting;
- `STRATEGY.md`: public formulas, rate source, premiums, ladder construction, inventory policy,
  bounds, failure posture, known weaknesses, and non-competitive intent;
- `.env.example`: placeholders only, with units/defaults and no real keys, RPC credentials, project
  IDs, or operator-specific addresses;
- `quoter-bot.example.yaml`: the equivalent configuration schema, with documented `--config`,
  default discovery, and environment-over-YAML precedence behavior;
- `Dockerfile`, `docker-compose.yml`, and environment-driven deployment tooling with no baked-in
  Morpho project;
- a configuration reference and an example for the initial Base pilot;
- a threat model explaining hot-key authority, allowance, ratifier authorization, provider trust,
  and the V1 capital gate;
- an operator runbook covering fund/authorize, dry run, bootstrap, live quote, halt, invalidate all,
  maturity, restart/reconcile, key rotation, and incident recovery;
- P&L methodology and explicit statement that estimates may differ from realized settlement;
- public API/RPC dependency and rate-limit requirements; and
- disclaimers approved by legal, including experimental-software, no-warranty, operator-risk,
  market/liquidity risk, and third-party-fork responsibility language.

Legal must confirm the existing Apache-2.0 choice, copyright owner, contribution policy, trademark
usage, third-party notices, and disclaimer text. A `NOTICE` file is added when the dependency and
source-provenance audit finds required attributions. Protocol Solidity or SDK code is not copied
into the Apache-licensed tree without an explicit compatibility review.

### Public reproducibility gate

Before the repository is made public, a clean-room test from a fresh clone must prove that an
external operator can:

1. install the pinned Node/Bun toolchain;
2. run secretless lint, format, typecheck, and unit tests;
3. configure a new maker from `.env.example`;
4. run setup-check and receive actionable remediation;
5. run static mode without a Morpho-internal API;
6. run variable mode using a third-party archive RPC;
7. start the one runtime with all three workflows locally and with Docker;
8. observe a dry-run desired quote set without publishing;
9. deploy without Morpho Railway/GitHub identifiers; and
10. exercise `--cleanup`, `--cleanup-group`, and shutdown cleanup, then recover safely after restart.

The public documentation must contain the product and strategy requirements needed to understand
the bot. A Linear, Slack, or Granola link may be retained as provenance, but it cannot be the only
source of an operational requirement.

## Testing and Verification

Implementation tests mirror the source layers:

- **Domain:** exact fixed-point six-hour return annualization, bounds, tick rounding, ladder
  symmetry, spread/step/rungs, skew, shared/per-book caps, exposure, cost basis, maturity, and
  no-negative-credit decisions.
- **Application:** setup fail/repair, bootstrap transition, auto-refill, tolerance no-op,
  one-minute credit monitoring, acceptance threshold, static/variable refresh behavior,
  reconciliation diff, unknown roots, partial market failure, `NEGATIVE_SPREAD`, blocking make
  ordering, and hard-halt invalidation using narrow fakes.
- **Infrastructure:** block-time bracketing plus timestamp binary search, accrual-aware Blue
  snapshots, Mempool pagination and response validation, SDK offer/root encoding, publication
  idempotency, and invalidation simulation-to-submit identity.
- **Fork:** pinned Base state covering allowance, ratifier authorization, signed offer take, partial
  fill, consumed group, root invalidation, startup/group/shutdown cleanup, stale quote invalidation,
  restart, nonce reconciliation, and balance/position changes.
- **Runtime:** all three workflows run concurrently through one `MakeService` without
  cross-namespace mutation, inverted spreads, or duplicate on-chain nonces; failed readiness enters
  the supervisor crash loop before either writer starts; shutdown cleanup submits the expected
  group invalidation transaction(s) and prints a complete terminal report.
- **Live canary:** bootstrap-to-quote transition, at least one organic fill, restart reconciliation,
  and a rehearsed invalidate-all.

Tests follow the repository verification rule: after writing or modifying a test, run it, then
temporarily break one assertion and confirm that it fails before restoring it. The pre-release
validation suite is typecheck for the affected package, repo-wide lint, `bun format`, `bun test`,
and the relevant fork/live checks.

## Future Considerations

- **V1 — security and treasury:** treasury multisig; delegated funding contract with fund/cap/block
  controls; custom quoter ratifier enforcing price/spread bounds on-chain; AWS KMS or
  equivalent key custody. This phase gates any significant fund increase.
- **V2 — monitoring:** inventory/loss/staleness alerting, automated reports to the agreed Market
  Services Slack channel, dashboards, and service-level objectives.
- **V3 — smarter quoter-bot:** position and algorithm optimization, cross-market hedging, and
  debt-friendly inventory management.
- Automatic rollover between maturities.
- Per-book top-ups above the lowest shared multi-market cap.
- Opportunistic bootstrap taking when a standing offer is available at a strictly better rate than
  the expected bootstrap make.
- More robust rate sources, shorter/weighted windows, or multiple-source agreement.
- Position-health enforcement once the strategy can create collateralized debt.
- Separate authorized offer-signing and invalidation keys after the V1 ratifier constrains their
  authority.

## Open Questions

These must be resolved before the relevant implementation or public-release gate:

1. Confirm the exact Morpho Blue reference market parameters and whether the intended benchmark is
   supplier share value after all fees; the TIB assumes it is.
2. Confirm the official public Mempool publication/invalidation contract and external rate limits.
3. Confirm the default bounded timeout and exit status when opt-in shutdown cleanup is incomplete.
4. Confirm the inventory-history source and conservative cost-basis method used after restart.
5. Confirm the final aggregate loss budget with Market Services; the per-market V0 cap is 20,000
   USDC.
6. Legal approval: Apache-2.0, contribution policy, third-party notices, strategy publication, and
   disclaimer wording.
7. Decide whether the public release publishes a supported container image in addition to source.

## References

- [MKT-1455: define TIB](https://linear.app/morpho-labs/issue/MKT-1455/define-tib)
- [Quoter bot Linear project](https://linear.app/morpho-labs/project/market-making-bot-628e80069e52/overview)
- [Initial Base Midnight market](https://markets.morpho.org/fixed/base/0x05959752fdeff325962b9d263edb421efc6e2186a49360dba6c32e86ebf6c84c?orderType=limit)
- [`midnight-crossed-books` architecture](../../bots/midnight-crossed-books/README.md)
- [TIB-2026-07-16: Revert to bots-as-programs](./TIB-2026-07-16-revert-to-bots-as-programs.md)
- [TIB-2026-07-21: midnight-sdk APR labels](./TIB-2026-07-21-midnight-sdk-apr-labels.md)
- [Repository conventions](../CONVENTIONS.md)
- [TIB process](../GUIDANCE.md)
- [Midnight contracts context](../context/repos/midnight-contracts.txt)

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
