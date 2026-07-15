# deploy

Deployment packaging for the bot use-case of the generic `morpho-bots` CLI
(`apps/cli`): how the one-shot ticks are wrapped into long-running services. The CLI package
itself stays unopinionated — everything that turns it into a persistent liquidation bot lives here.
For the commands themselves and a by-hand version of this loop, see
[`apps/cli/README.md`](../apps/cli/README.md).

- `Dockerfile` — the single bot image (all bots ship in it; `BOT`/`CHAIN_ID` select what runs).
  Build context MUST be the repo root so the bun workspace resolves. The image AOT-builds both the
  CLI (`bun run --filter @repo/cli build` → `apps/cli/dist/main.js`) and the queue daemon
  (`bun run --filter @repo/queued build` → `apps/queued/dist/main.js`) so the lens bytecode is
  baked in and spawns pay no soltag/solc cost — "warm by construction", no cache to prime.
- `docker-entrypoint.sh` — starts the offline signer and per-chain queue daemon, then runs the pipeline
  `bun dist/main.js $BOT $SOURCE_OP | … $TRANSFORM_OP | morpho-queued submit` every `TICK_INTERVAL_S` seconds
  (`SOURCE_OP`/`TRANSFORM_OP` default to the liquidation pair `unhealthy-positions`/`liquidate`; which
  ops run is deployment policy). stdout carries JSON-Lines records; all logs go to stderr. Each tick wires the three stages
  through two named FIFOs (`positions-<chainId>.pipe`, `transactions-<chainId>.pipe`) and `wait`s on
  each stage individually, collecting a per-stage exit code under the CLI's 0/1/2 contract: any stage
  exiting 2 crashes the container visibly (`loop.fatal`), any other nonzero re-loops (transient —
  including a `queue` exiting 1 while the daemon is still booting). Each tick and inter-tick sleep runs in a backgrounded subshell the loop
  `wait`s on, so a `SIGTERM`/`SIGINT` interrupts promptly; shutdown drains the queue and signer
  before exit. The compose files set `stop_grace_period: 60s` (worst-case in-flight tick + daemon
  drain) so the platform doesn't SIGKILL mid-drain. `submit` streams transaction JSON directly over
  the queue Unix socket; acknowledgements are minimal and settlement is written to the daemon's
  append-only per-chain journal. Set `QUEUED_DRY_RUN=true` to run the dedupe→re-sim→fee path without
  starting or requiring the signer.
- `docker-compose.blue.yml` / `docker-compose.midnight.yml` — local/self-hosted orchestration
  (blue's bundles the shared rindexer + Postgres from `deploy/blue-rindexer`). Run from the repo
  root, e.g. `docker compose -f deploy/docker-compose.midnight.yml up` or
  `docker compose -f deploy/docker-compose.blue.yml up`.
- `scripts/deploy-railway-{blue,midnight}.ts` — reproducible, idempotent Railway deploys:
  `bun run --filter @repo/deploy deploy:railway:midnight` (see each script's header for env vars).
- `vector.yaml` — config for the optional BetterStack log-forwarding side-car (see below).

## Container environment

The image selects and configures a bot entirely through environment variables (the compose files and
Railway scripts set these). Required:

| Variable             | Example     | Purpose                                                                                     |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `BOT`                | `blue`      | Which core to run (`blue` or `midnight`).                                                   |
| `CHAIN_ID`           | `8453`      | Chain the bot and queue daemon serve.                                                       |
| `RPC_URL`            | `https://…` | JSON-RPC endpoint (secret).                                                                 |
| `LIQUIDATOR_ADDRESS` | `0x…`       | Operator EOA: skim recipient, simulate `from`, and — when armed — the signer key's address. |

Armed operation additionally needs `SIGNER_PRIVATE_KEY` (secret; read only by `morpho-signer`) and a
signer policy (`SIGNER_POLICY_JSON` or `SIGNER_POLICY_PATH`; see [§ Signing agent](#signing-agent)).
Optional:

| Variable                     | Default                             | Purpose                                                     |
| ---------------------------- | ----------------------------------- | ----------------------------------------------------------- |
| `TICK_INTERVAL_S`            | `2`                                 | Seconds between pipeline ticks.                             |
| `SOURCE_OP` / `TRANSFORM_OP` | `unhealthy-positions` / `liquidate` | Which op pair the loop runs.                                |
| `QUEUED_DRY_RUN`             | unset                               | `true` runs the full path without a signer (no key needed). |
| `LOG_LEVEL`                  | `info`                              | Log verbosity.                                              |
| `BETTERSTACK_SOURCE_TOKEN`   | unset                               | Enables log forwarding (see below).                         |
| `BETTERSTACK_INGESTING_HOST` | unset                               | BetterStack ingesting host; required when the token is set. |

Per-bot, op-specific variables (e.g. `DATABASE_URL`, `SWAP_CONFIG_PATH`, `ZEROX_API_KEY`,
`ONEINCH_API_KEY`) are documented in the bot READMEs. State and config live under `/data/morpho-bots`
(`MORPHO_BOTS_HOME`); mount a volume at `/data` so cross-tick state, the queue socket/lock, and the
outcomes journal survive restarts.

## Log forwarding (optional)

Railway has no log-drain feature, so the image ships a `vector` binary that forwards the bots' logs
to BetterStack from inside the container. It is **fully opt-in** and controlled by two env vars:

- `BETTERSTACK_SOURCE_TOKEN` — the per-bot BetterStack source token (a secret). **Unset ⇒ no
  forwarding**, and the container behaves byte-identically to a build without this feature.
- `BETTERSTACK_INGESTING_HOST` — the source's ingesting host (bare hostname). Required when the token
  is set; token-set-without-host **fails loud** and skips forwarding rather than shipping nowhere.

When enabled, `docker-entrypoint.sh` `tee`s all stderr to both the real stderr (Railway's native
explorer is unaffected) and an **ephemeral `/tmp` spool** — never `/data`, so a stalled shipper can't
fill the state/journal volume — which Vector tails and ships to BetterStack (`deploy/vector.yaml`).
Vector runs with `SIGNER_PRIVATE_KEY` scrubbed from its environment (single-key-reader invariant) and
stops last on shutdown so it can flush. Blue's two chains share one blue source; Midnight has its own.
Creating the sources and setting these secrets is a deploy-time step. See
[TIB-2026-07-14-betterstack-log-forwarding](../docs/decisions/TIB-2026-07-14-betterstack-log-forwarding.md).

## Signing agent

`morpho-signer` is the armed deployment's distinct, default-deny key holder. One process serves one
chain and one Executor. Zero value and the Executor entry selector are hard-coded invariants; the
queue verifies both the recovered sender and every prepared transaction field before broadcasting.
Runtime knobs are argv/environment-only; the signer policy is intentionally delivered as inline JSON
or a policy file (default `<home>/signer-policy.json`).

The signer does not decode the calls nested inside the Executor batch. Its policy limits the EOA's
chain, outer target/selector, value, fees, gas, and calldata size. In the bundled deployment, signer
and queue are separate same-user processes in one container: this is a policy/fault boundary, not
isolation against a compromised same-container process.
