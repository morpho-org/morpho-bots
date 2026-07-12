# Morpho Blue liquidation

`@repo/blue-liquidation` implements the two one-shot Blue pipeline operations. Deployment and
process supervision belong to [`bots/README.md`](../../bots/README.md).

## Pipeline contract

`morpho-bots blue unhealthy-positions` discovers borrower/market pairs from rindexer, resolves the
immutable Blue market parameters, and reads the liquidation lens at the current chain head. It emits
one transparent JSON object per liquidatable, plannable position:

```json
{
  "kind": "position",
  "chainId": 8453,
  "id": "blue:unhealthy-positions:…",
  "marketId": "0x…",
  "borrower": "0x…",
  "market": {
    "loanToken": "0x…",
    "collateralToken": "0x…",
    "oracle": "0x…",
    "irm": "0x…",
    "lltv": "860000000000000000"
  },
  "seizableCollateral": "…",
  "repayAssets": "…",
  "observedAtBlock": 123
}
```

The sizing and block fields are advisory. `morpho-bots blue liquidate` validates the explicit
semantic fields, tolerates additional fields, and verifies that `market` hashes to `marketId`. It
then resolves the market and reads borrower state again, creates a fresh liquidation plan and quote,
and simulates the exact Executor call. It never decodes `id`; that string exists only for correlation
and queue deduplication.

Success emits only a transaction object:

```json
{"kind":"transaction","chainId":8453,"id":"…","to":"0x…","data":"0x…","value":"0","simulatedAtBlock":123}
```

Healthy positions, invalid inputs, missing routes, quote failures, and simulation reverts are
structured stderr logs and produce no stdout record. Consequently an operator can inspect or adapt
the seam without changing either program:

```sh
morpho-bots blue unhealthy-positions \
  | jq -c 'select(.market.collateralToken != "0x0000000000000000000000000000000000000000")' \
  | morpho-bots blue liquidate \
  | morpho-queued submit --chain 8453
```

## Liquidation algorithm

The source uses rindexer only to enumerate candidates; eligibility is decided by a fresh deployless
lens read. The transform plans a seize amount, obtains the configured collateral-to-loan quote,
encodes the Executor callback, and simulates from `LIQUIDATOR_ADDRESS`. The callback repays Morpho,
swaps seized collateral, and skims residual collateral and loan tokens to that recipient.

Mutable borrower and market accounting is never trusted from the source record. Immutable market
parameters are included to make the process boundary explicit and independently adaptable.

## Domain configuration

The CLI merges operator config and passes an environment-shaped table into each one-shot operation.
The source needs `CHAIN_ID`, `RPC_URL`, and `DATABASE_URL`. The transform additionally needs
`LIQUIDATOR_ADDRESS`, swap routing (`SWAP_CONFIG_PATH`), and the API key for each configured venue
(`ZEROX_API_KEY` or `ONEINCH_API_KEY`). `EXECUTOOOR_ADDRESS` and `LOG_LEVEL` are optional overrides.

Blue stages never read a signing key. They use one `RPC_URL`; separate send and fallback endpoints
belong neither to this package nor to the queue architecture.

## State ownership

The source cache contains immutable market-parameter resolutions and is disposable. The transform
has no durable transaction state. `morpho-queued serve` alone owns per-chain dedupe, authoritative
re-simulation, nonces, broadcast, replacement, and settlement. It receives transaction JSON over a
direct JSONL Unix socket; minimal acknowledgements are synchronous and terminal results live in its
append-only journal.

In armed operation, the distinct signer serves one chain and one Executor. It enforces zero value
and the Executor selector, signs an explicitly prepared transaction, and the queue verifies the
recovered sender and every prepared field. The signer does not decode nested Executor calls. Dry-run
queue operation skips the signer entirely.

## Tests

```sh
bun test packages/blue-liquidation/test
bun run --filter @repo/blue-liquidation typecheck
```
