# `mm` — local Midnight market maker CLI

`mm` is a local-only command-line tool. It has no Docker, Railway, or deployment surface.

## Make offers

```bash
bun run bots/mm/src/index.ts make \
  --market-id 0x... \
  --chain-id 8453 \
  --target 450 \
  --spread 100 \
  --private-key 0x... \
  --rpc-url https://... \
  --group-id desk-a \
  --dry-run
```

`target` and `spread` are basis points. The command reads and prints the maker's loan-token balance,
Midnight allowance, accrued credit, and both offer summaries. The buy offer is capped by
`min(balance, allowance)`. The sell offer is reduce-only and capped by current accrued net credit.

The first confirmation signs exactly two SDK-built offers. A live run asks for a second confirmation
immediately before submitting the encoded payload to the onchain Midnight mempool. `--dry-run`
signs, validates, and persists the payload without sending a transaction.

`--group-id` is a local logical id. If omitted, `mm` generates a UUID. Protocol group ids are always
content-addressed by `Group.create`; `mm` stores the mapping from the logical id to the separate buy
and sell protocol group ids. Reusing a logical id is rejected.

## Cancel offers

```bash
bun run bots/mm/src/index.ts cancel desk-a \
  --chain-id 8453 \
  --private-key 0x... \
  --rpc-url https://...
```

Cancellation loads both protocol group ids from the local registry and calls
`Midnight.setConsumed(group, uint128.max, maker)` for each one. Cancellation receipts are persisted.
Add `--dry-run` to inspect the planned revocations without broadcasting.

## Environment and local files

Flags take precedence over these environment variables:

- `MM_CHAIN_ID`
- `MM_PRIVATE_KEY`
- `MM_RPC_URL`
- `MM_HOME` (defaults to `~/.mm`)

Make artifacts are written under `~/.mm/makes`, cancel artifacts under `~/.mm/cancels`, and the
logical-to-protocol group mapping in `~/.mm/registry.json`. Files are created with owner-only
permissions. Never commit a private key or the local registry.
