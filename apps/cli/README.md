# morpho-bots

`@repo/cli` (bin: `morpho-bots`) is the UNIX-pipeable operator CLI for the Morpho curator bots. Each
domain exposes a flat set of op commands — a **source** (emits position records) or a **transform**
(positions → transactions) — piped into `morpho-queued submit`. stdout is JSON-Lines data; all logs
go to stderr. Config and state live under `~/.morpho-bots` (`MORPHO_BOTS_HOME` overrides).

The CLI runs **one shot per invocation**: a source emits and exits, a transform drains its stdin and
exits. It holds no schedule and no daemon. Turning these one-shot ops into a persistent, looping bot
is caller policy — see [Running a looping bot](#running-a-looping-bot-by-hand) below and, for the
packaged version, [`deploy/README.md`](../../deploy/README.md).

In the workspace, `morpho-bots` is available on `PATH` after `bun install` (equivalently, run
`bun apps/cli/src/main.ts …`). In the deploy image the CLI is AOT-bundled and invoked as
`bun apps/cli/dist/main.js …`.

## Commands

```sh
morpho-bots init
morpho-bots <domain> <op> [--chain <id>]
```

`<domain>` is `blue` or `midnight`. Every domain exposes the same two ops; they dispatch at runtime
from each core's `OPS` table (the CLI keeps no separate manifest), so an unknown op exits `2`.

| Command                                    | Kind        | Description                                                                                                                          |
| ------------------------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `morpho-bots init`                         | —           | Scaffold the config/state home with commented `config.json`/`secrets.json` examples (never overwrites).                              |
| `morpho-bots <domain> unhealthy-positions` | `source`    | Discover candidates and emit one transparent position JSON record per liquidatable position.                                         |
| `morpho-bots <domain> liquidate`           | `transform` | Read position JSONL, re-read chain state, plan/quote/encode, and emit one simulated transaction JSON record per actionable position. |

`--chain <id>` selects the chain; it defaults to the `CHAIN_ID` env var, or to the sole configured
chain if exactly one is configured.

The per-bot record shapes, the `jq` filters that make sense for each, and the full per-op env-var
lists live in the bot READMEs, not here:

- [`packages/blue-liquidation/README.md`](../../packages/blue-liquidation/README.md)
- [`packages/midnight-liquidation/README.md`](../../packages/midnight-liquidation/README.md)

## Config and state

Everything an op needs is supplied through an environment-shaped table, merged (later wins) from:

```text
config.json (defaults) → config.json (chain overlay)
  → secrets.json (defaults) → secrets.json (chain overlay)
  → process.env → resolved CHAIN_ID
```

Both files live in the home dir — `~/.morpho-bots` by default, or `MORPHO_BOTS_HOME` when set (an
empty value is rejected, not treated as the cwd). Chain resolution order is `--chain` > `CHAIN_ID`
env > the sole configured chain; ambiguity or absence is a config error (exit `2`). `morpho-bots
init` writes commented starter files there.

Cross-tick state is a disposable, best-effort per-op cache at
`<home>/<bot>/cache/<op>-<chainId>.json`. A cache miss (e.g. a fresh container) just re-runs the
op's startup checks; chain truth always wins, so running without a persisted home is safe.

## stdout, stderr, and exit codes

stdout carries JSON-Lines records and nothing else — one object per line, so any filter between
stages must preserve that (`jq -c`). Healthy positions, invalid inputs, missing routes, quote
failures, and simulation reverts are structured **stderr** logs that produce no stdout record.

Every stage — sources, transforms, and `morpho-queued submit` — shares one exit-code contract, which
is what lets a loop wrapper react correctly:

| Code | Meaning                                                                                | Loop should     |
| ---- | -------------------------------------------------------------------------------------- | --------------- |
| `0`  | Success (including "nothing to do").                                                   | continue        |
| `1`  | Transient runtime error (e.g. an RPC blip, or `submit` racing a still-booting daemon). | retry next tick |
| `2`  | Fatal: usage error, bad config, or an invalid/oversized input line.                    | **stop**        |

A `set -o pipefail` loop keys on `2` to decide whether to crash or keep ticking.

## The pipeline

A single tick is a source piped into a transform piped into the queue daemon:

```sh
morpho-bots <domain> unhealthy-positions \
  | morpho-bots <domain> liquidate \
  | morpho-queued submit --chain <id>
```

`morpho-queued submit` (from `@repo/queued`) streams the transaction JSONL from stdin directly to
the per-chain `morpho-queued serve` daemon over a Unix socket and writes a minimal ack per line to
stdout. There is deliberately no standalone `send`; to hand-feed one transaction,
`echo '<tx line>' | morpho-queued submit --chain <id>`.

Because the seam is plain JSONL, an operator can inspect or reshape it with `jq` without touching
either program (see each bot README for the field a filter should select on):

```sh
morpho-bots blue unhealthy-positions \
  | jq -c 'select(.market.collateralToken != "0x0000000000000000000000000000000000000000")' \
  | morpho-bots blue liquidate \
  | morpho-queued submit --chain 8453
```

## Running a looping bot by hand

The pipeline above is **one tick**. A live bot is that pipeline run on a loop, alongside a
long-lived `morpho-queued serve` daemon (which alone owns dedupe, re-simulation, fees, nonces,
broadcast, replacement, and settlement) — and, when armed, a `morpho-signer` process.

Start with the disarmed (dry-run) form: it runs the whole dedupe → re-sim → fee path and emits
`would_submit` without touching a signer, so it needs no key and no policy.

```sh
export CHAIN_ID=8453 RPC_URL=https://… LIQUIDATOR_ADDRESS=0x…

# One long-lived daemon per chain. --dry-run: never contacts a signer.
morpho-queued serve --chain 8453 --dry-run &

# The tick loop. Any stage exiting 2 is fatal — stop instead of hot-looping.
set -o pipefail
while true; do
  morpho-bots blue unhealthy-positions \
    | morpho-bots blue liquidate \
    | morpho-queued submit --chain 8453
  status=$?
  [ "$status" -eq 2 ] && { echo "fatal: stage exited 2" >&2; break; }
  sleep "${TICK_INTERVAL_S:-2}"
done
```

To **arm** it, add a signer and drop the dry-run flag. `morpho-signer` (from `@repo/signer`) is the
sole key reader — one chain, one Executor, `value == 0` and the Executor entry selector enforced —
and refuses to start without a valid, non-empty policy:

```sh
export SIGNER_PRIVATE_KEY=0x…                       # only morpho-signer reads this
export SIGNER_POLICY_JSON='{…}'                     # or SIGNER_POLICY_PATH; default <home>/signer-policy.json
export SIGNER_SOCKET="${MORPHO_BOTS_HOME:-$HOME/.morpho-bots}/signer.sock"

morpho-signer &                                     # binds SIGNER_SOCKET
morpho-queued serve --chain 8453 &                  # no --dry-run; reads SIGNER_SOCKET
# … same tick loop as above …
```

`LIQUIDATOR_ADDRESS` must be the signer key's address — `morpho-queued serve` cross-checks the two at
startup and exits `2` on a mismatch. Setting `LIQUIDATOR_PRIVATE_KEY` anywhere the queue can see it
is hard-rejected: the daemon never holds a key. The signer policy shape (chain, outer
target/selector, value, fees, gas, calldata size caps) is described in
[`deploy/README.md` § Signing agent](../../deploy/README.md#signing-agent).

`morpho-queued serve` also accepts `--socket <path>` (default `<home>/queued-<chain>.sock`, or
`QUEUED_SOCKET`) and tunes fees/replacement via `MAX_FEE_GWEI` (default `300`) and `STUCK_BLOCKS`
(default `4`). Terminal outcomes are appended to `<home>/queued/outcomes-<chain>.jsonl`.

Running several behaviors means several loop lines — composition is exogenous, decided by the
caller, never baked into a core. To run a second op pair, add a second source → transform → submit
loop; there is no run-all mode.

## Production

`deploy/` (`@repo/deploy`) packages exactly this stitch into a long-running service: a single Docker
image whose entrypoint starts the signer and the per-chain queue daemon, then loops the
source → transform → submit pipeline every `TICK_INTERVAL_S`, with docker-compose files for local
runs and idempotent Railway deploy scripts for production. See
[`deploy/README.md`](../../deploy/README.md).
