# Protocol validators: specification

Status: the specification of `@repo/validators`, the protocol validators a bot hands its kernel. It
implements the validator contract in [kernel SPEC §9.1](../kernel/SPEC.md#91-contract) and adds
nothing to it. A validator is the funds boundary: the kernel signs only what one reads as allowed,
and the kernel SPEC notes that no kernel check catches a validator that reads too little. Each
section below is that validator's whole claim.

- [`src/`](./src) holds one module per validator. Where this document and the code disagree, one of
  them is wrong, and either way it is a bug.
- [`test/`](./test) holds the conformance tests. `test/readings/*.json` pins every recorded case's
  reading under the validator's `id@version`. Re-record a case only with a version bump
  (`RECORD_READINGS=1` adds a version or case and never rewrites one).
- Run them with `pnpm --filter @repo/validators run test` and
  `pnpm --filter @repo/validators run typecheck`.

## 1. What every validator here guarantees

- **Plain data in, refusal out.** Each validator reads only the payload and the step's witness, in
  the ledger's plain form. It refuses any shape it does not fully understand, with a fixed reason
  string, and does not throw ("refuses %s", "refuses a witness with %s").
- **No chain reads.** A validator reads no chain state and makes no network call. Everything it
  checks against comes from the witness the bot read and the kernel recorded with the step (review).
- **Pinned readings.** A change to what a validator claims or allows changes a recorded case and
  fails its test until the validator's `version` is bumped ("reads as recorded under").

## 2. Vault reallocation

Both validators below claim a vault's own reallocation call, and share two properties:

- **Nothing is committed.** An allowed call reads as creating, exposing, carrying, retiring and
  consuming nothing. A reallocation moves the vault's own assets, so the account holds nothing a
  later crash could leave exposed, and `confirm` accepts any successful receipt ("reads a
  reallocation within the vault configuration as creating no commitment", "reads a reallocation
  within every cap as creating no commitment").
- **The vault has the last word.** The validator checks the call against the vault as the witness
  reads it. The vault re-checks roles, caps and balances against its live state when the call
  executes, so a stale witness can cost a reverted transaction but cannot move assets past a cap
  (review).

### 2.1 Vault V1

`vaultV1ReallocationValidator({ vaults })`, id `vault-v1-reallocation`, version 1. Assumes Morpho
Vault V1 `reallocate(MarketAllocation[])` as encoded by `@morpho-org/morpho-ts` 2.10.0
(review).

**Claims** every transaction whose `to` is one of `vaults`, and nothing else ("claims only
transactions to a configured vault").

**Witness:** `VaultV1Witness`, the vault's withdraw-queue markets at the decision's read, each with its
32-byte id, its supply cap and the vault's assets in it. A witness with no markets, a malformed
market, or a market listed twice is refused ("refuses a witness with %s").

**Allows** a zero-value call whose calldata is exactly `reallocate`, re-encoding to the same
bytes, where:

- every leg names a market in the witness, at most once ("refuses %s": a market outside the
  configuration, a market allocated twice);
- only the last leg may take the rest (`type(uint256).max`) ("refuses %s": the rest taken before the
  last leg);
- no leg that supplies leaves its market above its cap, counting the last leg's rest as everything
  withdrawn and not yet supplied ("caps what the last leg takes: everything withdrawn and not yet
  supplied", and "refuses %s": an allocation over its cap);
- a leg that supplies nothing is skipped before its cap is checked, as the vault does, so a market
  already over a lowered cap can still be withdrawn from or left alone ("reads a leg that supplies
  nothing to a market already over its cap", "reads a withdrawal from a market already over its
  lowered cap").

**Refuses** anything else, including another vault function, a value-bearing call, an empty
`reallocate`, truncated or trailing calldata, and every payload that is not a transaction to a
configured vault ("refuses %s", "refuses a payload that is not a transaction, or to another
vault").

### 2.2 Vault V2

`vaultV2ReallocationValidator({ adapters })`, id `vault-v2-reallocation`, version 1. `adapters` maps
each whitelisted VaultV2 to its one Morpho Market V1 adapter. Assumes VaultV2 `multicall`,
`allocate` and `deallocate` as encoded by `@morpho-org/morpho-ts` 2.10.0, and Blue's share math as
`@morpho-org/blue-sdk` 6.7.0 implements it (review).

**Refuses to be built** when `adapters` names a vault twice, in any letter case, or holds a key or
value that is not an address or carries a wrong checksum, so no configuration leaves which adapter a
vault uses up to key order or to a typo ("refuses to be built with %s").

**Claims** every transaction whose `to` is a vault in `adapters`, and nothing else ("claims only
transactions to a configured vault").

**Witness:** `VaultV2Witness` holds the vault's total assets, the basis for relative caps. It also holds every cap id the
legs touch, with its absolute cap, relative cap and stored allocation, and the adapter's supply shares in each
of its markets, with that market's supply totals. A malformed, duplicated or missing entry is
refused ("refuses a witness with %s", "refuses a leg whose caps the witness does not name").

**Allows** a zero-value `multicall`, re-encoding to the same bytes, of `deallocate` legs followed by
`allocate` legs, where:

- every leg names the vault's configured adapter, moves a non-zero amount, and carries adapter data
  that is exactly one market the adapter holds in the witness ("refuses %s": an unknown adapter, a leg
  that moves nothing, adapter data that is not one market, a market outside the adapter);
- no deallocation follows an allocation ("refuses %s": a deallocation after an allocation);
- each leg is replayed in order against the witness. Shares move as Blue's `supply` and `withdraw`
  round them, and the adapter's new allocation is its shares converted back to assets rounding down
  ("rounds as Blue and the adapter do");
- each leg moves the market, collateral and adapter cap ids (`vaultV2CapIds`) by the change from
  the market's stored allocation, so growth since the last allocation counts against the caps
  ("counts a position grown past its stored allocation against the caps");
- after an allocating leg, each of the three ids is within its absolute cap and, unless its relative
  cap is exactly WAD, within that fraction of the vault's total assets ("reads an allocation that
  lands exactly on each cap", "refuses an allocation over its %s absolute cap", "refuses an
  allocation over its %s relative cap");
- an allocation never mints fewer shares than assets, and a deallocation never burns more shares
  than the position holds ("refuses an allocation that would mint fewer shares than assets",
  and "refuses %s": a deallocation past its position);
- a deallocation is never refused for a cap, so a market over a lowered cap can still be drained
  ("lets a deallocation leave a market already over a lowered cap").

**Refuses** anything else, including an inner call that is not `allocate` or `deallocate`, trailing
bytes in the outer or any inner call, and every payload that is not a transaction to a configured
vault ("refuses %s", "refuses a payload that is not a transaction, or to another vault").

## What is deliberately left out

- **Roles and timelocks.** Neither validator checks that the account holds the allocator role, or
  that a cap change is pending. The vault reverts such a call, and the kernel's simulation catches
  the revert before signing.
- **Economic judgement.** Whether a reallocation is worth its gas, or moves toward a better rate, is
  the bot's strategy. A validator bounds what the call may do, not whether it should be sent.
- **Other protocols' validators.** Midnight offers, crossed-book settlement and executor
  liquidation join this package, and this document, when their bots are ported.
