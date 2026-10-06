# morpho-bots

Offchain Morpho bots — reallocators, liquidation monitors, market makers, and similar — and the
shared packages they consume. Every bot is a long-running program that holds a key, signs
transactions, and moves funds on mainnets with no human approving each action, so the code favors
safe and explainable over clever or fast.

This is a [pnpm workspaces](https://pnpm.io/workspaces) monorepo:

- `bots/` — individual bot apps (one per bot); each keeps its own `README.md`
- `packages/` — shared libraries the bots depend on

Pull requests are not accepted at this time; see [CONTRIBUTING.md](./CONTRIBUTING.md). Issues are
welcome.

## Bots

| Bot                                                      | Description                                             | Docs                                              |
| -------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------- |
| [blue-liquidation](./bots/blue-liquidation/)             | Liquidates eligible Morpho Blue positions               | [README](./bots/blue-liquidation/README.md)       |
| [midnight-liquidation](./bots/midnight-liquidation/)     | Liquidates eligible Midnight positions                  | [README](./bots/midnight-liquidation/README.md)   |
| [midnight-crossed-books](./bots/midnight-crossed-books/) | Resolves crossed Midnight offer books                   | [README](./bots/midnight-crossed-books/README.md) |
| [quoter-bot](./bots/quoter-bot/)                         | Midnight maker: setup checks, bootstrap, ladder quoting | [README](./bots/quoter-bot/README.md)             |
| [vault-v1-reallocation](./bots/vault-v1-reallocation/)   | Reallocates liquidity across Vault V1 Markets           | [README](./bots/vault-v1-reallocation/README.md)  |
| [vault-v2-reallocation](./bots/vault-v2-reallocation/)   | Reallocates liquidity across Morpho Vault V2 Markets    | [README](./bots/vault-v2-reallocation/README.md)  |

The quoter-bot CLI is also published to npm as
[`@morpho-org/quoter`](https://www.npmjs.com/package/@morpho-org/quoter) and to Docker Hub as
[`morphoorg/quoter`](https://hub.docker.com/r/morphoorg/quoter); both are published from this
repository's `quoter-bot-*` tags by the workflows under [`.github/workflows/`](./.github/workflows/).

## Packages

| Package                                                  | Description                                                                  |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [@repo/bot-kit](./packages/bot-kit/)                     | Shared bot runtime: clients, logger, watcher/runner, tx queue, state, policy |
| [@repo/contracts](./packages/contracts/)                 | Shared contract ABIs and Executor sources                                    |
| [@repo/logging](./packages/logging/)                     | CLI presenter: stdout results, stderr errors, bigint-safe JSON Lines         |
| [@repo/monitoring](./packages/monitoring/)               | Monitor interval waits, serial operation queue, cycle-failure predicate      |
| [@repo/observability](./packages/observability/)         | Bot lifecycle/record shipping, process observers, verbose argv gating        |
| [@repo/offers](./packages/offers/)                       | Maker offer-book model: prospective batching and negative-spread checks      |
| [@repo/swaps](./packages/swaps/)                         | Multi-venue DEX quoting, routing, unwrap seam, and venue selection           |
| [@repo/typescript-config](./packages/typescript-config/) | Shared TypeScript configuration                                              |
| [@repo/utils](./packages/utils/)                         | Shared server-safe utilities                                                 |

## Getting started

```sh
nvm use               # Node 24.18.1 (see .nvmrc)
corepack enable pnpm  # pnpm 11.11.0, pinned by package.json#packageManager
pnpm install
pnpm build            # @repo/contracts ABIs, needed by the liquidation bots' tests
```

`pnpm` denies dependency lifecycle scripts by default — see `allowBuilds` in
`pnpm-workspace.yaml`. An install that needs a new one fails loudly rather than running it.

## Daily commands

```sh
pnpm run lint          # oxlint, repo-wide
pnpm format            # oxfmt, repo-wide
pnpm -r run typecheck  # tsc --noEmit in every workspace package
pnpm run knip          # dead-code detection
pnpm test              # vitest projects plus Node playground suites
```

The fork and e2e suites under `bots/*/test/fork/` and `bots/quoter-bot/test/e2e/` fork Base at a
pinned block and need `RPC_URL_8453` set to an archive endpoint; see each bot's README.

## Releases

Release tags look like `<bot>-<PR#>`, for example `quoter-bot-227`. A `quoter-bot-*` tag publishes
the npm package and the Docker Hub image.

## Pointers

- `docs/CONVENTIONS.md` — code organization, patterns, and style
- `bots/<bot>/README.md` — how to configure, run, and deploy each bot

## License

[Apache-2.0](./LICENSE) © 2026 Morpho Association
