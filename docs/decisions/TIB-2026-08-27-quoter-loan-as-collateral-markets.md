# TIB-2026-08-27: Quoter-bot loan-as-collateral markets

| Field          | Value                                            |
| -------------- | ------------------------------------------------ |
| **Status**     | Proposed                                         |
| **Date**       | 2026-08-27                                       |
| **Author**     | @julien                                          |
| **Scope**      | Bot: quoter-bot                                  |
| **Supersedes** | TIB-2026-07-27-midnight-quoter-bot _(partially)_ |

---

## Context

A **loan-as-collateral market** is a Midnight market whose collateral list contains the loan asset
itself — for example loan = USDC, collaterals = {cbBTC, USDC} — with the loan-asset collateral
priced by a constant oracle at exactly 1 and, on the target markets, LLTV = 1. On such a market the
maker can post the loan asset as collateral and quote **both** sides of the book from zero
inventory. Midnight's take netting makes this a single-offer affair: a fill against a maker sell
consumes credit first and books the remainder as debt (`sellerCreditDecrease = min(units, credit)`,
`sellerDebtIncrease = units − sellerCreditDecrease`, L1581–1583), and a fill against a maker buy
repays debt before creating credit (`buyerCreditIncrease = zeroFloorSub(units, buyerDebt)`, L1581,
L1606–1612). Lower-rate sells published without `reduceOnly` therefore borrow on fill; higher-rate
buys lend — and automatically deleverage while debt is outstanding.

Debt is static face value: `Position` carries `credit` and `debt` with no time term (L1028–1036),
and no code path accrues debt. With a constant oracle and static collateral, `isHealthy`
(L2062–2078) is time-invariant, so collateral sized once for the worst case cannot be liquidated
before maturity even if the bot halts. Position bootstrap — acquiring credit at negative carry so
the sell side has something to reduce — becomes unnecessary. Today's ladder forbids all of this by
construction: every sell is `reduceOnly`, sell capacity is pinned to accrued credit, and
[TIB-2026-07-27](./TIB-2026-07-27-midnight-quoter-bot.md) §3 reserved the position-health check as
"mandatory before any strategy revision can increase collateralized debt". This TIB is that
revision: it decides how the quoter-bot's ladder supports these markets.

Line references (`L…`) cite the vendored Midnight source,
[midnight-contracts.txt](../context/repos/midnight-contracts.txt), pinned at commit `336b924a` —
the version deployed on Base.

> **Terminology.** Protocol "units" are face value at maturity, denominated in raw loan-token base
> units; `credit` and `debt` are units. Collateral is raw loan-token assets. At the self-collateral
> price of exactly `1e36` (`ORACLE_PRICE_SCALE`, L851) and LLTV `L`, the protocol's borrowing limit
> is `maxDebt = collateral × L / 1e18`, rounded down (L2062–2078).

## Goals / Non-Goals

**Goals**

- Quote both sides of a qualified loan-as-collateral book from zero inventory, with no bootstrap
  entry and no negative-carry credit acquisition.
- Make pre-maturity liquidation of the maker impossible **by construction** — a maturity-safe
  collateral requirement covering current debt plus every live sell's worst case — rather than by
  continuous monitoring.
- Keep the feature opt-in per market: without the new config block, behavior is byte-for-byte
  today's reduce-only, credit-capped ladder.
- Qualify markets fail-closed before quoting: loan-asset self-collateral, allowlisted constant
  oracle, disclosed settlement-penalty bound, gate checks.

**Non-Goals**

- Automated collateral withdrawal or position unwind. Withdrawal is the one operation that can
  strand resting sells — the protocol health-checks it against current debt only (L1751–1776) — so
  it stays manual; unwind is an operator runbook.
- A strategy-wide total-debt cap. Collateral is escrowed per market on-chain, so one market's debt
  cannot contaminate another; per-market caps bound the risk. A total cap is a capital-allocation
  preference (Future Considerations).
- Changing rate sources, ladder shape math, cross-book clearance
  ([TIB-2026-08-14](./TIB-2026-08-14-quoter-cross-book-clearance.md)), or buy-side exposure-cap
  semantics.
- Rollover into the next maturity — unchanged non-goal from TIB-2026-07-27.

## Current Solution

The no-debt invariant is implemented deliberately, not incidentally:

