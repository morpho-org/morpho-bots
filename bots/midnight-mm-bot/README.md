# Midnight Market-Maker Bot

`midnight-mm-bot` publishes a fixed double ladder for a static list of Morpho Midnight markets on Base. Each market gets one bid group (`buy=true`) and one ask group (`buy=false`); levels on a side share one `maxUnits` cap.

## Safety model

- Uses `@morpho-org/midnight-sdk` for offers, groups, trees, Ecrecover signing, API validation, and payload encoding.
- Reads official Base Midnight, MidnightMempool, and EcrecoverRatifier addresses from `@morpho-org/morpho-ts`, verifies deployed code, and submits raw payloads to MidnightMempool.
- Validates every tree before and after signing. Deterministic non-overlapping epochs prevent double capacity; restart re-publication produces the same offers/root.
- Refuses publication without ratifier authorization, sufficient bid-side loan-token balance/allowance, sufficient accrued position credit through epoch expiry for the ask side, or under a gas fee above `MAX_FEE_GWEI`.

Ask fills sell the maker's existing position credit and never rely on crossing into new borrower debt. Bot does not manage inventory, take offers, or cancel roots. `DRY_RUN=true` performs reads, validation, signing, and encoding without broadcast.

## Configuration

Required: `RPC_URL`, `MAKER_PRIVATE_KEY`, `MIDNIGHT_MARKETS_JSON`, `TARGET_RATE_BPS`, `SPREAD_BPS`, `LADDER_LEVELS`, and `LADDER_RANGE_BPS`.

```json
[{"marketId":"0x...","maxUnits":"1000000"}]
```

`MIDNIGHT_MARKETS_JSON` contains only static per-market values: `marketId` and the raw protocol `maxUnits` cap. Quote shape is global across all configured markets:

- `TARGET_RATE_BPS` is the center fixed rate.
- `SPREAD_BPS` is the full inside spread, so each inside level is half the spread from target.
- `LADDER_LEVELS` is the number of offers on each side.
- `LADDER_RANGE_BPS` is the distance from target to each outermost level. It must be at least half the spread and no greater than the target.

For example, `TARGET_RATE_BPS=500`, `SPREAD_BPS=200`, `LADDER_LEVELS=3`, and `LADDER_RANGE_BPS=300` quote lower rates at 2%, 3%, and 4%, and upper rates at 6%, 7%, and 8%. Rates are converted to valid market ticks with the Midnight SDK using the market's on-chain tick spacing; startup publication rejects a ladder if snapping produces duplicate ticks.

Optional: `RPC_URL_FALLBACK`, `MIDNIGHT_API_URL` (default `https://api.morpho.org/v0/midnight`), `OFFER_TTL_SECONDS` (3600, min 600), `PUBLISH_LEAD_SECONDS` (300), `LOOP_INTERVAL_SECONDS` (30), `MAX_FEE_GWEI` (10), `DRY_RUN` (false), and `LOG_LEVEL` (info).

Before first publication, maker must approve Midnight for each loan token and call `setIsAuthorized(ecrecoverRatifier, true, maker)`.

```sh
bun install
bun run --filter @morpho-org/midnight-mm-bot typecheck
bun test bots/midnight-mm-bot/test
bun run --filter @morpho-org/midnight-mm-bot start
```
