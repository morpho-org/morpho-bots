# @morpho-org/quoter

Morpho Midnight quoter CLI: validates maker setup, bootstraps target lending positions, maintains
two-sided rate ladders, and provides explicit recovery commands on Ethereum mainnet and Base.

The package ships one self-contained bundle — no dependencies are installed.

## Install

Requires Node.js 24.14.1 or newer.

```sh
npm install -g @morpho-org/quoter
```

## Quickstart

Configuration comes from environment variables, a YAML file, or both. The CLI discovers
`quoter-bot.yaml` (then `quoter-bot.yml`) in the working directory, or takes an explicit file with
`--config <path>`. Start from the
[example configuration](https://github.com/morpho-org/morpho-bots/blob/main/bots/quoter-bot/quoter-bot.example.yaml).

```sh
# Read-only readiness checks against the configured maker address (no key required).
morpho-quoter --readonly setup-check

# Inspect every intended action without signing or submitting anything.
morpho-quoter --readonly ladder --monitor --verbose

# Run setup checks, position bootstrap, and ladder monitoring together until SIGINT/SIGTERM.
morpho-quoter start --verbose
```

Start with `--readonly` to inspect every intended action before enabling signing.

## Commands

| Command                 | Behavior                                                           |
| ----------------------- | ------------------------------------------------------------------ |
| `setup-check`           | Run quoter readiness checks once                                   |
| `bootstrap`             | Run one position-bootstrap cycle, or continuously with `--monitor` |
| `ladder`                | Run one quoter ladder cycle, or continuously with `--monitor`      |
| `start`                 | Monitor setup, bootstrap, and ladder together until shutdown       |
| `invalidate [group-id]` | Cancel every offer group the signer's kernel holds, or one of them |

Root options precede the command: `--config <path>`, `--readonly`, `--json` (JSON Lines output for
automation), and the signer options below. Add `--verbose` to writer commands for safe diagnostics
and submitted transaction hashes. The `bootstrap --monitor` and `ladder --monitor` writer variants
(and `start`) clean up owned offers on SIGINT/SIGTERM; `setup-check` stays read-only.

## Signing

Exactly one signer source is required in write mode:

```sh
# Environment (preferred for unattended operation): MAKER_PRIVATE_KEY or YAML equivalent.
morpho-quoter setup-check

# Encrypted JSON keystore with a hidden interactive password prompt.
morpho-quoter --keystore ./maker.json --interactive setup-check

# Non-exportable AWS KMS key (AWS_KMS_KEY_ID, AWS_REGION, standard AWS credential chain).
morpho-quoter --aws setup-check
```

AWS mode calls KMS directly. Its signer must differ from `MAKER_ADDRESS`, be authorized by that
maker through Midnight, use the canonical Ecrecover ratifier, and hold the configured gas reserve.
Write mode also requires the fee, spend, gas, and calldata limits and the `KERNEL_ENROLLMENT`
setting listed in the full reference.

## Upgrading from 0.x

This major version signs only through a transaction kernel whose ledger and journal live in
`$XDG_STATE_HOME/morpho-quoter-bot`, which must survive restarts. Upgrade one chain at a time,
with the chain unquoted for the window:

1. Stop the running bot; its shutdown cancels every offer group it owns.
2. With the earlier version, run `morpho-quoter invalidate --readonly` and cancel any group that
   remains with `invalidate`, or `invalidate <group>` for one the API has not indexed.
3. Delete the earlier version's `0x….json` state files from that directory. Keep the directory.
4. Unset `PRIORITY_FEE_GWEI`; the kernel tips from the chain's recent fees, and a start that still
   sets it refuses.
5. Start this version with `KERNEL_ENROLLMENT=enrolling`, then set `KERNEL_ENROLLMENT=enrolled` for
   every later start.

`MAX_CONTINUOUS_FEE_CAP`, `FINALITY` and `JOURNAL_RUN_CAP_BYTES` are optional and default to the
earlier behavior. Log events changed; the full reference lists every change under "Log changes
from 0.x".

`--private-key <key>` and `--password <password>` exist for explicit automation but place secrets in
argv, where process listings and shell history may expose them; prefer `MAKER_PRIVATE_KEY` and
`KEYSTORE_PASSWORD`. Never commit real configuration.

## Exit contract

Success exits `0` and writes human-readable output to stdout; with `--json`, one JSON Lines record
per value (bigints as decimal strings). Failures exit non-zero with an explicit sanitized error on
stderr that never includes credentials, URLs, or provider payloads.

## Documentation

Complete configuration reference (all environment variables, YAML schema, bootstrap and ladder
fields, formulas, and operational behavior):
<https://github.com/morpho-org/morpho-bots/tree/main/bots/quoter-bot#readme>

Also available as a Docker image:
[`morphoorg/quoter`](https://hub.docker.com/r/morphoorg/quoter).

## License

Apache-2.0