- [`production-ladder.ts`](../../bots/quoter-bot/src/infrastructure/ladder/production-ladder.ts)
  pins `creditSaleCapacityAssets` to the position's current credit, and
  [`ladder-capacity.utils.ts`](../../bots/quoter-bot/src/infrastructure/ladder/ladder-capacity.utils.ts)
  caps the lower-rate (sell) side at that credit — a fill can never create debt.
- [`ladder-offer.utils.ts`](../../bots/quoter-bot/src/infrastructure/ladder/ladder-offer.utils.ts)
  (`sideOffers`) hardcodes `reduceOnly: true` and `receiverIfMakerIsSeller: maker` on every sell.
- The ladder's `readMarket` reads only `position.credit` — never debt or collateral — plus wallet
  balance, allowance, and cash reservations. The bootstrap snapshot already reads debt —
  `MidnightPositionSnapshot` is `{marketId, credit, debt}` in
  [`bootstrap-position.service.ts`](../../bots/quoter-bot/src/infrastructure/bootstrap/bootstrap-position.service.ts)
  — so the ladder read is the one that lags.
- `checkPositionHealth()` in
  [`viem-setup-state.service.ts`](../../bots/quoter-bot/src/infrastructure/setup-state/viem-setup-state.service.ts)
  returns `not-required` with reason "V0 does not create collateralized debt" — the reserved port
  TIB-2026-07-27 §3 made mandatory for exactly this revision.
- [`setup-check.utils.ts`](../../bots/quoter-bot/src/application/setup/setup-check.utils.ts)'s
  `bookProblems` checks allowlist, active, loan asset, tick spacing, and maturity — nothing about
  collateral, oracles, or gates — and `marketFromContract` in
  [`viem-setup-state.utils.ts`](../../bots/quoter-bot/src/infrastructure/setup-state/viem-setup-state.utils.ts)
  deliberately projects only `{chainId, midnight, loanToken, maturity}`.
- `start` requires at least one bootstrap entry and one ladder entry; the sell side is funded by
  bootstrap's negative-carry credit acquisition.

## Proposed Solution

### 1. Central invariant — maturity-safe collateral

The on-chain loan-asset collateral must always cover the worst case of current debt plus every
live and prospective sell:

```text
worstCaseDebtUnits = debt + Σ over live and prospective sell groups of
                            ceil(remainingCapAssets × WAD / tickToPrice(tick))

requiredCollateral = ceil(worstCaseDebtUnits × WAD / lltv) × (1 + collateralBufferBps / 10⁴)
```

An asset-capped sell accumulates `sellerAssets` against `maxAssets` (L1566–1572); with tick price
below 1, the units a remaining cap can mint are strictly greater than its assets, and
`ceil(remainingCapAssets × WAD / tickToPrice(tick))` bounds them deterministically from the tick.
The requirement is **time-invariant** — debt does not accrue and the oracle is constant — so it is
sized per publication, not monitored. The publish gate: the post-publication requirement must be
`≤` on-chain collateral, otherwise the sell side shrinks through the existing
innermost-rungs-first allocator.

Consequences, stated explicitly:

- Pre-maturity liquidation of a covered maker is impossible even if the bot halts. "Nothing to
  monitor continuously" holds by construction; the per-cycle health assertion (§6) is a tripwire,
  not a control loop.
- A fill that would leave the maker-seller unhealthy **reverts for the taker**
  (`SellerIsLiquidatable`, L1679). Undercollateralized sells are un-takeable dead quotes, not a
  solvency hazard — the bot's coverage discipline is what keeps its offers takeable.
- The requirement deliberately ignores the position's credit (it assumes every sell unit becomes
  debt), so a `lossFactor` slashing of the maker's credit (L1830–1845) cannot invalidate coverage.
- A cap shared by offers at several ticks (per-book group mode) converts at the group's highest-rate
  — lowest-price — member tick, since any fill can land there; per-rung caps (shared-rung mode)
  convert at each rung's own tick.
- The requirement rounds up; headroom (§3) rounds down.
- `collateralBufferBps` has a validation-enforced floor: small, covering roundings — LLTV = 1
  markets need nothing more.

### 2. Opt-in per-market configuration

