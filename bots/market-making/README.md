# Market making bot

Implements the boilerplate for [MKT-1457](https://linear.app/morpho-labs/issue/MKT-1457/create-the-boilerplate).

CLI-only for now, built on [`commander`](https://github.com/tj/commander.js): `mm --version` prints
a hardcoded `0.0.0`.

## Architecture

Follows the hex architecture / service-responsibility style used by `midnight-crossed-books`:

- `VersionService` (application) owns the bot's version, independent of any transport.
- `Cli` (infrastructure) wires the `commander` program to application services.
- `src/index.ts` is the composition root and CLI entrypoint.

## Run

```sh
bun run --filter @morpho-org/market-making-bot start -- --version
```

## Test

```sh
bun test bots/market-making/test
```
