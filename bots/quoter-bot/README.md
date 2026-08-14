# Quoter bot

## Description

Quoter-bot is a **reference implementation** of a market-making bot for the Midnight protocol,
Morpho's onchain rate order book on Base. It implements quoting strategies that place offers on both
sides of a market's book — today a two-sided rate **ladder** centered on a configurable target rate —
together with a position **bootstrap** workflow that builds the lending position the ladder quotes
from.

In short, the bot:

- quotes both sides of each configured Midnight market: lower-rate rungs are reduce-only borrow-side
  offers, higher-rate rungs are lend-side offers;
- derives its target rate per market from a Morpho Blue reference market's variable-rate average or
  from a hardcoded rate;
- re-reads fresh onchain state every cycle, validates the intended offers, and only then signs and
  broadcasts — a `--readonly` mode logs every intended action without loading a key or submitting
  anything;
- cancels its own offers on shutdown and ships structured JSON Lines logs.

> **Disclaimer.** Quoter-bot is a reference bot: a starting point that demonstrates how to quote on
> Midnight, not a competitive market-making system. It reacts on a fixed interval, holds no private
> pricing edge, and ships without warranty of any kind. Running it signs and broadcasts real
> transactions with real funds, and quoting can lose money (adverse fills, stale reference rates,
> operational mistakes). Use it at your own risk.

This README is the user guide. The complete operator reference — every command, deployment workflow,
and field-level validation rule — lives in [docs/reference.md](./docs/reference.md); the
contributor-facing package design lives in [docs/architecture.md](./docs/architecture.md).

## Get started

