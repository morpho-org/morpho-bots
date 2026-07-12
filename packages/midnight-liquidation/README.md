# Midnight liquidation

`@repo/midnight-liquidation` implements the two one-shot Midnight pipeline operations. Deployment
and process supervision belong to [`bots/README.md`](../../bots/README.md).

## Pipeline contract

`morpho-bots midnight unhealthy-positions` refreshes the listed-market filter, discovers borrowers,
and reads the liquidation lens at the current head. It emits transparent position JSON:

```json
{
  "kind": "position",
  "chainId": 8453,
  "id": "midnight:unhealthy-positions:…",
  "marketId": "0x…",
  "borrower": "0x…",
  "loanToken": "0x…",
  "collateralToken": "0x…",
  "collateralIndex": 0,
  "seizedAssets": "…",
  "repaidUnits": "…",
  "postMaturityMode": false,
  "observedAtBlock": 123
}
```

`marketId` and `borrower` are the semantic input to `morpho-bots midnight liquidate`; sizing and
token fields are advisory. The transform validates its required fields, ignores additive fields,
and re-reads the complete mutable market and borrower state before planning, quoting, encoding, and
simulating. It never decodes `id`, which is only a correlation and queue-deduplication label.

Success emits only a transaction object:

```json
{"kind":"transaction","chainId":8453,"id":"…","to":"0x…","data":"0x…","value":"0","simulatedAtBlock":123}
```

Invalid inputs and non-actions are structured stderr logs, as are unavailable routes, quote failures,
and simulation reverts. stdout therefore remains composable data:

```sh
morpho-bots midnight unhealthy-positions \
  | jq -c 'select(.postMaturityMode or (.seizedAssets | tonumber) > 0)' \
  | morpho-bots midnight liquidate \
  | morpho-queued submit --chain 8453
```

## Liquidation algorithm

Discovery is filtered through the current listed-market set. A deployless lens evaluates health,
locks, liquidator gates, maturity, bad debt, and the best eligible collateral. The transform applies
the configured seize-cap margin and requests a firm collateral-to-loan quote. Venue selection uses
background probes without placing them ahead of live firm quotes.

Ordinary liquidations execute the Midnight call through the Executor callback, swap seized
collateral, repay the loan token, and skim residual balances to `LIQUIDATOR_ADDRESS`. A pure bad-debt
realization has no asset transfer and therefore skips quoting while still being freshly simulated.

## Domain configuration

Both operations need `CHAIN_ID` and `RPC_URL`. The source uses
`LIQUIDATION_CANDIDATES_API_URL` and `MARKETS_API_URL` overrides when configured. The transform also
needs `LIQUIDATOR_ADDRESS` and venue credentials (`ZEROX_API_KEY` and/or `ONEINCH_API_KEY`); it may
override the corresponding venue base URLs. `EXECUTOOOR_ADDRESS` and `LOG_LEVEL` are optional.

Midnight stages never read a signing key. They use one `RPC_URL`; separate send and fallback
endpoints are not part of the architecture.

## State ownership

The source cache is the disposable listed-market snapshot. The transform cache contains only venue
selection hints; it is not transaction state. `morpho-queued serve` alone owns per-chain dedupe,
authoritative re-simulation, nonces, broadcast, replacement, and settlement. `submit` streams
transaction JSON directly over the Unix socket, receives minimal acknowledgements, and terminal
results are appended to the queue journal.

Armed operation uses a distinct one-chain/one-Executor signer with hard-coded zero-value and entry
selector invariants. The queue requests an explicit prepared-transaction signature and verifies the
recovered sender and every prepared field. The signer does not decode nested Executor calls. Dry-run
queue operation starts no signer.

## Tests

```sh
bun test packages/midnight-liquidation/test
bun run --filter @repo/midnight-liquidation typecheck
```
