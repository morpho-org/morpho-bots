# railway

Manually deploy a curator bot to Railway and read its logs. The **target bot is required** —
`blue-liq` and `midnight-liq` are both wired; never assume one.

> Routine deploys are automated: every commit to `main` redeploys both bots to their Railway
> **staging** environment, and a PR merged with a `release-{bot}` label redeploys that bot to
> **production** and cuts a release. See [`deploy/README.md`](../../deploy/README.md) § CI/CD. Use
> this command for **provisioning** (first-time setup, or after changing variables/secrets) and for
> reading logs — not for shipping code that CI already ships.

## Usage

```
/railway deploy <bot>      # full provisioning deploy of the bot's Railway services from the working tree
/railway logs <bot> [N]    # tail the bot's last N log lines (default 200)
```

If `<bot>` is omitted, ask the user which of `blue-liq` / `midnight-liq` to target — do **not** default.

## Deploy (provisioning)

The `@repo/deploy` scripts (`deploy/scripts/deploy-railway-{blue-liq,midnight-liq}.ts`) are idempotent:
they ensure services/volumes, (re)set variables + secrets, then `railway up` the **current working
tree** (uncommitted changes included; Railway builds server-side). Secrets are read from the
deploy runner's environment — source them locally before running (see `deploy/README.md` for the
full env-var list and the staging vs. production runbook).

1. Confirm the CLI is authenticated: `railway whoami` (else tell the user to run `! railway login`),
   or export a project-scoped `RAILWAY_TOKEN`.
2. Run in the **background** — the script polls each service up to ~10 min. Set the environment
   (`RAILWAY_ENVIRONMENT` defaults to `production`; use `staging` to provision staging) and the
   bot's required secrets, then:

   ```bash
   RAILWAY_ENVIRONMENT=<staging|production> RAILWAY_PROJECT_ID=<id> <bot secrets…> \
     bun run --filter @repo/deploy deploy:railway:<bot>
   ```

3. Success = the script prints `SUCCESS` for each service. Then verify with `logs`.

To redeploy code only against an already-provisioned environment (what CI does), use the
deploy-only entrypoint instead: `BOT=<bot> RAILWAY_ENVIRONMENT=<env> RAILWAY_PROJECT_ID=<id>
RAILWAY_TOKEN=<token> bun run --filter @repo/deploy deploy:railway`.

## Logs

**Use the CLI, not the Railway MCP `get_logs`** — Railway parses the bot's JSON into structured
attributes, so MCP renders the `message` field **blank**. `railway logs` shows the real
`key=value` content. Always pass `--lines`/`--since` (without them it streams forever and hangs).

```bash
railway logs -s <service> --lines 200
railway status                            # lists services + Online/offline
```

Services: **blue-liq** → `bot-8453`, `bot-4663`, `rindexer`, `Postgres`; **midnight-liq** → `bot`. A
healthy `bot` ticks each block: `event="block.new"` → `event="lens.read"` → `event="tick.end"`
(`liquidatable=`/`submitted=` counters), plus one `event="daemon.start"` at boot. Trouble =
`event="tick.error"` or `[ERROR]`; for a reverting tx grep `tx.dropped` / `tx.replace_failed` /
`tx.submit_failed`. Triage by event, not the raw line — error lines historically carried a
multi-KB calldata dump that shippers truncate.

## Notes

- Project/service IDs are intentionally **not** hardcoded — they come from `RAILWAY_PROJECT_ID` in
  the runner env (or the `{bot}-{stage}` GitHub Environment in CI) and `railway status`. The
  deployable-service list per bot lives in `deploy/scripts/manifest.ts`.
- Deploy ships whatever is in the working tree; flag uncommitted changes to the user before running.
- **blue-liq** only: `swap-config.json` lives on the bot's `/data` volume at
  `/data/morpho-bots/blue/swap-config.json` (uploaded out-of-band); without it the bot runs but
  skips routed liquidations. Midnight's venue routing is API-sourced (no file).