A ladder-market entry gains an optional `debt` block, a `targetRate`-style nested object following
[`market-collections.ts`](../../bots/quoter-bot/src/config/market-collections.ts) (exact records,
unknown keys rejected, quoted decimal-integer strings, whole-list env replacement):

```yaml
debt:
  maximumDebtAssets: '5000000000' # cap on face debt units, raw loan-token base units, positive
  collateralBufferBps: '50' # safety margin over the exact requirement, >= 10
```

An absent block preserves today's behavior byte-for-byte. A `debt` block on a market that fails
qualification (§6) fails startup. `LADDER_MARKETS` takes the same JSON fields as quoted decimal
strings. The cap is per-market only — no strategy-wide total (see Non-Goals).

### 3. Capacity integration

`calculateProductionLadderCapacities` gains a debt component:

```text
lowerRateCapacityAssets = min(credit, creditSaleCapacity) + debtHeadroomAssets

debtHeadroomUnits = max(0, min(maximumDebtAssets, collateralSupportedUnits)
                           − debt − liveSellWorstCaseUnits)
```

with the headroom converted units → assets conservatively at the innermost — highest-rate,
lowest-price — prospective sell tick, rounding down.
[`generateLadder`](../../bots/quoter-bot/src/domain/ladder/ladder.ts) is capacity-agnostic (it
takes `LadderMarketState` scalar capacities) and needs **no change**; only capacity derivation
changes. After generation, an exact per-rung coverage assertion validates the final tree before
publish — mirroring the existing validate-the-exact-payload ethos alongside
`assertLadderProspectiveSpread` — shrinking or failing closed on violation. The coverage math lives
in a new pure domain module (for example
`bots/quoter-bot/src/domain/ladder/debt-coverage.utils.ts`; utility isolation, arrow constants —
name illustrative).

### 4. reduceOnly switch and quote identity

Debt-enabled markets publish sells with `reduceOnly: false`; all other markets keep `true`
(`MakerCreditOrDebtIncreased` requires `sellerDebtIncrease == 0` on reduce-only sells, L1590–1594).
A single side suffices: protocol netting consumes credit before creating debt, so splitting rungs
into a reduce-only tranche plus a debt tranche is pointless (Alternative 1).

The critical edge case: the flag is part of the published offer (and group hash) but **not** of
`sameLadderQuoteSet`'s rung comparison —
[`ladder-quoter.service.ts`](../../bots/quoter-bot/src/application/ladder/ladder-quoter.service.ts)
decides `rest` on that comparison. The persisted publication and the quote-set identity must carry
the debt mode, so an operator toggling the block forces a `replace` instead of falsely resting on
live offers with the wrong flag.

### 5. Position read extension