The bot is not yet published to npm or a container registry (see [Roadmap](#roadmap)), so for now
both paths run locally from a clone of this repository.

Prerequisites: [Node.js 24.14.1](../../.nvmrc) and pnpm 11.1.1 (`corepack enable pnpm`), or Docker
with Compose for the container path.

### With pnpm

Clone and build:

```sh
git clone https://github.com/morpho-org/morpho-bots.git
cd morpho-bots
pnpm install
pnpm --filter @morpho-org/quoter-bot run build
```

Configure the bot — see [Setup](#setup) for every variable:

```sh
cp bots/quoter-bot/.env.example bots/quoter-bot/.env
# Edit bots/quoter-bot/.env with your RPC endpoints, maker identity, markets, and strategy
# parameters. `pnpm run start` loads it automatically.
```

Start (the first `start` is the package script; the second is the bot command that runs setup
checks, bootstrap, and ladder quoting together):

```sh
# Validate configuration and onchain readiness without sending any transaction.
pnpm --filter @morpho-org/quoter-bot run start -- setup-check

# Preview every intended action without loading a private key or submitting anything.
pnpm --filter @morpho-org/quoter-bot run start -- --readonly start --verbose

# Quote live until Ctrl-C; shutdown drains the current cycle and cancels the bot's offers.
pnpm --filter @morpho-org/quoter-bot run start -- start --verbose
```

The `bootstrap`, `ladder`, `setup-check --monitor`, and `invalidate` recovery commands are
documented in [docs/reference.md](./docs/reference.md).

### With Docker

Build and run the production image locally with Compose (it reads the same `.env` file and runs the
combined monitor with a persistent `/state` volume):

```sh
cd bots/quoter-bot
cp .env.example .env
# Edit .env, then:
docker compose up --build
```

The stock Compose file expects the `private-key` signer (`MAKER_PRIVATE_KEY`). To only build the
image, run from the repository root — the build context must be the repository root so workspace
packages resolve:

```sh
docker build -f bots/quoter-bot/Dockerfile -t quoter-bot .
```

## Setup

Configuration comes from environment variables (the `.env` file above), a YAML file
(`quoter-bot.yaml` in the working directory, or `--config <path>`), or both; every supplied
environment variable overrides the corresponding YAML value. Use
[`.env.example`](./.env.example) and [`quoter-bot.example.yaml`](./quoter-bot.example.yaml) as
templates, and never commit real configuration — keep secrets in the environment.

Two unit conventions apply everywhere: amounts are **raw loan-token units** (for six-decimal USDC,
`101000000` is 101 USDC) and rates are **integer basis points** (`100` = one percentage point).

### Environment variables

| Variable                                                     | Required                  | Description                                                                                                          |
| ------------------------------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `CHAIN_ID`                                                   | Yes                       | Must be `8453`; the bot runs on Base only.                                                                           |
| `RPC_URL`                                                    | Yes                       | Base JSON-RPC endpoint for reads, simulation, transaction submission, and receipts.                                  |
| `REFERENCE_RPC_URL`                                          | With `variable_rate_avg`  | Archive-capable Base JSON-RPC endpoint used to read the reference Morpho Blue market at historical blocks.           |
| `MAKER_ADDRESS`                                              | Yes                       | Address whose balance, allowance, credit, offers, and exposure the bot manages. Must match the signer in write mode. |
| `KEY_STORAGE_METHOD`                                         | Write mode                | Signer source: `private-key`, `keystore`, or `aws`. Exactly one effective source is required to sign.                |
| `MAKER_PRIVATE_KEY`                                          | With `private-key`        | 0x-prefixed 32-byte secp256k1 key. Never commit or log it.                                                           |
| `KEYSTORE_PATH`, `KEYSTORE_PASSWORD`, `KEYSTORE_INTERACTIVE` | With `keystore`           | Encrypted Web3 Secret Storage file, its password, and an interactive password prompt for attended runs.              |
| `AWS_KMS_KEY_ID`, `AWS_REGION`                               | With `aws`                | AWS KMS `ECC_SECG_P256K1` signing key; the private key never leaves KMS.                                             |
| `MIDNIGHT_ADDRESS`                                           | Yes                       | Deployed Midnight singleton; its bytecode is verified before the bot writes.                                         |
| `LOAN_ASSET_ADDRESS`                                         | Yes                       | Loan token used by every configured market; all raw amounts use its smallest unit.                                   |
| `RATIFIER_ADDRESS`                                           | Yes                       | Canonical Ecrecover or Setter ratifier authorized by the maker.                                                      |
| `MORPHO_API_BASE_URL`                                        | Yes                       | Morpho API origin for books, market metadata, offer validation, and maker offer groups.                              |
| `MARKET_IDS`                                                 | Yes                       | Comma-separated allowlist of Midnight market IDs; every bootstrap and ladder market must appear here.                |
| `REFERENCE_MARKET_ID`                                        | With `variable_rate_avg`  | Morpho Blue market whose variable-rate average serves as the reference rate.                                         |
| `V0_OFFER_GROUP_IDS`                                         | No                        | Pre-existing offer-group IDs the bot should adopt as strategy-owned.                                                 |
| `NATIVE_RESERVE_WEI`                                         | Yes                       | Minimum maker native balance, in wei, required for transaction fees.                                                 |
| `MAXIMUM_LEND_EXPOSURE_ASSETS`                               | Yes                       | Minimum loan-token allowance to Midnight required by readiness checks.                                               |
| `REQUEST_TIMEOUT_MS`                                         | No                        | Provider-operation timeout in milliseconds; defaults to `10000`.                                                     |
| `TRANSACTION_RECEIPT_TIMEOUT_MS`                             | No                        | Receipt-confirmation timeout in milliseconds; defaults to `180000`.                                                  |
| `BOOTSTRAP_MARKETS`                                          | For `bootstrap` / `start` | JSON array of per-market bootstrap parameters (below).                                                               |
| `LADDER_MARKETS`                                             | For `ladder` / `start`    | JSON array of per-market ladder parameters (below).                                                                  |
| `BETTERSTACK_SOURCE_TOKEN`, `BETTERSTACK_INGESTING_HOST`     | No                        | Optional Better Stack log shipping; set both together.                                                               |
| `BETTERSTACK_HEARTBEAT_URL`                                  | No                        | Optional heartbeat URL pinged at startup and once per minute.                                                        |

### Strategies

The bot ships one quoting strategy for now: the **ladder**. It maintains up to `rungCount` offers on
each side of the book around a center rate, and each per-market entry independently chooses its
reference-rate source (`targetRate`): `variable_rate_avg` follows the configured Morpho Blue
reference market's variable-rate average, while `hardcoded` pins a fixed rate.

```text
center        = reference rate + quotePremiumBps
lower rung k  = center - spreadBps / 2 - k * stepBps   (borrow side, reduce-only)
higher rung k = center + spreadBps / 2 + k * stepBps   (lend side)
```

The ladder is state reconciliation rather than a set of independently refilled orders. Every cycle
re-reads balances, credit, allowance, exposure, and active offers, rebuilds the desired ladder, and
picks one decision: `publish` a fresh ladder, `rest` when nothing changed, `resize` when capacity
moved, or `recenter` when the target rate drifted beyond `movementToleranceBps`. Capacity funds the
closest-to-market rungs first, and rungs below `minimumOfferAssets` are omitted.

Alongside quoting, the position **bootstrap** workflow builds the maker's credit position toward a
per-market target by repeatedly posting one lend offer at `target rate + premiumBps` until
`creditTarget` is reached.

You can explore both parameter sets visually — and export exact `BOOTSTRAP_MARKETS` /
`LADDER_MARKETS` values — with the parameter playground: `pnpm run quoter-bot:playground` from the
repository root, or the hosted build at <https://morpho-org.github.io/morpho-bots/>.

### Bootstrap parameters

`BOOTSTRAP_MARKETS` (or YAML `bootstrap`) is an array with one entry per market. In the environment
form every integer value must be a quoted decimal string; see [`.env.example`](./.env.example) for
exact syntax.

| Field                   | Description                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `marketId`              | Midnight market to bootstrap; unique and present in `MARKET_IDS`.                                     |
| `targetRate`            | `{"strategy":"variable_rate_avg"}` (default) or `{"strategy":"hardcoded","hardcodedRateBps":"400"}`.  |
| `creditTarget`          | Credit position the workflow builds toward; complete at `creditTarget - acceptanceAssets`.            |
| `acceptanceAssets`      | Acceptable shortfall below the credit target.                                                         |
| `offerSize`             | Desired size of each bootstrap offer before capacity caps.                                            |
| `premiumBps`            | Premium added to the target rate (zero or negative).                                                  |
| `maximumMarketExposure` | Per-market exposure cap; must not exceed `maximumTotalExposure`.                                      |
| `maximumTotalExposure`  | Strategy-wide exposure cap.                                                                           |
| `minimumRateBps`        | Inclusive hard minimum for the final rate; out-of-range offers are rejected, never clamped.           |
| `maximumRateBps`        | Inclusive hard maximum for the final rate.                                                            |
| `autoRefill`            | Resume bootstrapping if credit later falls back below the target (memory lasts one service instance). |

### Ladder parameters

`LADDER_MARKETS` (or YAML `ladder`) is an array with one entry per market, quoted-decimal integers
in the environment form.

| Field                        | Description                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `marketId`                   | Midnight market quoted by this entry; unique and present in `MARKET_IDS`.                          |
| `targetRate`                 | Reference-rate source: `variable_rate_avg` (default) or `hardcoded` with `hardcodedRateBps`.       |
| `quotePremiumBps`            | Signed offset added to the reference rate to form the ladder center.                               |
| `spreadBps`                  | Full distance between the two innermost rungs; must be even.                                       |
| `stepBps`                    | Additional distance between successive rungs on the same side.                                     |
| `rungCount`                  | Maximum rungs per side (at most `512`) before capacity filtering.                                  |
| `sizeSkewBps`                | Signed per-rung weight change: positive favors outer rungs, negative favors inner rungs.           |
| `lowerRateBudgetAssets`      | Budget for lower-rate rungs (reduce-only borrow side, additionally capped by accrued credit).      |
| `higherRateBudgetAssets`     | Budget for higher-rate rungs (lend side, additionally capped by balance, allowance, and exposure). |
| `targetMarketExposureAssets` | Per-market exposure cap; applies to the lend side only.                                            |
| `maximumTotalExposureAssets` | Strategy-wide exposure cap; applies to the lend side only.                                         |
| `minimumOfferAssets`         | Smallest allowed rung; underfunded rungs or sides are omitted. Use at least `101000000` for USDC.  |
| `groupMode`                  | `shared-rung` (one consumption group per rung) or `per-book` (one shared group per side).          |
| `loopIntervalSeconds`        | Delay between monitor cycles; the monitor uses the shortest value across entries.                  |
| `movementToleranceBps`       | Center deadband: the ladder recenters only when the target moves by strictly more than this.       |
| `minimumRateBps`             | Inclusive hard minimum for every rung; out-of-range ladders are rejected, never clamped.           |
| `maximumRateBps`             | Inclusive hard maximum for every rung; the complete static shape must fit inside the bounds.       |

Field-level validation rules, worked capacity examples, and the consumption-grouping semantics are
documented in [docs/reference.md](./docs/reference.md).

## Roadmap

- **npm & Docker support** — publish a versioned npm package and prebuilt container image so the bot
  runs without cloning this repository.
- **Helm** — a chart for Kubernetes deployment.
- **Security** — further hardening of key management and operational controls.
- **Monitoring** — metrics, dashboards, and alerting beyond today's structured logs.
- **New strategies** — additional quoting strategies alongside the ladder.
- **Cross-book** — react to and resolve crossed books.
- **Morpho Blue callbacks support** — integrate Morpho Blue callbacks into quoting flows.
- **Treasury management** — automated inventory and idle-balance management.
- **PnL & KPIs measurement** — track profit and loss and quoting performance indicators.
