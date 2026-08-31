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
| `setup-check`           | Run quoter readiness checks once, or continuously with `--monitor` |
| `bootstrap`             | Run one position-bootstrap cycle, or continuously with `--monitor` |
| `ladder`                | Run one quoter ladder cycle, or continuously with `--monitor`      |
| `start`                 | Monitor setup, bootstrap, and ladder together until shutdown       |
| `invalidate [group-id]` | Invalidate all active maker offer groups, or one explicit group    |

Root options precede the command: `--config <path>`, `--readonly`, `--json` (JSON Lines output for
automation), and the signer options below. Add `--verbose` to writer commands for safe diagnostics
and submitted transaction hashes. The `bootstrap --monitor` and `ladder --monitor` writer variants
(and `start`) clean up owned offers on SIGINT/SIGTERM; `setup-check --monitor` stays read-only.

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