The ladder `readMarket` additionally reads the position's debt, the loan-asset collateral balance
(locating the loan asset's index in the ascending-sorted `collateralParams`, L974–990), and live
group consumption for sell-cap bounds. `LadderMarketState` gains optional debt/collateral fields,
absent for non-debt markets. `@morpho-org/midnight-sdk` 1.3.0 already exposes the full read
surface (see Dependencies).

### 6. Setup qualification — per debt-enabled market, fail-closed, read-only

- The loan asset is in `collateralParams`; resolve and record its index.
- That entry's oracle is an **allowlisted constant-price implementation**: deployed bytecode
  matches a pinned constant-oracle artifact **and** a live `price()` read returns exactly `1e36` —
  the same pinning pattern as the existing ratifier bytecode check.
- Report `lltv`, `liquidationCursor`, the derived `maxLif` (L873–876), and the implied worst-case
  post-maturity settlement penalty `(maxLif − 1) × maximumDebtAssets`. The market ID
  content-addresses the entire `Market` struct (`IdLib.toId`, create2/SSTORE2, L286–304), so
  allowlisting the ID immutably accepts all of these — no drift monitoring is needed, but the
  operator sees what they accepted. Mutable per-market state is only `tickSpacing` (refine-only to
  divisors, L1443–1451), settlement fees (bounded per TTM breakpoint, at most 50 bps at 360 days,
  L1453–1470, L853–859), and `continuousFee` (at most 1%/year, L1482–1490, L860).
- `enterGate` is zero **or** `canIncreaseDebt(maker)` returns true (L1595–1604) — rechecked every
  cycle, because the gate address is immutable but its answer is an external contract call.
  `liquidatorGate` is observed and reported: it gates liquidators, not the maker, and a restrictive
  one can delay post-maturity settlement.
- `checkPositionHealth` becomes a real check for debt-enabled markets — the coverage invariant over
  the current position plus live sells, catching a maker returning after downtime. It stays
  `not-required` otherwise.

### 7. Runtime posture on coverage breach

| Situation                           | Posture                                                   |
| ----------------------------------- | --------------------------------------------------------- |
| Desired sells do not fit collateral | Capacity shrink — the normal §1/§3 path, no event drama   |
| Debt + live sells exceed collateral | Market-local **sell-side** invalidation plus a loud event |

The second case is external interference — an authorized key withdrew collateral, unexpected
state. Buys **keep quoting** because buy fills repay debt (L1581, L1606) — the only self-repair
channel. Existing hard-halt semantics are untouched: config/reference/decision failures still
request a strategy-wide hard halt, and a market-read failure still invalidates market-locally
while other markets continue
([`ladder-quoter.service.ts`](../../bots/quoter-bot/src/application/ladder/ladder-quoter.service.ts)).
Hard-halting everything on breach was rejected (Alternative 5).

### 8. Collateral management — manual first

Phases 1 and 2 ship with the bot **never moving collateral**. `supplyCollateral` requires
`onBehalf == msg.sender` or authorization (anti-collateral-poisoning) and pulls tokens from
`msg.sender` (L1726–1749), so the operator — or an authorized treasury address funding the maker
position from its own wallet — supplies out-of-band. The bot reads, validates, sizes, and reports
the exact remediation transaction without executing it, in the setup-check remediation style.

Auto-supply (Phase 3) goes through the serialized mutation queue with a transaction policy
assertion pinning target = Midnight, the `supplyCollateral` selector, the market, the loan-asset
collateral index, `onBehalf = maker`, and a bounded amount (the
`assertLadderCancellationTransaction` pattern), plus an allowance-floor extension: setup's
allowance check must then cover lend exposure plus the collateral target. Automated **withdrawal**
stays out of scope entirely — the protocol health-checks `withdrawCollateral` against current debt
only (L1751–1776), never against resting sells, so it is the single operation that can strand the
live book; the bot must gate any future withdrawal below the live-book requirement, and every
phase here simply never withdraws. Unwind — repay, flash-loan repay-then-withdraw, maturity
handling — is an operator runbook plus Future Considerations.

### 9. Maturity posture

Sell offers already expire at maturity, and `CannotIncreaseDebtPostMaturity` (L1590) blocks new
debt after it. Outstanding debt at maturity settles by post-maturity liquidation: every debt
position is liquidatable once `block.timestamp > maturity` (L1824–1828) — that **is** the
settlement mechanism — with the LIF ramping linearly from 1 at maturity to `maxLif` over
`TIME_TO_MAX_LIF` = 60 minutes (L1850–1852, L861). At LLTV = 1, `maxLif = 1` and there is **no
liquidation incentive**: liquidators repay at exactly the oracle price plus roundings (contract
header, L1190–1193), so settling a USDC-collateral/USDC-debt position at price 1 is penalty-free
and the position needs no bot action. For `lltv < 1` the worst-case penalty is
`(maxLif − 1) × debt`, bounded and computable at configuration time — market creation enforces
`maxLif ≤ 2` and `lltv × maxLif ≤ 0.999` unless `lltv = 1` (L1974–1976). A covered position
realizes zero bad debt: bad debt is computed against the `maxLif` worst case (L1817–1820).

The operator runbook documents the voluntary alternative: `repay` (no health check, no maturity
restriction, maker or authorized, L1705–1724) then `withdrawCollateral`, optionally atomic through
Midnight's fee-free `flashLoan` (L1940–1955). Self-take is not an unwind path (`SelfTake`
forbidden, L1549). Rollover into a next maturity remains an explicit operator decision.

### 10. What this obsoletes and touches

- **Bootstrap** becomes unnecessary for these markets — the point of the feature. The market's
  bootstrap entry is simply omitted, and `start` must accept an empty bootstrap list (today it
  requires at least one entry). Cross-book clearance (TIB-2026-08-14) is untouched and still
  applies when both are configured.
