# railway

Deploy a curator bot to Railway and read its logs. The **target bot is required** —
`midnight-liquidation` and `blue-liquidation` are wired today, but never assume which.

## Usage

```
/railway deploy <bot>      # redeploy the bot's Railway services from the working tree
/railway logs <bot> [N]    # tail the bot's last N log lines (default 200)
```

If `<bot>` is omitted, list the bots that have a `deploy:railway` script
(`bots/*/package.json`) and ask the user which to target — do **not** default. Resolve the chosen
`<bot>` to: package `@morpho-org/<bot>`, env file `bots/<bot>/.env.local`.

## Deploy

`railway up` uploads the **current working tree** (uncommitted changes included; no commit needed)
and redeploys that bot's services. Secrets come from the bot's `.env.local`.

1. Confirm the CLI is authenticated: `railway whoami` (else tell the user to run `! railway login`).
2. Run in the **background** — the script polls each service up to ~10 min:

   ```bash
   set -a; source bots/<bot>/.env.local; set +a
   bun run --filter @morpho-org/<bot> deploy:railway
   ```

3. Success = the script prints `SUCCESS` for each service. Then verify with `logs`.

## Logs

**Use the CLI, not the Railway MCP `get_logs`** — Railway parses the bot's JSON into structured
attributes, so MCP renders the `message` field **blank**. `railway logs` shows the real
`key=value` content. Always pass `--lines`/`--since` (without them it streams forever and hangs).

```bash
set -a; source bots/<bot>/.env.local; set +a
railway logs -s <service> --lines 200
railway status                            # lists services + Online/offline
```

`midnight-liquidation` services: `bot`, `rindexer`, `Postgres`. Healthy `bot` ticks each block:
`event="block.new"` → `event="lens.read"` → `event="tick.end"` (`liquidatable=`/`submitted=`
counters), plus one `event="daemon.start"` at boot. Trouble = `event="tick.error"` or `[ERROR]`;
for a reverting tx grep `tx.dropped` / `tx.replace_failed` / `tx.submit_failed`. Triage by event,
not the raw line — error lines historically carried a multi-KB calldata dump that shippers truncate.

## Notes

- Project/service IDs are intentionally **not** hardcoded — they come from `.env.local`
  (`RAILWAY_PROJECT_ID`) and `railway status`, mirroring each bot's `scripts/deploy-railway.ts`.
- Deploy ships whatever is in the working tree; flag uncommitted changes to the user before running.
- `midnight-liquidation` only: `swap.json` lives on the bot's `/config` volume (uploaded
  out-of-band); without it the bot runs but skips routed liquidations.
