# Midnight Market-Maker Bot

`midnight-mm-bot` publishes a fixed double ladder for a static list of Morpho Midnight markets on Base. Each market gets one bid group (`buy=true`) and one ask group (`buy=false`); levels on a side share one `maxUnits` cap.

## Safety model

- Uses `@morpho-org/midnight-sdk` for offers, groups, trees, Ecrecover signing, API validation, and payload encoding.
- Reads official Base Midnight, MidnightMempool, and EcrecoverRatifier addresses from `@morpho-org/morpho-ts`, verifies deployed code, and submits raw payloads to MidnightMempool.
- Validates every tree before and after signing. Deterministic non-overlapping epochs prevent double capacity; restart re-publication produces the same offers/root.
- Refuses publication without ratifier authorization, sufficient bid-side loan-token balance/allowance, or under a gas fee above `MAX_FEE_GWEI`.

Operator must separately supply enough collateral/credit for ask fills. Bot does not manage inventory, take offers, or cancel roots. `DRY_RUN=true` performs reads, validation, signing, and encoding without broadcast.

## Configuration

Required: `RPC_URL`, `MAKER_PRIVATE_KEY`, and `MIDNIGHT_MARKETS_JSON`.

```json
[{"marketId":"0x...","midTick":5000,"halfSpreadTicks":8,"levelStepTicks":4,"levels":3,"maxUnits":"1000000"}]
```

`maxUnits` is a raw protocol amount. Tick inputs must align with on-chain tick spacing. Price falls as tick rises, so bids are `mid + spread + level*step`; asks are `mid - spread - level*step`.

Optional: `RPC_URL_FALLBACK`, `MIDNIGHT_API_URL` (default `https://api.morpho.org/v0/midnight`), `OFFER_TTL_SECONDS` (3600, min 600), `PUBLISH_LEAD_SECONDS` (300), `LOOP_INTERVAL_SECONDS` (30), `MAX_FEE_GWEI` (10), `DRY_RUN` (false), and `LOG_LEVEL` (info).

Before first publication, maker must approve Midnight for each loan token and call `setIsAuthorized(ecrecoverRatifier, true, maker)`.

```sh
bun install
bun run --filter @morpho-org/midnight-mm-bot typecheck
bun test bots/midnight-mm-bot/test
bun run --filter @morpho-org/midnight-mm-bot start
```
