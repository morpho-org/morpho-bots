# Midnight crossed-books resolver

Implements [MKT-1379](https://linear.app/morpho-labs/issue/MKT-1379/crossed-books-resolver-bot).

The bot pages the Morpho API for `listed=true` and `active_only=true` Midnight markets, then reads Router `asks` and `bids` takeable offers for each market. It greedily pairs the best raw crossed ticks, simulates the exact resolver call, and broadcasts only a simulation that clears `MIN_PROFIT_ASSETS`.

The permissionless `CrossedBooksResolver` needs no inventory. It takes the ask first. Midnight credits the resolver before `onBuy`; the callback sells those units into the bid, uses bid proceeds to pay the ask, and sends the positive loan-token balance delta to `msg.sender`. Same-market checks, settlement fees, rounding, stale offers, callbacks, and profit are atomic.

*Environment*

• `CHAIN_ID` — required, currently `8453`.
• `RPC_URL` — required. `RPC_URL_FALLBACK` optional.
• `RESOLVER_PRIVATE_KEY` — required `0x`-prefixed 32-byte bot key.
• `RESOLVER_ADDRESS` — optional deterministic deployment override.
• `API_BASE_URL` — default `https://api.morpho.org`.
• `MIN_PROFIT_ASSETS` — raw loan-token units, default `1`; one value applies to all markets.
• `SCAN_INTERVAL_MS` — default `15000`.
• `MAX_FEE_GWEI` — default `300`.

*Deploy contract*

```sh
RPC_URL=https://… DEPLOYER_PRIVATE_KEY=0x… \
MIDNIGHT_ADDRESS=0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A \
bun run --filter @repo/contracts deploy:crossed-books-resolver
```

*Run*

```sh
CHAIN_ID=8453 RPC_URL=https://… RESOLVER_PRIVATE_KEY=0x… \
bun run --filter @morpho-org/midnight-crossed-books start
```

The shared signer policy pins chain, resolver, `resolve` selector, zero ETH value, calldata, gas, and fee ceilings. The pending queue manages nonces and replacement. Every transaction is simulated byte-for-byte before submit.