- **Buy-side capital:** supplying collateral converts wallet cash (buy capacity) into sell
  backing. Sells return cash on fill — proceeds go to `receiverIfMakerIsSeller = maker` at the
  full offer price, the settlement fee being a taker-side price spread (L1557–1563) — replenishing
  buy capacity next cycle; buys with debt outstanding repay debt instead of adding credit
  (netting). The README's inventory-movement narrative is extended at implementation time.
- **Exposure caps:** existing lend-exposure caps are unchanged — they cap buys, and are
  conservative while debt is outstanding, since those buys repay rather than add credit.
  `maximumDebtAssets` is the sell-side symmetric cap.
- **Fees:** the continuous fee applies to credit only — `pendingFee` accrues at buy fill
  (L1584–1585), and takes revert when the market fee exceeds the offer's `continuousFeeCap`
  (L1545); debt pays no fee, which is part of why debt is static face value.
- **KMS middleware** ([TIB-2026-08-12](./TIB-2026-08-12-quoter-bot-kms-signing-middleware.md)):
  needs intents for trees containing non-reduce-only sells and, in Phase 3, `supplyCollateral`;
  middleware mode stays fail-closed for these writes until those land.

### Implementation Phases

- **Phase 1 — qualification and read surface:** config block plus validation, setup qualification
  checks including the real position-health check, ladder position/collateral/debt reads, the pure
  coverage-math domain module, read-only rendering. No live-behavior change without the config
  block.
- **Phase 2 — debt-capable sell side:** capacity integration, the `reduceOnly` switch with the
  mode carried in quote identity and persisted publications, the exact pre-publish coverage
  assertion, the breach posture, empty-bootstrap `start`, observability fields; confirm Morpho API
  mempool-validation and takeability support (Open Questions).
- **Phase 3 — collateral auto-supply:** the mutation-queue transaction, policy assertions,
  allowance extension, and middleware intents. Withdrawal and unwind automation deliberately
  excluded.

## Considered Alternatives

### Alternative 1: Split sells into a reduce-only tranche plus a debt tranche

Publish, per rung, one `reduceOnly` sell sized to credit and one debt-creating sell.

**Why rejected:** Protocol netting makes a single non-reduce-only sell economically identical —
credit is consumed before any debt is created (L1581–1583). Splitting doubles offers and groups
and collides ticks.

### Alternative 2: Reactive collateral management

Hold thin collateral and top up as fills land.

**Why rejected:** It makes bot liveness a solvency dependency and reintroduces the continuous
monitoring obligation that static maturity-safe coverage removes — removing that obligation is the
premise of the feature. Reactive top-ups remain possible later **inside** the invariant as a
capital optimization.

### Alternative 3: A separate debt-quoting workflow or bot

**Why rejected:** Same book, same maker, same serialized mutation queue, same whole-book spread
validation. A separate writer would duplicate the reconciliation machinery when the ladder's
capacity seam was designed for exactly this extension.

### Alternative 4: Keep bootstrap-based inventory for these markets

**Why rejected:** Negative-carry bootstrap cost, a sell side forever capped by acquired credit,
and a slower path to two-sided quoting. The contract's documented LLTV = 1 special case
(L1190–1193) shows loan-as-collateral is the protocol-intended maker pattern here.

### Alternative 5: Hard-halt on runtime coverage breach

**Why rejected:** Exiting removes the deleveraging channel — buys are the only self-repair path —
while the on-chain fill-time check (L1679) already prevents harm from uncovered sells. See §7.

## Assumptions & Constraints

- Target markets list the loan asset as a collateral with a code-verifiable constant oracle
  returning exactly `1e36`. Expected `lltv = 1e18` (penalty-free settlement); `lltv < 1` markets
  are supported by the same math but surface a nonzero disclosed settlement-penalty bound.
- Midnight singleton semantics as pinned (`336b924a`): take netting, the post-fill seller health
  requirement, time-invariant `isHealthy`, post-maturity settlement liquidation. The vendored
  source is the reference.
- Market IDs immutably commit to all market params; allowlisting an ID is accepting its
  collateral, oracle, gate, and maturity surface.
- `@morpho-org/midnight-sdk` ≥ 1.3.0 position/market surface.
- Collateral is escrowed per market; no cross-market debt contagion.
- TIB-2026-07-27's V0/V1 capital gates still apply — posting collateral raises capital at the hot
  maker, and a material increase stays gated on the V1 custody/ratifier controls.
