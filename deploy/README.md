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
- `docker-compose.blue-liq.yml` / `docker-compose.midnight-liq.yml` — local/self-hosted orchestration
  (blue's bundles the shared rindexer + Postgres from `deploy/blue-rindexer`). Run from the repo
  root, e.g. `docker compose -f deploy/docker-compose.midnight-liq.yml up` or
  `docker compose -f deploy/docker-compose.blue-liq.yml up`.
- `scripts/deploy-railway-{blue-liq,midnight-liq}.ts` — reproducible, idempotent **provisioning** deploys
  (ensure services/volumes, set variables + secrets, then `railway up`):
  `bun run --filter @repo/deploy deploy:railway:midnight-liq` (see each script's header for env vars).
- `scripts/deploy-railway.ts` — **deploy-only** entrypoint used by CI (`BOT=… bun run --filter
@repo/deploy deploy:railway`): `railway up` per service, no provisioning, no secrets. Reads the
  per-bot service list from `scripts/manifest.ts` (the single source of truth for bot → services).
- `vector.yaml` — config for the optional BetterStack log-forwarding side-car (see below).

## CI/CD

GitHub Actions deploys the bots to Railway (`.github/workflows/deploy-{bot,staging,production}.yml`):

- **Staging** — every commit to `main` redeploys **both** bots to their Railway `staging`
  environment (`deploy-staging.yml`).
- **Production** — a PR merged to `main` carrying a `release-{bot}` label (`release-blue-liq` /
  `release-midnight-liq`) redeploys that bot to `production` and cuts a GitHub release + git tag
  (CalVer `{bot}-YYYY.MM.DD-N`, notes via `gh --generate-notes`), which fires
  `release-slack-notify.yml`. Both trigger on `push: main`; production reads the merged PR's labels
  from the landed commit, so its run ref is `main` (see the workflow header for why not
  `pull_request: closed`). A commit with no `release-*` label simply skips the production deploy.

**Deploy-only, secrets stay on Railway.** CI ships code with `railway up` (`deploy:railway`) and
never sets variables/secrets — so signer private keys, RPC URLs, and venue keys are **not** stored
in GitHub. The only CI credential is a `RAILWAY_TOKEN`.

> **Token is high-value.** A project-scoped `RAILWAY_TOKEN` can read the project's secrets back
> (`railway variables`), including `SIGNER_PRIVATE_KEY` — its blast radius ≈ the signer key. It is
> still better than storing the raw key (revocable/rotatable independently, scoped to one
> project+environment, and — with the branch policy below — usable only from `main`).

### GitHub configuration (one-time, repo settings)

Create **4 Environments** — `blue-liq-staging`, `blue-liq-production`, `midnight-liq-staging`,
`midnight-liq-production` — each with:

- secret `RAILWAY_TOKEN` — a Railway **project token** scoped to that project + environment.
- var `RAILWAY_PROJECT_ID` — the project UUID.
- **Deployment branches: `main` only** (closes the token-exfiltration path).

_Alternative:_ a single workspace **team token** (`RAILWAY_API_TOKEN`) covers both projects — fewer
tokens, broader blast radius, and needs `Railway.initialize()` to skip the `railway link` step for
that token. The scoped project-token setup above is preferred.

### Provisioning (before CI can deploy)

Deploy-only assumes each environment's services + variables + secrets already exist. **Production is
provisioned; staging is not — and this is the fiddly part.** Railway **service names are unique per
project**, and the full `deploy-railway-{bot}.ts` scripts create services via
`railway add --service <name>`, which succeeds only for the _first_ environment in a project (it is
how production was provisioned). Run against the empty `staging` environment it fails —
`railway add --service bot` returns _"a service named 'bot' already exists in this project"_ — so the
scripts **cannot seed a second environment**. Bring the services into `staging` one of two ways:

- **Railway dashboard (recommended):** open the staging environment and add each service (`bot` for
  midnight-liq; `rindexer` + `bot-8453` + `bot-4663` + Postgres for blue-liq), then set that
  environment's variables + secrets on them (use **separate staging keys/wallets/RPCs** from
  production) and deploy.
- **Fork production → staging:** Railway copies the services _and their variables_, including the
  production `SIGNER_PRIVATE_KEY` / `RPC_URL`. ⚠️ For a funded liquidation bot this is dangerous — a
  forked staging env holds (and, if deployed, could act with) the production signer key until you
  override every secret. Only fork if you override the secrets immediately.

Once a service exists in an environment, deploy-only CI (`railway up`) ships code to it. Adjust its
variables/secrets whenever they change — CI only ships code, it does not reconcile config drift.

## Container environment

The image selects and configures a bot entirely through environment variables (the compose files and
Railway scripts set these). Required:

| Variable             | Example     | Purpose                                                                                     |
| -------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `BOT`                | `blue`      | Which protocol core to run (`blue` or `midnight`).                                          |
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
`ONEINCH_API_KEY`, `LIFI_API_KEY`) are documented in the bot READMEs. State and config live under `/data/morpho-bots`
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
stops last on shutdown so it can flush. blue-liq's two chains share one source; midnight-liq has its own.
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
