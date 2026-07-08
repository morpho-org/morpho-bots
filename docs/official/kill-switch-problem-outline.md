# Oracle Failure Response for Vaults V1 Curators

This guide explains how advanced Morpho Vaults V1 curators should think about oracle staleness, price deviation, and oracle reverts in vault allocation contexts.

It focuses on the problem, the curator decisions it creates, and high-level mitigation options. It does not describe a maintained Morpho kill-switch bot implementation.

Important: Morpho is not shipping or maintaining an official kill-switch bot as part of this project. Curators may build their own automation, but any such system is curator-operated infrastructure and must be reviewed, tested, and monitored by the curator.

## Why Oracle Failures Matter

Morpho markets are oracle-agnostic. Each market has an immutable oracle selected by the market creator. This gives curators flexibility, but it also means oracle selection and monitoring are central parts of vault risk management.

For Vaults V1, a faulty oracle can create acute risk when the affected market is listed by a vault. If a vault continues accepting deposits while a listed market reports an incorrect price, new depositors can receive vault shares and increase the amount of vault supply exposed to the faulty market.

In the donation-based inflation manipulation scenario, a market whose oracle overestimates collateral value can put the entire vault at risk. Supply caps do not fully protect against this edge case because direct supply on behalf of the vault can still affect the vault's position. The immediate response is to pause deposits by emptying the supply queue.

## Failure Modes to Monitor

Curators should monitor every market that can receive new vault deposits through the live `supplyQueue`.

| Failure mode    | What it means                                                                      | Operational signal                                             |
| --------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Staleness       | The underlying oracle feed has not updated within the curator's acceptable window. | The feed's `updatedAt` is older than the configured threshold. |
| Price deviation | The market oracle price differs materially from an independent reference price.    | The difference exceeds the curator's deviation threshold.      |
| Oracle revert   | The market oracle cannot return a price.                                           | The oracle's `price()` call reverts.                           |

A single affected market can justify pausing deposits for the whole vault while the curator investigates.

## Impact and Risk Scenarios

### Deposits Continue During an Oracle Incident

If the supply queue remains open during an oracle incident, new deposits may continue entering the vault. This can increase the vault supply exposed to the affected market and complicate incident response.

For Vaults V1, the safest immediate mitigation is usually to empty the supply queue:

```text
setSupplyQueue([])
```

This pauses routing for new deposits until the curator intentionally re-adds markets.

### The Affected Market Remains in the Withdraw Queue

Emptying the supply queue does not remove a market from the withdraw queue and does not unwind existing exposure. If the affected market remains in the withdraw queue, the curator still needs to follow the relevant market removal or emergency process.

Do not treat an empty supply queue as a full unwind.

### The Oracle Reverts

When an oracle reverts, some market operations may stop working because borrowing, collateral withdrawal with debt, and liquidation require a price.

Users are not necessarily permanently stuck, but the market is degraded. Lenders may still withdraw when liquidity is available. Borrowers generally need to repay fully before withdrawing collateral. Liquidators cannot liquidate while the oracle reverts.

Curators should coordinate with the oracle provider if temporary restoration is needed for orderly exits.

## Immediate Mitigation: Empty the Supply Queue

For a suspected oracle failure affecting a market listed by a Vaults V1 vault, the immediate mitigation is to pause deposits by emptying the supply queue.

This action is available to the `Allocator` role in Vaults V1.

Emptying the supply queue is conservative, but it has important properties:

1. It pauses new deposit routing without requiring a market-by-market decision during the first response window.
2. It avoids race conditions created by selectively removing only one market from a stale local snapshot.
3. It is reversible once the curator has completed review and decides which markets are safe to re-add.

Important: Do not re-add any markets to the supply queue until the affected market has been fully addressed. Re-opening deposits before the affected market is removed or otherwise made safe can restore the attack vector.

## Follow-Up Mitigations

After deposits are paused, the curator should determine whether the affected market can be safely restored, unwound, or removed.

Recommended response:

1. Confirm the supply queue was emptied successfully.
2. Identify the affected market and oracle.
3. Independently verify whether the oracle is stale, deviating, or reverting.
4. Communicate the incident and expected operational steps to relevant stakeholders.
5. Set the affected market's supply cap to zero if appropriate.
6. Reallocate liquidity out of the affected market if it can be done safely.
7. Remove the affected market from the withdraw queue when normal or emergency removal requirements are met.
8. Re-add only healthy markets to the supply queue after the affected market has been addressed.

The exact sequence depends on market liquidity, oracle behavior, user positions, timelocks, and whether a standard or emergency removal path is available.

## Reference Price Selection

Price deviation monitoring requires an independent reference price. This is one of the most important curator decisions.

The reference should not be the same feed, wrapper, aggregation path, or data source that the Morpho oracle under review relies on. If the reference and the market oracle share the same failure mode, the deviation check may report that everything is healthy while both prices are wrong.

Use vendor-direct reference feeds where possible, such as an independent Chainlink, Pyth, RedStone, or comparable feed selected for the specific market.

Avoid automatic reference selection in production monitoring. Offchain aggregators can introduce circularity if they source, directly or indirectly, from the same oracle provider or market data path being tested.

If no independent reference is available, curators can still monitor staleness and reverting behavior, but should treat the market as having weaker automated coverage.

## Manual vs Automated Response

Curators can respond manually, automate parts of the response, or use a hybrid model.

| Approach                                | Benefits                                                            | Trade-offs                                                                               |
| --------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Manual monitoring and response          | Keeps judgment fully with the curator. Avoids automation mistakes.  | Requires a curator to be available and fast during incidents.                            |
| Alerting-only automation                | Improves visibility without giving software transaction authority.  | Still depends on manual execution under time pressure.                                   |
| Curator-operated transaction automation | Can empty the supply queue quickly when configured conditions fire. | Requires key management, monitoring, threshold tuning, testing, and incident procedures. |

If a curator chooses transaction automation, the signing address should normally be a dedicated Vaults V1 `Allocator` key for one vault. It should not be the `Owner`, `Curator`, `Guardian`, fee recipient, skim recipient, pending owner, or pending guardian address.

Using a dedicated allocator key limits blast radius. The key can perform the immediate supply queue action without broader administrative authority.

## Monitoring Checklist

At minimum, curator monitoring should cover:

- The current supply queue and every market in it.
- The oracle address for every market in the supply queue.
- Freshness data from the oracle provider's underlying feed or feeds.
- Independent reference prices for markets where deviation monitoring is possible.
- Reverting behavior from each market oracle's `price()` call.
- Whether the allocator address used for emergency response still has the required role.
- Native token balance for any address expected to submit emergency transactions.
- Recent queue changes, cap changes, and market additions.

Curators should dry-run any automated monitoring or transaction system before relying on it in production. Dry-runs should verify that thresholds are not too sensitive during normal market conditions and that synthetic incidents would produce the expected alert or action.

## Non-Goals

This guidance does not provide:

- A maintained Morpho kill-switch bot.
- A complete emergency unwind procedure for every market state.
- A recommendation to use one oracle provider over another.
- Automatic reference price selection.
- A guarantee that emptying the supply queue eliminates all vault risk.
- Coverage for Vaults V2 allocator mechanics.

Vaults V2 have a materially different allocation surface and should be evaluated separately.

## Summary

Oracle failures can create urgent operational decisions for Vaults V1 curators. The fastest first response is often to pause new deposits by emptying the supply queue, then investigate the affected oracle and market before re-opening deposits.

Curators should treat this as defense in depth: careful oracle selection, independent monitoring, conservative thresholds, practiced emergency procedures, and clear separation between alerting, transaction authority, and curator judgment.