- Chain truth on restart is preserved: debt, collateral, and consumption are re-read fresh; the
  only new durable state is the debt-mode flag in persisted publication intents.
- Oracle liveness: if an activated collateral's oracle reverts, `take` (when the seller has debt),
  `withdrawCollateral`, `isHealthy`, and `liquidate` revert (L1320–1327) — and per the `336b924a`
  delta note (L6–13), the deployed revision makes `supplyCollateral` revert on an oracle revert
  too. The bytecode allowlist pins a constant implementation with no revert path.
- Activating the loan-asset collateral consumes one of the maker's 16 collateral slots per market
  (`MAX_COLLATERALS_PER_BORROWER`, L863) — no practical constraint while the maker activates only
  this one.

## Dependencies

- `@morpho-org/midnight-sdk` ≥ 1.3.0 (installed): the `Position` entity exposes
  `user`/`marketId`/`credit`/`pendingFee`/`debt`/`collateralBitmap`/`collateral[]`; `MarketParams`
  exposes `collateralParams` `{token, lltv, liquidationCursor, oracle}`; `midnightAbi` includes
  `supplyCollateral`/`withdrawCollateral`/`isHealthy`/`repay`; `TickLib` has `tickToPrice` and
  `tickToApr`. The SDK has **no** maxDebt/health helper and **no** collateral or repay transaction
  builder — the SDK-first evidence for a local pure coverage-math domain module plus viem
  `encodeFunctionData` against the SDK ABI.
- [TIB-2026-08-12](./TIB-2026-08-12-quoter-bot-kms-signing-middleware.md) for middleware-mode
  intent coverage; the Phase 2/3 writes stay fail-closed there until the intents land.
- The pinned vendored source [midnight-contracts.txt](../context/repos/midnight-contracts.txt) for
  every protocol claim above.

## Observability

Per-cycle and verbose fields for debt-enabled markets: collateral, debt, required collateral,
headroom, coverage ratio, and the debt-funded share of the sell side. New events: a collateral
remediation request (manual phase), coverage breach with sell freeze, and — in Phase 3 —
collateral transaction submissions. Alerting guidance: alert on the coverage-breach event; an
approaching-maturity-with-outstanding-debt signal is informational at LLTV = 1, where settlement
is penalty-free and needs no action. BetterStack queries follow the existing README examples.

## Security

- **Constant-oracle bytecode allowlist** — a new trust anchor, pinned like the existing ratifier
  bytecode check: artifact match plus a live `price() == 1e36` read.
- **Market-ID commitment** — the ID content-addresses every parameter (L286–304); allowlisting is
  the acceptance boundary, so there is no post-acceptance parameter drift to monitor.
- **Gate-answer mutability** — `enterGate`'s address is immutable but its answer is an external
  call (L1595–1604); the per-cycle `canIncreaseDebt(maker)` recheck fails closed. Residual risk: a
  gate flipping mid-cycle makes live sells revert for takers until the next cycle reacts.
- **Withdrawal gating** — the protocol checks only current debt on `withdrawCollateral`
  (L1751–1776); bot policy must gate any future withdrawal below the live-book requirement, and
  the phases in this TIB never withdraw.
- **Transaction policy** — every new transaction type carries an exact policy assertion (§8);
  middleware intents stay fail-closed until scheduled (TIB-2026-08-12).
- **Maker as borrower** — Morpho's own `midnight-liquidation` bot would list the maker as a
  candidate if it were ever unhealthy. Pre-maturity it cannot be while covered; post-maturity
  seizure at LLTV = 1 is the intended, penalty-free settlement.
- **Slashing** — other borrowers' realized bad debt slashes lenders' credit via `lossFactor`
  (L1256–1258, L1830–1845). It touches the maker's credit — the buy side, a pre-existing lender
  risk on every market — never its debt or collateral, and the coverage requirement ignores credit
  (§1), so coverage survives a slash.
- **"No negative credit" becomes conditional** — TIB-2026-07-27's §7 invariant and Security
  posture hold verbatim for markets without a `debt` block; for debt-enabled markets they are
  replaced by the coverage invariant.

## Testing and Verification

- **Domain:** coverage math — requirement rounds up and headroom down, units ↔ assets conversion
  at the tick price, the per-book worst case at the group's highest-rate tick, merged same-tick
  rungs, the buffer floor.
- **Application:** a mode flip forces `replace`; capacity shrink; breach produces sell freeze
  while buys continue; config validation (absent block, invalid block, block on an unqualified
  market).
- **Fork (Anvil, the existing e2e harness):** `touchMarket` is permissionless (L1958–1996), so the
  fork creates a loan-as-collateral market — USDC loan, USDC collateral at `lltv = 1e18` with a
  deployed constant oracle — and covers `supplyCollateral`, a non-reduce-only sell take creating
  debt, a buy take netting debt down, the `SellerIsLiquidatable` revert when uncovered, the
  `withdrawCollateral` health gate, post-maturity `repay` plus `withdrawCollateral`, and
  post-maturity liquidation at LIF = 1.
- Repository test discipline applies: run each test, temporarily break one assertion to confirm it
  fails, restore.

## Future Considerations

- A strategy-wide total-debt cap, if operators want one on top of per-market caps (Open
  Questions).
- Reactive collateral top-ups **inside** the invariant, as capital optimization (Alternative 2).
- Withdrawal and unwind automation — repay, flash-loan repay-then-withdraw, maturity handling —
  once the manual runbook has operational mileage.

## Open Questions

1. **Morpho API:** do mempool policy validation and the takeable-offers/books endpoints accept and
   surface collateral-backed non-reduce-only sells — maker takeability computed from health, not
   just credit? Blocking for the Phase 2 rollout; the on-chain fill-time checks are authoritative
   regardless. (Every tree already passes `tree.mempoolValidate` before and after ratification.)
2. Production market parameters for the first target market: exact `lltv` (`1e18` expected),
   `liquidationCursor`, and the constant-oracle implementation address to pin.
3. Whether operators want a strategy-wide total-debt cap in addition to per-market caps.
4. The quoter-signer (TIB-2026-08-12) intent schedule for non-reduce-only trees and
   `supplyCollateral`.

## References

- [TIB-2026-07-27-midnight-quoter-bot](./TIB-2026-07-27-midnight-quoter-bot.md) — §3 (reserved
  position-health check), §7 (the "cannot create negative credit or unintended debt" invariant),
  the Security "No negative credit" posture, and the position-health Non-Goal: what this TIB
  partially supersedes, for debt-enabled markets only.
- [TIB-2026-08-14-quoter-cross-book-clearance](./TIB-2026-08-14-quoter-cross-book-clearance.md) —
  untouched; still applies when bootstrap and ladder are both configured.
- [TIB-2026-08-12-quoter-bot-kms-signing-middleware](./TIB-2026-08-12-quoter-bot-kms-signing-middleware.md)
  — intent coverage for the new writes.
- [TIB-2026-08-04-extract-quoter-bot-shared-packages](./TIB-2026-08-04-extract-quoter-bot-shared-packages.md)
- [midnight-contracts.txt](../context/repos/midnight-contracts.txt) — the pinned vendored source
  behind every line reference.
- [`ladder.ts`](../../bots/quoter-bot/src/domain/ladder/ladder.ts),
  [`ladder-capacity.utils.ts`](../../bots/quoter-bot/src/infrastructure/ladder/ladder-capacity.utils.ts),
  [`production-ladder.ts`](../../bots/quoter-bot/src/infrastructure/ladder/production-ladder.ts),
  [`ladder-offer.utils.ts`](../../bots/quoter-bot/src/infrastructure/ladder/ladder-offer.utils.ts),
  [`ladder-quoter.service.ts`](../../bots/quoter-bot/src/application/ladder/ladder-quoter.service.ts),
  [`setup-check.service.ts`](../../bots/quoter-bot/src/application/setup/setup-check.service.ts),
  [`viem-setup-state.service.ts`](../../bots/quoter-bot/src/infrastructure/setup-state/viem-setup-state.service.ts)
  — the seams this TIB extends.
- [Quoter bot Linear project](https://linear.app/morpho-labs/project/market-making-bot-628e80069e52/overview)
- [Initial Base Midnight market](https://markets.morpho.org/fixed/base/0x05959752fdeff325962b9d263edb421efc6e2186a49360dba6c32e86ebf6c84c?orderType=limit)

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
