# TIB-2026-08-12: Quoter-bot KMS signing policy middleware

| Field      | Value           |
| ---------- | --------------- |
| **Status** | Proposed        |
| **Date**   | 2026-08-12      |
| **Author** | @julien         |
| **Scope**  | Bot: quoter-bot |

---

## Context

The quoter bot's `aws` signer identity moved the maker key into AWS KMS: the key is never
exported, and
[`createKmsAccount`](../../bots/quoter-bot/src/infrastructure/make/maker-account.utils.ts)
performs strict SPKI/DER parsing, low-s normalization, and a recovery check against the configured
maker. **Custody is solved. Authorization is not.** KMS receives only an opaque 32-byte keccak
digest (`MessageType: 'DIGEST'`), and IAM controls _who_ may call `kms:Sign` — it has no condition
keys on message content. Any principal holding `kms:Sign`, including a fully compromised bot host,
can therefore obtain a valid maker signature over _anything_: a `transfer`/`approve` transaction
draining the EOA, or an arbitrary EIP-712 payload such as an ERC-2612/Permit2 permit that moves
funds without any maker transaction at all.

Every existing guard is **in-process** and dies with a compromised process: the offer
invariants, the serialized `MakeService` with its `NEGATIVE_SPREAD` prospective-book guard
([TIB-2026-07-27](./TIB-2026-07-27-midnight-quoter-bot.md), §7 and §Security), and the quoter's
own transaction assertions applied immediately before each `wallet.sendTransaction`.

[TIB-2026-07-27](./TIB-2026-07-27-midnight-quoter-bot.md) gates any material capital increase on a
V1 security phase: treasury multisig; delegated funding contract; custom on-chain quoter ratifier;
AWS KMS or equivalent key custody. KMS custody has since shipped. This TIB addresses the remaining
**authorization gap** of that custody and is a step in the V1 track. The current hot-key cap is
20,000 USDC per market.

## Goals / Non-Goals

**Goals**

- Make the signing middleware the **only principal** allowed to call `kms:Sign` on the maker key.
  The bot loses direct KMS access entirely; its AWS role is reduced to invoking the middleware.
- Replace blind digest signing with **structured intents** (revoke, quote, ratify, and
  setup-remediation) that the middleware
  validates against policy it owns — bounds and pins from its own deployment parameters, book and
  position state from its own independent reads. Nothing policy-relevant comes from the request.
- **Sign-what-you-encode**: the middleware canonically encodes each validated intent and derives
  the digest internally. The bot never supplies bytes or hashes to be signed.
- Bound the blast radius of full bot-host compromise to a **quantifiable worst-case loss**:
  signatures over in-policy offers (≈ worst in-policy rate × capped **aggregate signed**
  exposure, published or withheld) plus revocations (downtime/griefing) and a capped
  signed-gas budget for native-token spend. No loan-asset drain, no arbitrary permit.
- Keep revocation the **always-available kill switch**: near-unconditionally approved and the most
  available operation the middleware offers.
- Fail closed: quoting halts when middleware invocation fails or an intent is denied.
- Keep the architecture **reproducible by third-party operators** of the public reference bot: the
  middleware's code ships in this repo and deploys from a standard container image, and `aws`
  custody already presumes an AWS account.

**Non-Goals**

- Replacing the in-bot invariants (offer policy, `NEGATIVE_SPREAD`, transaction assertions). They
  remain as fast-feedback defense in depth; the middleware is the first control that survives full
  bot-host compromise.
- Treasury custody or the delegated funding contract with fund/cap/block controls. Separate V1
  item.
- The custom on-chain quoter ratifier. Complementary track, not replaced by this TIB (see
  Alternative 3).
- Generalizing to other bots or keys in v0. The design should not preclude it, but v0 serves one
  bot and one maker key.
- Changing KMS/HSM provider procurement. v0 remains on AWS KMS with `ECC_SECG_P256K1`, but the
  cutover uses a newly generated maker key/address that the old direct-signing path never held; the
  existing maker key material is quarantined and is never reused by the middleware.

## Current Solution

- [`maker-account.utils.ts`](../../bots/quoter-bot/src/infrastructure/make/maker-account.utils.ts)
  wraps AWS KMS as a viem `LocalAccount`. All four signing surfaces — `sign`, `signMessage`,
  `signTypedData`, `signTransaction` — funnel into one `signHash` that calls the KMS `SignCommand`
  with `MessageType: 'DIGEST'` and `SigningAlgorithm: 'ECDSA_SHA_256'` on an `ECC_SECG_P256K1`
  key. KMS signs whatever digest it is handed.
- [`signer-identity.utils.ts`](../../bots/quoter-bot/src/config/signer-identity.utils.ts) selects
  exactly one `MakerIdentity`: `private-key`, `keystore`, `aws` (keyId + region), or read-only.
- Two payload classes are signed by the maker key today
  ([quoter-bot README](../../bots/quoter-bot/README.md)): **EIP-712 Ecrecover ratifier offer
  trees**, and **on-chain transactions** — publication itself is one:
  [`production-ladder.ts`](../../bots/quoter-bot/src/infrastructure/ladder/production-ladder.ts)
  sends the SDK-encoded offer payload as a zero-value transaction to the Midnight Mempool
  contract, alongside offer group/root invalidation and `setIsRootRatified` root approval where
  the Setter ratifier is used.
- In-process guards: the quoter's signing path builds a wallet directly from
  `createMakerAccount` and applies the quoter-specific `assertLadderPublicationTransaction`,
  `assertLadderRatificationTransaction`, and `assertLadderCancellationTransaction` checks
  ([`ladder-transaction.utils.ts`](../../bots/quoter-bot/src/infrastructure/ladder/ladder-transaction.utils.ts),
  [`production-ladder.ts`](../../bots/quoter-bot/src/infrastructure/ladder/production-ladder.ts))
  before each `wallet.sendTransaction`; the offer invariants and serialized `MakeService` are
  documented in [TIB-2026-07-27](./TIB-2026-07-27-midnight-quoter-bot.md). The shared
  [`packages/bot-kit/src/signer.ts`](../../packages/bot-kit/src/signer.ts) default-deny
  `evaluatePolicy` guard serves the liquidation bots and is **not** on the quoter's signing path
  today.
- Deployment: the bot runs as a Railway service with its own Dockerfile
  ([`deploy-railway.ts`](../../bots/quoter-bot/scripts/deploy-railway.ts)). The README instructs
  `aws`-mode operators to provision an AWS SDK credential source with KMS access into the service
  — exactly the credential this TIB removes from the bot.

## Proposed Solution

Insert a policy middleware between the bot and KMS and move the `kms:Sign` grant to it. The
middleware is an **AWS Lambda function** invoked through IAM; the bot's AWS credentials can invoke
it and nothing else.

```text
bot host (role: invoke-only)         signing Lambda (role: kms:Sign + reads)          AWS KMS
┌──────────────────────────┐         ┌───────────────────────────────────────┐      ┌───────────┐
│ quoter-bot               │ intent  │ 1. validate: crossed books, price     │      │ maker key │
│  · quote intents         │ ──────► │    bounds, PnL, field-level checks    │ dgst │ ECC_SECG_ │
│  · revoke/ratify intents │ (SigV4) │ 2. canonically encode (EIP-712 / tx)  │ ───► │ P256K1    │
│                          │ ◄────── │ 3. derive digest, call kms:Sign       │ ◄─── │ sign-only │
│ no kms:Sign — only       │  sig +  │ 4. return signature + encoded payload │  sig │           │
│ lambda:InvokeFunction    │ payload └──────────────────┬────────────────────┘      └───────────┘
└──────────────────────────┘                            │ independent live reads
                                                        ▼
               RPC, with strong resilience / quorum + Morpho API/Mempool (never bot-supplied state)
```

### 1. Structured intents replace digests

The wire contract is a **versioned JSON intent** carried as the payload of an AWS SDK
`lambda:InvokeFunction` call. Callers submit one of four intent types — revoke, quote, ratify, or
setup-remediation — and the middleware returns the signatures together with the exact payloads it
encoded, so the caller broadcasts exactly what was validated.

**Revoke intents** invalidate offer groups/roots. They are **near-unconditionally approved** —
revocation only reduces exposure and is the always-available kill switch — constrained to: pinned
chain id, a **per-operation target/selector and calldata allowlist** (group consumption is exactly
`setConsumed(group, MAX_OFFER_CAP, maker)` on the Midnight singleton, with the configured maker
pinned as `onBehalf`; Ecrecover root cancellation is exactly `cancelRoot(maker, root)` on the
configured ratifier; and Setter root cancellation is exactly
`setIsRootRatified(maker, root, false)` on the configured `SetterRatifier`), zero native value,
and fee/gas ceilings. For Setter deployments, `false` is defense in depth only: routine and
break-glass cleanup must drain or replace every already-signed `true` ratification transaction and
irreversibly consume every affected offer group before reporting success. A withheld older `true`
can otherwise restore the mutable root flag. Ecrecover root cancellation remains authoritative on
its own. This mirrors the constraint set the quoter's in-process transaction assertions already
pin, now enforced outside the bot; a compromised revoke invoker cannot spend gas mutating another
maker's groups or roots.

Maker-wide cleanup and startup cleanup keep the existing batch behavior exposed by
`OfferInvalidationPort.invalidateBatch`: the revoke surface may encode one Midnight `multicall`,
but only from a structured list of group-consumption intents. The middleware recursively validates
every inner call as an exact zero-value `setConsumed(group, MAX_OFFER_CAP, maker)` against the
configured Midnight singleton and maker, rejects nested multicalls and every other selector or
target, and then encodes the outer multicall itself. An empty batch is rejected. This gives the
current all-groups cleanup path one policy-checked transaction without turning `multicall` into an
arbitrary-call escape hatch.

Because a signed transaction commits to an account nonce, transaction-signing intents carry
**caller-supplied fee fields** as liveness parameters, but nonce ordering is policy-relevant. In
routine operation the middleware reads the maker's current pending nonce independently and signs
only that nonce; it never signs a stockpile of future-nonce transactions. The bot's serialized
make/pending queue remains the single routine writer, but the middleware does not rely on that
process-local serialization. The reservation transaction conditionally acquires a nonce-specific
lease before any routine KMS call and fails if that nonce is already occupied by a live lease or
transaction record. The lease records the intent kind and fee fields and is atomically converted to
the returned transaction's nonce/hash record before release; concurrent quote, ratify, and routine-
revoke invocations therefore cannot obtain alternative signatures at the same nonce. The
middleware refuses another routine signature at that nonce until the recorded transaction is
terminal (confirmed, replaced, or cancelled on chain). Offer freshness expiry is not terminal for
an EOA transaction: the signed bytes remain broadcastable, so the transaction record and its
signed-gas/nonce reservations remain fenced until the nonce is confirmed or replaced/cancelled on
chain. This same-nonce fence prevents a caller from withholding several alternatives and choosing
the one least favorable to break-glass cleanup.

The fence has one routine liveness exception: the same authenticated surface may request a
**replacement** of its recorded, still-pending transaction. The middleware accepts either the exact
canonical intent and economic payload already recorded at that nonce—with offers, roots, groups,
target, calldata, value, and intent kind unchanged—or an exact zero-value self-cancel at the same
nonce. The self-cancel is explicitly exempt from those unchanged-payload constraints and must instead
use the signer EOA as both sender and target, empty calldata, zero value, and the dedicated cancel
intent kind; it cannot carry offers, roots, groups, or any other economic action. It reads the current
pending-block base fee independently, derives
`newPriorityFee = max(floor(previousPriorityFee * 1125 / 1000), previousPriorityFee + 1 wei)`, and
derives
`newMaxFee = max(floor(previousMaxFee * 1125 / 1000), previousMaxFee + 1 wei, currentBaseFee * 2 + newPriorityFee)`.
This is the repository fee policy, including its base-fee floor rather than only the replacement
bump. The middleware applies the routine ceilings and rolling signed-gas budget to both derived
fields. Before returning, it appends the new fee fields, signed bytes, and hash to the nonce's
durable artifact history and atomically marks that entry as the latest active artifact. Same-nonce
replacement history is append-only: no bump or self-cancel overwrites an older artifact, because
every previously returned byte string remains broadcastable until the nonce is confirmed or
replaced/cancelled on chain. Routine retries and later bumps use the latest active artifact, while
budgeting and break-glass cleanup retain every artifact and use the maximum fee fields across the
complete history at that nonce. Repeated bumps therefore restore a path for an underpriced
transaction without losing earlier signed exposure. A replacement that cannot read the current
base fee, append and activate its record atomically, be budgeted, or be reconciled with the pending
transaction fails closed.

A break-glass revocation deliberately takes over the account's transaction stream during an
incident. It does **not** sign the node's `pending` nonce, which is the next unused nonce. It
enumerates every occupied nonce from the middleware's recorded, still-pending routine and
setup-remediation transactions and signs a cleanup transaction at each **same nonce**, thereby
replacing every unsafe publication, ratification, or remediation rather than queueing behind it.
When a nonce has no root/group revocation target — including a maintenance approval or authorization
nonce, or when there are fewer revocation targets than occupied nonces — the protected handler signs
an explicit break-glass self-cancel replacement: sender and target are the maker EOA, value is zero,
calldata is empty, and the dedicated break-glass-cancel intent rejects every offer, root, group,
approval, authorization, and arbitrary target field. Empty revocation batches remain invalid; this
self-cancel is a distinct replacement intent, so every occupied nonce always has a policy-valid
preemption payload. Each replacement fee bid uses the repository replacement formula against the
maximum recorded fee fields across every signature at that nonce: the priority fee is bumped by
12.5% plus the one-wei
floor, and `maxFeePerGas` is the maximum
of its corresponding bump and
`currentBaseFee * 2 + newPriorityFee`. The current pending-block base fee comes from an independent
RPC read immediately before signing, never from the caller. The result remains subject to the
protected break-glass ceilings; the maximum-recorded rule is defense in depth if the same-nonce
routine fence was bypassed or older records predate it. The runbook signs and broadcasts
replacements for every occupied nonce in ascending order before
waiting for any replacement to confirm. This prevents a pending transaction at nonce N+1 from
mining in the same block immediately after cleanup at nonce N. Only after the entire occupied
prefix has a replacement in the network may the operator wait for confirmations and proceed with
later, previously unused nonces. If the middleware cannot reconcile its record with the node's
pending transaction set, an occupied transaction was not recorded, or the protected ceilings
cannot replace every occupied nonce, break-glass must use an ordered drain/handoff and must not
claim that a next-unused-nonce revocation can preempt the pending stream. Routine transaction
ceilings must reserve one complete emergency bump for **both** fee fields. Deployment validation
requires the protected priority ceiling to cover
`max(floor(routinePriorityCeiling * 1125 / 1000), routinePriorityCeiling + 1 wei)` and the protected
max-fee ceiling to cover at least the corresponding bump of the routine max-fee ceiling. Because no
static ceiling can promise capacity across an unbounded future base-fee rise, readiness and the
break-glass preflight also read the current base fee and derive the exact emergency pair with the
same `currentBaseFee * 2 + newPriorityFee` floor. They fail closed before claiming replacement
capacity unless every derived fee fits the protected ceilings and the protected reserve can fund
every occupied nonce. Before returning every routine transaction (including a routine replacement),
the middleware performs that same live-base-fee preflight against its actual recorded fee fields. A
middleware-produced routine bid therefore cannot strand an otherwise valid emergency replacement
merely because the ceilings were only one wei apart or because the base-fee floor was omitted.

Per-transaction fee/gas ceilings alone cannot stop a leaked invoker from bleeding the maker's
native balance one valid cancellation at a time. Transaction-signing intents therefore also draw
on **rolling signed-gas budgets** tracked in the reservation ledger (see Statefulness). The budget
class comes from the authenticated Lambda invoke surface, never from a caller-supplied principal,
intent field, or `ClientContext`: publication, ratification, and the bot-only `routine-revoke`
function draw on the routine budget; the operator-only setup-remediation function draws on a
**dedicated setup-remediation rolling budget**; and the operator-only `break-glass-revoke` function
alone draws on a **protected reserve** that neither the bot nor remediation role has IAM permission
to invoke or draw down. The remediation budget has its own ledger key, rolling window, signed-gas
limit, transaction-count limit, and reserved native-gas accounting. Deployment validation derives
its minimum size from the manifest's maximum remediation transactions per epoch at their configured
gas and fee ceilings (including one replacement for each admitted nonce), rejects a zero or
undersized limit, and forbids charging remediation to the routine or break-glass class. The primary
protected reserve is sized for replacements at the **maximum configured
occupied-nonce set** (each at the protected fee and gas ceilings) plus several full-book cleanups,
with no overlap assumed between those costs. Deployment validation computes that bound from the
configured maximum and rejects a primary reserve below it. The reservation transaction also counts
the maker's distinct non-terminal routine and setup-remediation nonces and rejects any new-nonce
signature that would exceed that configured maximum; same-nonce replacements do not increase the
count. This hard cap is
checked and updated atomically with nonce lease acquisition, so concurrent invocations cannot each
admit themselves against the last slot. Both revoke functions use the same strict revoke validator
from the shared image, but their function ARNs, IAM grants, reserved concurrency, and server-side
budget classes are distinct. A compromised bot therefore cannot impersonate break-glass in its
payload or starve the kill switch with otherwise valid cancellations. When the ledger is
unavailable, quote/ratify and bot-originated routine revokes fail closed while the break-glass
surface draws from a small **ledger-independent emergency-revoke budget**: a durable,
atomically consumed token/gas/nonce allowance on an independently operated high-availability
store. Deployment validation sizes this allowance for replacements at the **maximum configured
occupied-nonce set** (each at the protected fee and gas ceilings) plus one configured full-book
cleanup, with no overlap assumed between those costs. If the live occupied set exceeds that
configured maximum, outage cleanup fails closed into ordered drain/handoff rather than claiming the
ledger-outage guarantee. The same independent control plane keeps a
**ledger-independent revocation inventory**: an append-only, strongly consistent catalog of every
root and group whose signature could make exposure publishable. Catalog persistence is a write-before-
sign condition for quote and ratify: **both** the primary reservation and the independent catalog
entry must commit durably in a `pending-signature` state before any KMS call. Failure of either write
fails signing closed; the middleware never signs with uncharged aggregate capacity or an incomplete
revocation inventory. After all signed response artifacts are durable, the finalization transaction
conditionally promotes the catalog entry to `signed`. For an Ecrecover quote, the catalog entry stores the exact
tree signature and non-maker publication payload; it has no maker nonce, transaction hash, signed
transaction bytes, or fee fields and creates no transaction-inventory record. For every maker
transaction, including setup remediation, finalization atomically writes the separate
ledger-independent transaction-inventory record before promoting the catalog entry; the inventory
contains the exact signed bytes, nonce, hash, intent kind, and fee fields needed for cleanup. A
transaction-backed `signed` catalog entry can therefore never exist without its inventory record,
while a signature-only `signed` entry is explicitly distinguishable and remains available for root
or group revocation. Stored-artifact retries become deliverable only after the applicable
finalization transaction commits. The same idempotent compensation path that
releases a failed primary reservation also writes a terminal `failed` tombstone for its catalog
entry. Break-glass enumerates only `signed` catalog entries; `pending-signature` entries past their
short lease are reconciled to `signed` only from complete durable artifacts, otherwise they are
tombstoned. If the catalog cannot prove an entry's terminal state, cleanup fails closed into ordered
drain/handoff instead of charging emergency capacity for speculative targets. Break-glass therefore
retains the targets needed to cancel hidden,
signed-but-unpublished exposure even when the primary reservation ledger cannot be read. It also
keeps that **ledger-independent transaction inventory** for every signed routine transaction,
including one whose original Lambda response was not delivered. Persisting that record is a
write-before-`signed` and therefore write-before-return condition; if the independent inventory
cannot durably record it, finalization and every stored-artifact retry fail closed. During a
primary-ledger outage, break-glass uses this inventory to replace every occupied nonce with a fee
bid derived from the recorded maximum. The emergency reader uses strongly consistent or
quorum reads and verifies a writer-region high-watermark replicated after routine admission was
frozen; a stale or unverifiable watermark fails closed rather than treating a partial catalog as
complete. If the inventory is unavailable, stale, or cannot account for the node's pending set,
cleanup fails closed into the ordered drain/handoff posture instead of claiming ledger-outage
preemption. Reserved concurrency isolates revoke capacity from quote floods but is explicitly
**not** a rate limit; it cannot bound
sequential signatures. If that independent budget cannot be checked atomically, revoke signing
fails closed and pages the operator rather than becoming unmetered. The final backstop is a
**native-balance admission band** — a new operational control this TIB requires, distinct from the
existing `NATIVE_RESERVE_WEI` readiness threshold. Setup/readiness and every routine transaction,
replacement, and setup-remediation signing request independently read the maker's native balance.
They fail closed before KMS when it exceeds the configured maximum or when the request would violate
the **required protected-balance floor**. For the post-admission occupied-nonce set, that live floor
is `NATIVE_RESERVE_WEI` plus (a) the worst-case gas spend of every non-terminal routine or
setup-remediation artifact that could execute before containment, (b) one derived protected-fee
replacement for every occupied nonce, and (c) the configured protected full-book cleanup cost. The
calculation uses each artifact's gas limit and maximum append-only fee history, the current base fee,
the protected replacement formula, and the same configured occupied-nonce maximum used by readiness.
Admission includes the candidate transaction's worst-case spend before checking the floor, so a
compromised routine invoker cannot consume the native balance that the separately accounted protected
reserve needs. An unprovable balance, fee, artifact, or occupied-nonce input fails closed.
Monitoring alerts before and at both bounds; an unsolicited transfer can make the balance exceed the
ceiling but cannot turn the excess into routine signing capacity. The operator-only break-glass path
remains available to replace unsafe pending transactions, and the setup-remediation surface provides
the sole native-balance recovery operation described below. A native-balance sweep derives its value
only after reserving its own worst-case gas and this complete protected-balance floor; it never sweeps
protected replacement or cleanup capacity. Native-gas spend enters the bounded-loss arithmetic under
the authenticated budget classes and this live spendable-balance check; neither bound is described as
a physical balance cap that external senders cannot change.

**Setup-remediation intents** replace the maker's direct KMS path for token approvals and other
setup transactions. They are accepted only by a dedicated operator-authorized function while a
dedicated remediation epoch has stopped quote, ratify, and routine-revoke signing. This remediation
epoch is distinct from the break-glass cleanup epoch: opening it atomically advances the independent
deny generation, drains all older-generation routine leases, and then permits setup-remediation
signing only; the break-glass control remains available to fence and supersede the epoch before it
signs cleanup. An authenticated close proves every remediation artifact is
durable and every remediation nonce is terminal or safely preempted. The deployment
manifest pins every permitted target, selector, asset, spender/operator, allowance or authorization
ceiling, chain, native value, and gas/fee ceiling; the middleware independently reads current
allowance/authorization state and canonically encodes the exact transaction. All variants require
zero native value except one manifest-pinned `native-balance-sweep` variant. That variant is allowed
only when the independently read balance exceeds the admission ceiling, sends only to one configured
treasury address with empty calldata, and derives (never accepts) a value that leaves the configured
recovery target, its own worst-case transaction fees, and the required protected-balance floor on the
maker. It rejects a caller-supplied target or
value, token calls, arbitrary calldata, and any result below the native reserve; it remains available
above the routine admission ceiling but still requires a fresh signing-surface attestation, the
remediation epoch, nonce lease, dedicated setup-remediation rolling budget, live protected-balance check, and
exact manifest match.
Arbitrary calldata, permit signatures, token asset transfers, wildcard spenders/operators, and
caller-selected targets are rejected. Setup remediation uses the same nonce lease, append-only
artifact history, rolling gas accounting, replacement rules, and break-glass preemption guarantees
as every other maker transaction. Its invoke role is separate from both the bot and break-glass
roles, and neither role can invoke it. Direct bot or operator access to `kms:Sign` remains only until
this surface is deployed and its positive and deny-path acceptance tests pass. Cutover then removes
direct KMS signing and verifies `AccessDenied` before the old-maker quarantine expiry window begins;
no manual remediation procedure may restore it. Any retained access needed to finish old-maker cleanup
must use a policy-checked cleanup-only path that cannot sign quotes, ratifications, setup transactions,
or caller-selected payloads, and that path is removed after cleanup. Cutover must use a newly generated
maker key/address that the old direct-signing path never held. The old maker remains quarantined:
operators revoke every live
offer/root authorization, replace or confirm every pending transaction, remove its token approvals,
and wait for every permit, authorization, and other time-bounded signature class to expire before
moving assets or policy caps to the new maker. The independent catalog backfill below is still required
for cleanup, but it is not accepted as proof that arbitrary historical blind signatures are exhausted,
because CloudTrail cannot recover their signed digest. Before cutover, migration backfills the
independent catalog and transaction inventory with every known non-terminal offer group, ratified root,
pending routine transaction, and pending setup-remediation transaction signed by the existing `aws`
path, including complete artifact and occupied-nonce histories. After the old maker's known artifacts
pass the same strongly consistent inventory, pending-set reconciliation, and break-glass preflight used
after cutover and the new maker is active, direct KMS signing is removed and `AccessDenied` is verified
before the old-maker quarantine expiry window begins. Higher caps remain disabled until the old maker
has completed every quarantine condition above.

**Quote intents** carry an array of structured offers. There are **no caller-declared
exclusions**: the prospective book is always the observed live book plus the proposed set,
because a promised-but-unobserved invalidation is worth nothing at the signing boundary — a
signed publication is broadcastable regardless of what the caller claimed it would revoke
first. A replacement therefore sequences exactly as the in-process `MakeService` already does:
request the revoke signature, broadcast it, wait until the middleware's snapshot shows the old
groups gone, then request the quote signature against the now-clean book. A replacement whose
transitional old-plus-new book stays fully in-policy may skip the wait and revoke after
publication. For Ecrecover, the quote intent returns the tree signature and encoded publication
payload; the same constrained non-maker publication-broadcaster used by Setter submits that exact
zero-value payload to the Midnight Mempool contract. The maker KMS does not sign a second EOA
publication transaction. For Setter, the ratify intent returns the maker-signed ratification
transaction plus the independently encoded publication payload described below. In both modes the
middleware encodes the payload from the validated set, and the minimally funded non-maker sender
adds no authorization or policy decision.

The set is approved only when **three properties** all hold:

1. **No crossed books.** The prospective offer set — observed live offers, every still-outstanding
   signed-but-unpublished reserved offer, and the proposed set, with no exclusions — must not
   create a negative spread across books: the same whole-book invariant `MakeService` enforces
   in-process today, now enforced independently at the signing boundary. Reserved offers are
   keyed and deduplicated by maker, root, and offer identity, so revalidating the exact same set
   does not count it twice. Critically, the middleware does **not** trust bot-supplied book state
   for this check — a compromised bot would lie. It reads live offers and chain state itself,
   through its own RPC and Morpho API/Mempool reads, and every policy read for one intent is pinned
   to **one deterministic snapshot** — a single block tag, with API responses carrying consistent
   indexed-block metadata. If a coherent snapshot cannot be assembled, the intent fails closed.
2. **Price bounds.** Every offer's price/rate must remain inside boundaries encoded as parameters
   of the middleware's own deployment configuration — never supplied per-request.
3. **No PnL drop.** Publishing the offers must not degrade the maker address's PnL: offer prices
   must remain sustainable, i.e. a fill at the offered price must not realize a loss against the
   maker's position/cost basis. The exact PnL/cost-basis model and its independent data sources are
   a blocking v0 design deliverable, not an implementation choice: quote and ratify signing remain
   disabled until that model is specified, reviewed, encoded in deployment policy, and covered by
   acceptance tests that prove profitable, boundary, and loss-making fills are classified as
   specified from independently read inputs.

Beneath these three headline properties, **field-level validation** on every offer: market
allowlist; per-market and total lend-exposure caps for **exposure-increasing buy offers**, enforced
against the maker's current filled lend position plus aggregate signed buy exposure — the proposed
buys, the maker's already-live buys from the middleware's own reads, and every still-outstanding
signed-but-unpublished buy reservation (see Statefulness), never per-intent amounts alone. Position
and offer state come from the same pinned, independent snapshot, and buy headroom is the configured
budget minus filled lend exposure, live buys, and buy reservations; a buy fill consumes rather than
restores signing room. Lower-rate `reduceOnly` sell offers do **not** consume those lend-exposure
budgets: they can only unwind existing maker credit. They instead draw from a separate per-market
unwind-inventory reservation capped by independently read accrued credit minus live and
signed-but-unpublished reduce-only sell capacity, deduplicated by the same group/cap consumption
domain used by the protocol. This permits safe unwind quotes when lend headroom is zero without
allowing aggregate sell capacity to exceed the credit that can be reduced. Expiry
≤ market maturity and inside a **freshness ceiling** — a policy parameter
capping offer lifetime from signing time, so a stockpiled signature dies quickly; offer start
not meaningfully before the first validation/reservation time (with the Setter reuse rule below);
exact maker/receiver/callback/ratifier fields; owned
group namespace; the per-side `reduceOnly` flag pinned by policy — the credit-reducing side must
carry `reduceOnly: true`, so a signed sell fill can never turn inventory reduction into new
debt; a `continuousFeeCap` the middleware derives from its own snapshot's current market fee —
never unbounded or caller-chosen, so a later fee raise cannot make a fill accept a worse fee
than the PnL check priced; and asset-denominated cap semantics: v0 accepts only `maxAssets`, which
must be non-zero, and requires `maxUnits` to be zero. This matches the current builders and makes
every reservation directly comparable to the per-market and total asset exposure budgets.

Middleware mode also changes offer construction: the ladder and bootstrap/auto-refill builders
persist `expiry = min(market maturity, signedAt + freshness ceiling)` in the structured intent and
in the exact offer payload returned for broadcast. The middleware derives that bound from its own
clock and deployment policy and rejects caller-supplied expiries outside it; it never silently
signs a different offer than the one returned. This builder change is part of the bot-side seam,
so long-dated markets continue to quote instead of having their maturity-dated offers denied by
the middleware.

**Ratify intents** exist for Setter-ratifier deployments, whose ladder flow must send
`setIsRootRatified` before a quote tree becomes takeable. A ratify intent carries the same
structured offer set as a quote intent; the middleware re-validates it in full, re-derives the
root itself, and signs only the `setIsRootRatified(maker, root, true)` transaction for that
derived root — under the same chain/value/fee pins as revocations, targeting the configured
ratifier. The middleware never needs to remember which roots it produced: it recomputes them.
Because a ratified root is publishable by **any funded sender** — the Mempool log contract
accepts the encoded payload from any account — a signed ratification is publishable exposure in
itself. Ratify approval is therefore the **final publication authorization**, not the first half of
a safety decision that can be revoked by a later middleware check. Before signing the ratification,
the middleware performs every quote check against one pinned snapshot, derives the exact root and
publication payload, fixes the offer expiry and `continuousFeeCap`, and atomically reserves the
exposure. The returned publication payload is submitted through a publication-broadcaster port
backed by a separate, minimally funded **non-maker** account. That adapter accepts only the exact
zero-value Mempool target and calldata returned by the ratify intent; it has no maker key or
loan-asset authority. The sender adds no policy decision — no security claim depends on it returning
for a paired publication intent — but it gives Setter ladder, bootstrap, and auto-refill flows an
explicit way to put the already-authorized payload onchain after generic maker signing is removed.

Ratify and publication still share one ledgered identity: the approved `(maker, root, offer set)`
conditionally creates one per-offer capacity reservation (lend exposure for buys, unwind inventory
for reduce-only sells), and later observation of that exact publication reuses rather than
double-charges it. A mismatched set or root is a distinct request and
is evaluated against the existing reservation. After ratification, the only bounds are those encoded
in the authorized artifacts and chain state: the offer freshness expiry, the fixed fee cap, group
consumption, or root cancellation. A refreshed PnL/market-fee check or a middleware-only
ratify-to-publish timer cannot fail closed once a third party can publish, so neither is presented as
a post-ratify control. Ratify is a **quote-enabling intent**, authorized like quote and never granted
to break-glass principals. Ecrecover deployments never use this intent.

Policy parameters live in the middleware's deployment, never in the request; the state feeding
its checks comes from its own reads, never from the caller. A compromised bot can neither relax
the policy nor lie to it.

### 2. Sign-what-you-encode

The middleware itself canonically encodes each validated intent — EIP-712 offer-tree hashing for
Ecrecover ratifier offers, SDK payload encoding for Mempool publication calldata, and
transaction serialization for every transaction kind — and derives the digest
internally. The bot never supplies bytes or hashes to be signed, so **there is no
decode/re-encode ambiguity to attack**: nothing needs to parse an attacker-supplied encoding and
hope the parse matches what the chain or the ratifier will see. What was validated is what is
signed, by construction.

### 3. Bot-side seam: intent ports, not a drop-in account

The viem `LocalAccount.sign(hash)` blind-digest surface is exactly what is being removed, so the
middleware is deliberately **not** a drop-in `LocalAccount` replacement. The bot-side seam is
intent-level ports — a quote-publication port (Ecrecover tree signature plus encoded publication
payload), an invalidation-signing port, a root-ratification port for Setter deployments, a
setup-remediation port, and the constrained non-maker publication-broadcaster port described above
— backed by middleware-invoking adapters,
selected as a new identity method alongside
`private-key`/`keystore`/`aws` in
[`signer-identity.utils.ts`](../../bots/quoter-bot/src/config/signer-identity.utils.ts). Any
residual generic digest-signing path fails closed.

Middleware mode also adds an authenticated **signer-identity setup port**. Every active function
execution role, not the bot role, may call `kms:GetPublicKey` only on the configured maker key. At
cold start and before serving, each deployment in the manifest's mode-aware active surface set derives
the secp256k1 address and key fingerprint,
computes its surface-specific policy/configuration digest, and fails closed unless the shared
identity fields and that surface's digest equal their separate expected values in the deployment
manifest. It also calls `lambda:GetFunction` for its own manifest-pinned exact qualified published-version ARN,
reads the AWS-observed `Code.ResolvedImageUri`, requires the digest-qualified URI to equal
the manifest-pinned ECR digest, and records that observed digest. Its role can perform this read only
for that qualified version ARN; setup/health receives the same bounded read on every manifest-pinned
qualified version in the mode-aware active surface set. An unqualified function ARN does not satisfy
this grant. A handler-provided environment value or request field is never accepted as image
evidence. Setup/health aggregates those per-surface attestations and is ready only when every active
surface reports the same maker,
chain, key fingerprint, image digest, and deployment-manifest digest, and each reports its own
manifest-pinned surface-specific policy/configuration digest. Surface digests are intentionally not
required to equal one another: each signing handler pins a different intent type, invoke principal,
and budget class. A correct setup function therefore
cannot mask a stale key or policy on a signing surface. The setup port returns only those validated
fields through the IAM-authenticated invocation response — no public key, signature, digest-signing
primitive, or caller-selected challenge. `SetupStateService` obtains its derived-maker observation
from this port in middleware mode, and `SetupCheckService` keeps the same configured-maker equality
gate it applies to local and direct-KMS identities. Health/readiness is red when any endpoint, KMS
key, chain, image, policy, or configured maker is mismatched; the check is not skipped merely because
the bot no longer has direct KMS access.

The aggregation path is an internal attestation registry, not an assertion synthesized by
setup/health. After validating itself, each execution role may conditionally write only its own
function-and-published-version key in a dedicated DynamoDB table; the value contains the validated
shared fields, that surface's policy/configuration digest, the deployment-manifest digest, and a
startup timestamp. It cannot write another surface's key and may strongly consistently read only its
own exact key. The setup/health execution role may write its own key and read every exact key in the
mode-aware active surface set, but may not alter any
signing-surface record; the bot role has no table
access. Readiness resolves every production alias to its current published version, requires
`RoutingConfig.AdditionalVersionWeights` to be empty, and requires a fresh matching record for that
exact version and manifest. Weighted/canary routing is forbidden for every active production alias in
v0, so an unattested additional version cannot receive signing traffic and an attestation from a
retired deployment cannot satisfy the check. Deployment automation and readiness both fail closed
when any production alias has additional version weights. IAM grants only those per-key
`dynamodb:PutItem` operations, each signing role's `GetItem` on only its own exact key, each signing
role's `lambda:GetAlias` on its own unqualified function ARN and `lambda:GetFunction` on its own
manifest-pinned exact qualified published-version ARN, the setup role's bounded
`GetItem`/`BatchGetItem`, the setup role's `lambda:GetAlias` on every exact active unqualified function
ARN, `lambda:GetFunction` on every corresponding manifest-pinned exact qualified published-version
ARN, and `events:ListTargetsByRule` only on every manifest-pinned exact rule ARN. It grants no wildcard
Lambda or EventBridge reads. Because `GetAlias` authorizes the function resource
rather than an alias resource, every caller supplies only the exact configured alias name and the
handler/manifest validation rejects any other alias before accepting the returned target. The setup
role resolves and records
those alias targets before accepting registry attestations. Every signing request re-resolves its
exact configured production alias immediately before reservation and KMS, requires
`RoutingConfig.AdditionalVersionWeights` to be empty, requires the resolved version to equal the
executing published version, and rejects any mismatch before signing. It then performs a strongly
consistent read of its own exact function-version-and-manifest record and requires its
maker, chain, key fingerprint, image digest, policy digest, manifest digest, and timestamp to match
and remain inside the freshness window. A missing, stale, or mismatched record rejects the request
before reservation or KMS; callers cannot bypass the gate, and setup/readiness cannot satisfy it on a
signing surface's behalf. No attestation path exposes a signing operation. Every signing intent first requires
`context.invokedFunctionArn` to equal its exact configured production-alias ARN and rejects a version
ARN, unqualified ARN, `$LATEST`, attestation alias, or any other alias before reservation or KMS. The
shared production handler routes a dedicated
**non-signing attestation operation** before any signing dispatch, but accepts that operation only
when `context.invokedFunctionArn` is the manifest-pinned exact published version during deployment or
the function's dedicated attestation alias after rollout. It rejects the operation on every signing
production alias, so a bot that may invoke quote or routine-revoke cannot refresh an attestation.
Conversely, the dedicated attestation alias dispatches only this operation and rejects every signing
intent before reservation or KMS; it is not a separate Lambda, image command, or handler
configuration. After publishing a version and before moving its production and attestation aliases,
deployment automation invokes that exact version and handler with the attestation operation using a
deployment role that alone may invoke version ARNs; the operation performs only the
key/config/AWS-observed-image validation above and the conditional registry write. The
deployment verifies the exact version-and-manifest record, retries transient failures, and refuses
the alias rollout if the record is absent or mismatched. After rollout, an external EventBridge
schedule invokes the same non-signing attestation operation on each exact dedicated attestation alias at an
interval shorter than half the registry freshness window. The operation re-resolves the alias to one
published version, rejects weighted routing, revalidates key/config/image/manifest state, and
conditionally refreshes only that version-and-manifest record. A deployment-owned watchdog alarms
before a record can expire and retries transient refresh failures; setup/health never refreshes a
signing surface on its behalf. If scheduled refresh stops or drift prevents a refresh, readiness turns
red at the freshness deadline and signing fails closed, without requiring a redeploy or signing
traffic. Readiness can therefore require fresh records without waiting for quote, ratify, or revoke
traffic, while setup/health still never invokes a signing handler. Each attestation alias has a
resource-based permission for the `events.amazonaws.com` service principal conditioned on one exact
EventBridge rule ARN; signing production aliases have no EventBridge invoke permission. The target is
pinned by rule ARN, target ID, attestation-alias ARN, and canonical input hash in the deployment
manifest. An organization policy/permission boundary explicitly denies `events:PutTargets`,
`events:RemoveTargets`, and `events:DeleteRule` for that rule to every principal except the deployment
role; that role verifies the live target against the manifest after every change. AWS Config plus
CloudTrail alarms on any target mutation, and readiness fails closed when its live
`events:ListTargetsByRule` preflight differs from the pinned target tuple. Even if target management is
compromised before detection, the attestation alias cannot dispatch a signing intent. No scheduler
role receives general `lambda:InvokeFunction` credentials. CloudTrail records each scheduled invoke.

The ports serve **every maker workflow, not only the ladder**: position bootstrap (including
auto-refill) signs the same transaction kinds through
[`production-bootstrap.ts`](../../bots/quoter-bot/src/infrastructure/bootstrap/production-bootstrap.ts).
In middleware mode an Ecrecover bootstrap top-up uses a quote intent in its bootstrap group
namespace; a Setter bootstrap or auto-refill uses the ratify intent and then the constrained
publication-broadcaster port, exactly like the Setter ladder flow. Both paths enforce the same three
properties and field checks. Because the no-PnL-drop property is strict, middleware mode disables
discounted bootstrap: bootstrap and auto-refill require a non-negative premium and cannot use the
existing negative-premium path. No workflow retains a generic maker signer.

The ports are **transport-agnostic**: they express intents, not hosts. The Lambda invoker is one
adapter behind them; plugging in a different middleware host tomorrow — an HTTP API, a Cloudflare
Worker — is an adapter swap that touches no application code.

### 4. v0 deployment shape: an AWS Lambda behind IAM

The Lambda is the **v0 deployment target, not part of the contract**. The middleware's policy
core is a host-agnostic validate → encode → sign module with a thin Lambda handler around it,
mirroring how the bot reaches the middleware only through its intent ports. Re-hosting it later —
an HTTP API, a Cloudflare Worker — replaces the handler and the bot-side adapter, not the policy
logic, and any alternative host must preserve the trust split: the middleware alone holds
`kms:Sign`, and callers hold nothing but the right to invoke it.

- The middleware is a mode-aware set of AWS Lambda functions built from one shared container image:
  setup/health, routine revoke, break-glass revoke, and setup remediation are always active.
  Ecrecover additionally activates quote and omits ratify; Setter additionally activates ratify and
  omits quote. Setter omits the quote function, production and attestation aliases, invoke grants,
  readiness entry, EventBridge target, and `kms:Sign` principal because its ratify intent already
  returns the validated publication payload. Ecrecover likewise has no ratify function, aliases,
  invoke grant, readiness entry, EventBridge target, or `kms:Sign` principal. The deployment manifest
  is the authoritative active surface set, and readiness, refresh, IAM, and audit coverage enumerate
  exactly that set. The functions are
  invoked through the AWS SDK
  (`lambda:InvokeFunction`). Routine and break-glass revoke deliberately have separate authenticated
  invoke surfaces even though they enforce the same structured revoke intent. Setup remediation is
  a separate operator-only surface whose strict transaction allowlist cannot be selected by bot or
  break-glass payload data. The setup/health function is the authenticated signer-identity setup
  port used by readiness; it can return only the
  validated setup fields described above and has no signing-intent handler.
- **IAM chain**: the bot's AWS credentials attach to a role whose only permissions are
  `lambda:InvokeFunction` on the exact production-alias ARNs for setup/health and its routine intent
  surfaces — never an unqualified function ARN, a version ARN, `$LATEST`, or another alias. The bot
  loses `kms:Sign` and `kms:GetPublicKey` entirely. Operator grants are likewise restricted to the
  exact break-glass production-alias ARN. The active signing functions' execution roles are the only
  principals with `kms:Sign`; every active execution role has narrowly scoped `kms:GetPublicKey` on
  that same maker key solely for their startup attestation, while setup/health has no `kms:Sign`.
  Creating those execution roles, the invoke-only credentials, and
  the CloudTrail data-event selectors for every active function (see Observability) are part of the
  deliverable.
- **Caller-to-surface scoping**: principals are authorized per exact production-alias ARN. The
  structured intent types map to separate active signing Lambda functions, while setup/readiness maps
  to setup/health — one shared container image and five deployments in either mode —
  because routine and break-glass revoke must be distinguishable by an authenticated AWS boundary,
  not by untrusted payload data. Aliases are not enough: reserved concurrency is function-scoped,
  and distinct functions also let IAM deny the bot access to the protected reserve. IAM grants the
  bot setup/health and routine-revoke production aliases, plus quote only in Ecrecover mode or ratify
  only in Setter mode;
  break-glass principals
  receive only the break-glass-revoke production alias; remediation operators receive only the
  setup-remediation production alias. Each active function's dedicated attestation alias grants the
  `events.amazonaws.com` service principal permission conditioned on its exact EventBridge rule ARN;
  production signing aliases grant none. The handler accepts attestation only on that alias (or an
  exact version invoked by the deployment role), and the rule supplies only the pinned non-signing
  payload. Target-management APIs are denied except to the deployment role and live-target drift fails
  readiness. No scheduler execution role
  receives a general invoke grant, KMS permission, budget class, or signing-intent path. Explicit
  denies and acceptance tests cover
  unqualified and `$LATEST` invokes, every non-production alias, and cross-surface aliases. Each
  signing handler pins its intent type and budget class in deployment configuration before
  calling the shared validator. It never reads a claimed principal or budget class from the intent
  payload or `ClientContext`. Leaked break-glass credentials must yield revocations, never signed
  quotes, ratifications, or setup approvals, while leaked bot credentials can never consume
  emergency or remediation capacity.
- Authentication is therefore **IAM/SigV4** — no self-managed ingress, tokens, or mTLS. The
  in-policy guarantee still does not depend on caller identity — any invoker only ever obtains
  in-policy signatures — while the caller-to-surface scoping above decides _which_ in-policy
  intents a given principal may submit, and invoke scoping keeps revoke-griefing/DoS hard and the
  audit trail attributable.
- The middleware's **code lives in this monorepo** and deploys as one **Docker container image**
  (ECR-hosted) instantiated as the mode-aware active functions, with its own Dockerfile, like the
  bots. It is not a bot —
  not a long-running program — so it does not live under `/bots/`; the proposed workspace home is
  a new top-level `services/` directory, e.g. `services/quoter-signer`. Final naming and location
  are settled at implementation (open question 1).
- Flow: the bot builds the desired offer array → invokes the Lambda with the structured intent →
  the Lambda validates the three properties plus field checks, canonically encodes, derives the
  digest, calls KMS → returns the required maker authorization and encoded publication payload
  (an Ecrecover tree signature or a Setter ratification transaction, never a maker-signed Ecrecover
  publication transaction). Sign-what-you-encode is unchanged by the deployment shape.

### 5. Availability posture

- Lambda and KMS are both **AWS-managed**, which improves the liveness story over a self-hosted
  proxy. The middleware remains a liveness dependency: quoting fails closed when invocation
  fails; the bot halts publication and retries rather than degrading to any local signing path.
- The **revoke path must be the most available operation** — it is the safety action under
  incident conditions.
- **Break-glass revoke uses its own IAM-authorized function**: an
  operator can invoke the revoke intent directly with their own credentials, with no bot in the
  path — and that surface cannot produce quote signatures. The bot cannot invoke this function;
  its separate routine-revoke function cannot select the protected budget in request data.
- Entering break-glass mode first atomically increments a durable **independent deny generation**
  before cleanup starts. The generation, active cleanup epoch, and a mirror of every active routine
  signing lease live in the same independently operated high-availability control plane as the
  emergency budget, not only in the primary reservation ledger. Every routine handler must read the
  independent generation, acquire both its primary reservation and an independent
  generation-scoped lease before KMS signing, recheck that independent lease immediately before the
  KMS call, and release it only after the result is durably cataloged. Leases have a short manifest-pinned
  TTL, a bounded heartbeat, and explicit `reserved`, `kms-in-flight`, and `cataloged` phases. A handler
  may renew only while its Lambda invocation is live; the maximum invocation duration plus a fixed grace
  period is shorter than containment's lease-reconciliation deadline. An independent reconciler treats
  an expired `cataloged` lease as drainable only after it finds the complete signed artifact in the
  independent catalog. It treats an expired `reserved` lease as drainable only after the invocation is
  terminal and a conditional request record proves no KMS call began. For an expired `kms-in-flight`
  lease, missing or incomplete artifact evidence is never interpreted as no signature: the reconciler
  waits for the bounded invocation to terminate and requires either the complete catalog artifact or an
  attested terminal invocation record proving no KMS result was returned to the handler and no response
  was delivered. Otherwise containment fails closed into ordered drain/handoff and pages the operator.
  The handler cannot return a signature before the artifact and `cataloged` phase commit, so a crashed
  or hung invocation cannot leave a deliverable signature behind an expired clean lease. Failure of
  either control plane fails routine signing closed.
- The operator-authorized `break-glass-revoke` function is the control surface: on its first cleanup
  request it conditionally acquires the single active cleanup epoch and increments the independent
  deny generation atomically, then refuses to sign cleanup transactions until every older-generation
  lease in the independent control plane has drained. It mirrors the deny into the primary ledger
  when available, but primary-ledger availability is not required to arm containment. Operators need
  only `lambda:InvokeFunction` on that function; its execution role alone has conditional-write
  permission for the independent epoch/generation records. Routine invoke grants may remain present
  so IAM changes are not a containment prerequisite, while incident automation can disable those
  grants as defense in depth. An invocation admitted before emergency deny can therefore either
  finish as known revocation inventory before cleanup or produce no signature; it cannot return an
  untracked fresh signature during cleanup. If independent lease state cannot be checked or drained,
  cleanup does not claim containment and pages the operator.
- Clearing containment is an explicit `close-cleanup-epoch` operation on the same
  operator-authorized `break-glass-revoke` function; routine principals cannot invoke it, and it
  performs no KMS signing. The handler closes only the caller-specified active epoch after independent
  reads prove all replacement/cleanup transactions confirmed, the occupied-nonce inventory empty,
  and no older-generation leases remain. Its execution role may conditionally close that exact epoch
  and advance the routine-admission generation, but cannot rewrite inventory or budget history. The
  operation emits `middleware.cleanup_epoch_closed` with operator principal, epoch, old/new
  generation, evidence snapshot, and request ID to the immutable audit stream. Until that
  authenticated close succeeds, routine quote, ratify, and routine-revoke remain denied and only
  operator-authorized break-glass revocation remains available.
- Setup remediation uses separate non-signing `open-remediation-epoch` and
  `close-remediation-epoch` operations on the operator-authorized setup-remediation function. Open
  conditionally requires no active cleanup or remediation epoch, advances the independent deny
  generation, and waits for every older-generation routine lease to drain before remediation may
  sign. Each remediation request must hold a generation-scoped lease, recheck the active epoch and
  generation immediately before KMS, and durably catalog its artifact before releasing the lease.
  Close is allowed only after every remediation transaction is terminal or has a complete
  break-glass-preemptable inventory record and no remediation lease remains. It emits an immutable
  `middleware.remediation_epoch_closed` event before routine admission advances. If containment is
  required during remediation, break-glass atomically fences new remediation leases, drains or
  reconciles existing ones, and supersedes the remediation epoch with a cleanup epoch; it never runs
  two signing epochs concurrently.
- Setter cleanup treats irreversible group cancellations as authoritative. The runbook drains or
  replaces every already-signed ratification transaction and consumes every affected offer group;
  `setIsRootRatified(..., false)` is defense in depth, not the sole kill switch, because an older
  signed `true` transaction could otherwise execute later and restore the mutable root flag.

### 6. Statefulness

The Lambda's compute is **stateless per invocation** — every check is a computation over pinned
chain truth read at invocation time, and ratify intents recompute roots rather than remembering
them — but aggregate enforcement requires one small piece of **required state: a persistent
reservation ledger**. Chain-truth reads cannot see a signature that was returned but never
published, and the freshness ceiling bounds duration, not amount — without a ledger, repeated
sign-and-withhold requests could multiply exposure far beyond the caps inside one window. Every
intent that makes exposure publishable — an approved **quote or ratify** — therefore records
per-offer reservations keyed by maker, derived root, and canonical offer identity (market, group,
side, cap, price, and expiry). Capacity accounting records **one amount per protocol consumption
domain** `(maker, market, group, side, cap kind/value)`: buy domains charge per-market and
maker-wide lend-exposure counters, while reduce-only sell domains charge separate per-market
accrued-credit unwind counters and never the lend-exposure counters. In `shared-rung` mode each rung
has its own group and cap; in `per-book` mode every leaf on one side repeats the same side-wide cap
and shared group, so that cap is counted once rather than multiplied by the rung count. Leaves
remain distinct for crossed-book, PnL, publication, and expiry tracking; only repeated shared-cap
capacity is deduplicated. Aggregate lend caps, unwind inventory, crossed-book checks, and PnL checks
are enforced over current filled positions, live offers, and **every outstanding reserved offer**
with those side-specific semantics. Reservation creation transactionally updates **atomic aggregate
counters** for every affected `(maker, market)` lend or unwind cap, the maker-wide lend cap when a
buy is present, and the applicable signed-gas budget. Each counter update conditionally requires
enough remaining headroom, and the counter updates, per-offer records, deny-generation fence, and
idempotency marker commit as one transaction. The marker stores a hash of the canonical versioned
intent, including its invoke surface; reuse of an idempotency key with any different canonical hash
is a typed conflict and returns no stored artifact or new signature. Concurrent intents for
different roots therefore
serialize on shared counter versions instead of both spending the same observed headroom; a failed
condition causes a fresh snapshot and full re-evaluation, never a partial reservation. Conditional
creation makes an exact Setter ratify/publication observation idempotent and cannot double-count or
double-reserve it.

The same transaction creates a unique signing-attempt record in `reserved` state. After KMS returns
a signature, the handler durably writes the **complete signed response artifacts** — canonical
encoded payloads, every signature, and any exact signed transaction bytes plus nonce/hash/fee fields
— as immutable artifact chunks keyed by `(attempt, artifact, chunk-index)`. Each chunk contains at
most **300 KiB** of binary content so item keys, checksums, and metadata remain below DynamoDB's
400 KB item limit. A manifest on the attempt records every artifact's ordered chunk count, byte
length, and whole-artifact checksum. Chunks are written and read back with checksum verification
before one conditional update installs the manifest and moves the attempt from `reserved` to
`signed`; incomplete unreferenced chunks are safe to garbage-collect after the attempt lease. A
retry with the same idempotency key returns those exact stored artifacts without another KMS call
only after the canonical intent hash matches the marker and every manifest chunk passes length and
checksum verification; a mismatch or missing chunk fails closed. No signed response is returned
before that durable transition. Boundary tests serialize the maximum 80-offer quote response,
including both canonical Mempool payload and signed transaction bytes, assert every stored item is
below 400 KB, then reassemble byte-for-byte identical artifacts from multiple chunks. If KMS or
validation/encoding fails first, an idempotent compensation
transaction releases its exposure and signed-gas reservations, writes a terminal `failed` marker,
and returns the typed failure. A retry with the same idempotency key observes that marker rather
than releasing twice. A crash while the attempt is still `reserved` is reconciled by the same
conditional compensation after its short attempt lease: handler ordering guarantees that a
signature was not returned before `signed`, while an attempt already marked `signed` remains
reserved. Offer exposure follows the normal observation, cancellation, or freshness-expiry release
rules, but EOA transaction records and their signed-gas/nonce reservations never release on offer
freshness expiry; they remain until the nonce is confirmed or replaced/cancelled on chain.

v0 uses DynamoDB and sets a **middleware-mode rung cap of 40 per side** (80 offers) and a
**per-intent cap of seven distinct markets**. The reservation planner computes its exact primary
transaction cost as `N + C + 6`: one action for each offer record (`N ≤ 80`), one action for each
affected market-side lend or unwind counter domain (`C ≤ 2 × markets ≤ 14`), and six reserved fixed
actions for the maker-wide counter, signed-gas budget, deny-generation fence, idempotency marker,
signing-attempt record, and one catalog-manifest item containing the intent's complete root/group
inventory. The fixed actions remain budgeted even when a particular intent does not use every
counter. Consequently the largest valid plan is `80 + 14 + 6 = 100` actions and fits exactly inside
DynamoDB's `TransactWriteItems` limit. The catalog manifest is size-checked before admission. Signed-
artifact chunk writes occur only after KMS and are therefore outside the pre-sign action count; they
must still complete, verify, and durably transition the attempt to `signed` before any response is
returned, as specified above. Boundary tests cover 80 offers across seven markets with both counter
domains and reject an eighth market or any computed plan above 100 actions before validation or
signing. No request is chunked across reservation transactions: raising either cap requires a store
or schema that can atomically commit the larger maximum tree, plus updated boundary tests.

Publication is tracked per leaf, not merely per root. A reservation moves from reserved to live
when that exact offer is observed and is released on its own freshness expiry. Partial group
consumption is not a terminal release condition: reconciliation keeps the group's remaining
takeable capacity reserved and moves consumed buy capacity into the independently read filled
position, so a buy fill does not reopen aggregate lend headroom. A group reservation is terminally
released only when consumption reaches the affected cap, including `MAX_OFFER_CAP` cancellation.
Ecrecover root cancellation is also a terminal release condition for every affected reserved leaf,
including signed-but-unpublished leaves that can no longer become takeable. Setter `false` releases
only after the older signed `true` transaction has been replaced or otherwise made unusable and that
outcome is final; cap-reaching irreversible group consumption remains the authoritative immediate
Setter release signal. Releases decrement the same aggregate counters transactionally and carry an
idempotent terminal marker, so observation, cancellation, and expiry races cannot free capacity
twice. Observing one live leaf never releases a still-publishable sibling merely because they share
a root. The ceiling and terminal cleanup keep the ledger tiny and self-expiring. The reservation
ledger tracks the
routine signed-gas budget and the break-glass-principal-only protected revoke reserve; the separate
ledger-independent emergency allowance is consumed only by that break-glass principal during a
ledger outage. Together those budgets make the bounded-loss claim hold. The middleware validates
routine transaction nonces against the current pending nonce and conditionally leases that nonce
before KMS signing, but does not allocate or advance the account's nonce cursor; the durable lease,
routine single writer, and break-glass runbook coordinate the stream.

### 7. Failure posture

| Failure                                   | Required behavior                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Invocation fails (throttle, error, limit) | Halt quoting (fail closed) and retry; offers stand                                               |
| Cold start latency                        | Tolerated; the hourly-ish cadence absorbs it                                                     |
| Quote intent denied                       | Typed rejection, nothing signed; alert if persistent                                             |
| Revoke intent denied                      | Near-impossible by design; treat as misconfig, alert                                             |
| Concurrent tx signers (bot + break-glass) | Replace every recorded occupied nonce before waiting; otherwise ordered handoff                  |
| Read fails or snapshot is incoherent      | Fail closed: typed retryable denial, no signature                                                |
| Reservation ledger unavailable            | Quote, ratify, routine revoke, and setup remediation closed; break-glass uses independent budget |
| Independent revoke budget unavailable     | Revoke fails closed and pages operator                                                           |
| KMS error                                 | Typed failure; never assume a signature was produced                                             |
| Policy parameters missing/invalid at init | Refuse to serve; never run a partial or empty policy                                             |
| Unknown intent type/version               | Reject; no best-effort interpretation of payloads                                                |

## Considered Alternatives

### Alternative 1: Status quo — in-process policy plus direct KMS

Keep the in-process guards — offer invariants, `MakeService`, and the quoter's transaction
assertions — with the bot calling KMS directly.

**Why rejected:** The policy and the attacker share a process. A compromised bot host bypasses
every in-process check and still holds `kms:Sign`, and KMS blind-signs digests. The in-process
guards remain valuable as fast feedback, but they are not a security boundary.

### Alternative 2: AWS-native controls only

Constrain the existing grant with IAM conditions, KMS grants, and CloudTrail auditing.

**Why rejected:** No content-based condition keys exist for `kms:Sign` — IAM can pin the algorithm
and message type, not the digest, so it cannot distinguish an in-policy offer from a drain
transaction. CloudTrail is after-the-fact audit, not prevention.

### Alternative 3: On-chain bounded quoter ratifier only

Ship the custom ratifier from the V1 track that enforces price/spread bounds on-chain.

**Why rejected:** Strongest enforcement for offers, but it is a contract build plus audit, and it
cannot constrain the **EOA transaction surface** — preventing fund transfers on-chain needs the
delegated funding contract. The middleware ships sooner, covers every signed payload class, and
complements rather than replaces the on-chain track.

### Alternative 4: Self-hosted proxy service

Run the middleware as a standing service — e.g. a Railway service reached over private networking
with mTLS or a bearer token — the shape an earlier draft of this TIB proposed.

**Why rejected:** Self-managed authentication, ingress, patching, and a standing server to secure
and keep alive. The Lambda shape is an IAM-native invoke chain in the same trust domain as KMS:
no ingress at all, scale-to-zero, SigV4 authentication for free, and CloudTrail-attributable
calls on both the invoke and the sign.

### Alternative 5: Custody SaaS with a policy engine

Adopt a Fireblocks/Turnkey-style provider whose policy engine gates signatures.

**Why rejected:** Vendor dependency and cost, and it weakens the open-source reference — third
parties must be able to reproduce the architecture. A self-hosted middleware keeps the design
forkable; a custody SaaS remains an option an individual operator may substitute.

### Alternative 6: Per-make multisig or MPC approval

Require a second human or MPC quorum signature per make/invalidate.

**Why rejected:** Latency and operational overhead are incompatible with automated hourly-ish
quoting and one-minute bootstrap monitoring. Multisig remains the right tool for treasury
operations, not per-offer signing.

### Alternative 7: Nitro-Enclave-attested signing

Bind the KMS key policy to enclave attestation so only attested middleware code can sign — which
would move signing onto an attested EC2 enclave host in place of the Lambda.

**Why rejected:** Deferred — elegant, but a heavy operational lift (enclave builds, attestation
management, reproducible images) for v0. Recorded as a possible future hardening of the middleware
host itself; it strengthens rather than changes this design.

## Assumptions & Constraints

- IAM can express the intended split: the bot's role holds `lambda:InvokeFunction` on exactly
  setup/health, quote, and routine-revoke, plus ratify only in Setter mode. The active signing Lambda
  execution roles are the sole `kms:Sign` principals on the maker key, while every active function
  role holds narrowly scoped `kms:GetPublicKey` solely for per-surface startup attestation;
  break-glass operators hold only the separate break-glass-revoke invoke grant, and remediation
  operators hold only the setup-remediation invoke grant. Exact EventBridge rule ARNs receive
  resource-based permission to invoke dedicated attestation aliases with an immutable non-signing
  attestation payload; signing production aliases receive no such permission, and only the deployment
  role may mutate the pinned targets. No scheduler role receives general invoke credentials. Policy selects the budget
  from that fixed function deployment, never from caller-controlled request data.
- Every signed payload class is fully describable as structured intents and canonically
  encodable inside the Lambda (SDK EIP-712 offer-tree hashing and Mempool payload encoding; viem
  transaction serialization).
- The policy surface splits cleanly: price bounds and field pins are **deployment parameters**;
  the crossed-book and no-PnL-drop properties are evaluated against the Lambda's **own
  independent reads** (RPC and Morpho API/Mempool). The Lambda has network egress to a reviewed,
  deployment-pinned provider set. v0 must specify that exact set, its quorum threshold, and
  normalization rules; every required policy value must reach quorum for the same deterministic
  snapshot. A failed read, insufficient quorum, provider disagreement, or mixed-block view is a
  typed denial with no KMS call. Quote and ratify signing remain disabled until this provider and
  fail-closed disagreement policy is configured and covered by acceptance tests.
- DynamoDB is available to the Lambda for the reservation ledger and
  invoke-surface-and-intent-keyed signed-gas budgets. Middleware mode enforces the 40-rung-per-side
  cap so every reservation plan fits one 100-action transaction; configuration and runtime guards
  reject larger plans before signing. The primary ledger and independent transaction/revocation
  inventories hold **sensitive bearer capabilities** whenever they persist signatures, signed
  transactions, or publishable payloads. They require encryption at rest and in transit,
  least-privilege read access, no ordinary diagnostic/read-replica access, audited access, and
  retention/deletion controls aligned with terminal reservation state. Their unavailability fails
  quote/ratify, bot-originated routine revokes, and setup remediation closed, while
  break-glass revocation must atomically consume the independently stored emergency budget or fail
  closed and page the operator.
- The maker EOA's native balance is operationally bounded: every routine/remediation admission must
  preserve the live required protected-balance floor above `NATIVE_RESERVE_WEI`, and funding remains
  below the configured ceiling, with alerts on either breach. The floor includes outstanding routine
  spend, protected replacement bids for the occupied set, and protected full-book cleanup. The
  gas-grief hard cap is this operational control, not a protocol guarantee.
- One invocation round trip per make/revoke job — including cold starts — is compatible with the
  hourly-ish quote cadence and the one-minute bootstrap monitor.
- The Lambda is meaningfully harder to compromise than the bot host — minimal code and
  dependencies, an AWS-managed runtime, no ingress, no strategy complexity. That asymmetry is the
  premise of moving the root of trust.
- v0 serves one bot and one maker key; the wire contract is versioned so this can widen later.

## Dependencies

- AWS KMS `Sign`/`GetPublicKey` on a newly generated `ECC_SECG_P256K1` maker key
  ([AWS KMS Sign API](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html)); the old
  maker key is referenced only for quarantine and inventory backfill and is never provisioned to the
  middleware.
- AWS Lambda (container-image function) and ECR for the image, plus IAM for the invoke-only and
  execution role chain
  ([Lambda container images](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)).
- The Lambda's independent read surfaces: resilient RPC access (fallback and/or quorum across
  providers) and the Morpho API/Mempool for live offers, positions, and chain state.
- A versioned Morpho API/Mempool response that exposes authoritative indexed-block number/hash
  metadata for every live-offer and position read used by policy. The current generated
  `ListTakeableOfferResponse` exposes only `cursor` and `data`, so adding and consuming this
  metadata is a blocking v0 deliverable; middleware quote/ratify signing must remain disabled
  until an integration test proves all policy reads can be pinned to one indexed block.
- A reviewed PnL/cost-basis specification and independent input contract, implemented as deployment
  policy with acceptance vectors for profitable, exact-boundary, and loss-making fills. This is a
  blocking v0 deliverable; quote/ratify signing remains disabled until those tests pass.
- A deployment-pinned independent-read provider set with an explicit quorum threshold and
  fail-closed disagreement/normalization policy. This is a blocking v0 deliverable; quote/ratify
  signing remains disabled until integration tests prove disagreement, insufficient quorum, and
  mixed-snapshot responses produce no KMS call.
- DynamoDB for the reservation ledger and signed-gas budget, with conditional writes and the
  middleware-only rung cap that keeps each reservation within one transaction.
- `@morpho-org/midnight-sdk` offer-tree EIP-712 hashing for canonical encoding inside the Lambda.
- viem for transaction serialization and signature parsing/verification in the Lambda.
- The middleware validates the KMS `GetPublicKey` SPKI by exact canonical-DER template comparison
  plus an on-curve check (`@noble/curves`), unlike the bot's asn1js-based parse: DER is canonical,
  so the uncompressed-secp256k1 `SubjectPublicKeyInfo` has exactly one 88-byte encoding, and the
  root-of-trust image deliberately carries no ASN.1 library. Its strict canonical ECDSA-DER
  signature parser mirrors the bot's proven parser rather than sharing a module, per the
  middleware's mirror-not-share auditability rule.
- [TIB-2026-07-27](./TIB-2026-07-27-midnight-quoter-bot.md) for the V1 security gate this TIB
  advances.

## Observability

- The Lambda emits the same JSON-lines structured logging the bots use (to CloudWatch Logs).
  Every intent produces a decision event with intent type, evaluated properties and constraints,
  the violated check on denial, and the **expected KMS call set per signed artifact**. An
  approved Ecrecover quote produces exactly one `kms:Sign` call for the tree signature; its encoded
  publication payload is sent by the constrained non-maker broadcaster and never creates a maker
  KMS call. Setter ratification, revoke, and setup-remediation transactions each produce one call
  per signed transaction artifact. Every call is logged with its derived digest, the **KMS request ID** returned with the
  signature, and outcome: `middleware.intent_received`,
  `middleware.intent_approved`, `middleware.intent_denied`, `middleware.kms_error`,
  `middleware.read_failed`.
- This log is an **authorization audit trail that survives bot-host compromise** — the bot cannot
  erase or forge it.
- CloudTrail covers the full chain: `lambda:InvokeFunction` attributes every caller (bot,
  break-glass, remediation, or scheduled-attestation principal), and `kms:Sign` allows exactly the
  configured active signing execution-role ARNs. The reconciler maintains that mode-aware allowlist
  and maps each role ARN to its one expected intent
  surface; a call from an unknown role or a known role signing for another surface is an incident. The KMS call stream for
  each role/surface pair must reconcile against the logged per-artifact signing records. CloudTrail `Sign`
  events do not carry the message or digest, so the join key is the **KMS request ID** each
  signing record captures: every CloudTrail `Sign` event must match one middleware record and
  vice versa, at artifact rather than intent granularity. An unmatched or surplus call on either
  side is an incident signal.
  Lambda `Invoke` is a CloudTrail **data event and is not logged by default**
  ([Lambda CloudTrail docs](https://docs.aws.amazon.com/lambda/latest/dg/logging-using-cloudtrail.html));
  enabling data-event selectors for every active function ARN is an explicit v0 deliverable —
  without complete coverage, the invoke side of this audit trail silently omits intent surfaces.
- Alerting on denials, invocation errors/throttles, KMS errors, and independent-read failures.
  Bot-side `make.rejected` events extend with middleware-denial reasons; invocation-failure halts
  surface through the existing failure events.

## Security

**What the middleware stops** (a fully compromised bot host can no longer obtain):

- Arbitrary transaction signatures — `transfer`/`approve` of the loan asset, calls to unexpected
  contracts, value transfers. KMS refuses the bot's principal outright; the Lambda signs only
  payloads it encoded from in-policy intents.
- Arbitrary EIP-712 signatures — in particular ERC-2612/Permit2-style permits, which move funds
  without any maker transaction.
- Off-policy offers — crossed books, out-of-bounds prices, PnL-degrading quotes, wrong market,
  per-intent or aggregate over-exposure (including sign-and-withhold multiplication, blocked by
  the reservation ledger), expiry beyond the freshness ceiling, foreign
  receiver/callback/ratifier, foreign group namespace, malformed cap semantics.
- Lying about book state — the crossed-book and PnL properties are evaluated against the Lambda's
  own reads, so a compromised bot cannot feed it a fabricated view.

**What it does not stop:**

- **Compromise of the Lambda's code or deployment pipeline** — the new, deliberately minimal root
  of trust. Mitigated by a small codebase, minimal dependencies, an AWS-managed runtime with no
  ingress, and separate roles; Nitro-attested signing is a recorded future hardening.
- **Policy bugs** — a wrong parameter or check approves what it should not. The policy is small
  and exhaustively testable, but it is code.
- **Economically bad but in-policy quoting** — the residual, deliberately accepted exposure:
  worst case ≈ worst in-policy rate × capped aggregate signed exposure. Bounded and
  quantifiable. This includes delayed publication — a stockpiled signature stays publishable
  until its expiry, with the reservation ledger capping how much can be outstanding and the
  freshness ceiling capping for how long — and native-gas spend through valid transaction
  signatures, capped by the rolling signed-gas budget. Middleware-direct publication and
  ratifier/Mempool-enforced freshness are recorded hardenings.
- **Misbehavior of the providers behind the Lambda's own reads** — a lying or censoring RPC/API
  could wave through a crossed or unsustainable set, or block valid ones. This extends the
  provider-trust posture of [TIB-2026-07-27](./TIB-2026-07-27-midnight-quoter-bot.md) to the
  middleware. The v0 deliverable must pin provider members and a quorum threshold, then fail closed
  with no KMS call on disagreement, insufficient quorum, or an incoherent snapshot; quote/ratify
  stays disabled until that configuration and its integration tests are complete (Open Question 6).
- **DoS via invocation throttling or concurrency exhaustion** — quoting downtime; resting offers
  stand until expiry or revocation through a break-glass invoker.

Attacker-obtainable revocations are downtime/griefing plus bounded native-gas spend, not
loan-asset loss — per-intent invoke scoping and the per-surface gas budgets keep that griefing
hard and capped, the protected revoke reserve keeps a compromised routine invoker from starving
break-glass capacity, and the native-balance admission ceiling — an explicit fail-closed signing
control distinct from the `NATIVE_RESERVE_WEI` minimum — prevents unsolicited excess balance from
becoming routine attack capacity. The protected break-glass allowance is accounted separately.

**Bounded-loss framing.** Today, bot-host compromise means unbounded loss of everything the maker
EOA holds or has approved. With the middleware, it means a bounded, pre-computable number derived
from the policy's price bounds and exposure caps. That conversion — unbounded key authority into a
quantifiable worst case — is a prerequisite for lifting the 20,000 USDC per-market cap under the
[TIB-2026-07-27](./TIB-2026-07-27-midnight-quoter-bot.md) V1 gate, alongside the treasury and
on-chain-ratifier tracks.

Policy parameters change through the Lambda's own deployment/review path, unreachable from the
bot. The bot host holds only invoke-scoped AWS credentials — no `kms:Sign`, no policy access.

## Testing and Verification

- **Policy:** exhaustive accept/reject vectors for the three properties and every applicable field check
  across all four structured intent types — quote, ratify, revoke, and setup remediation — including
  boundary values — price exactly at a bound, expiry exactly at
  maturity or the freshness ceiling, aggregate exposure that overflows only in combination with
  live offers or outstanding reservations, sign-and-withhold sequences denied once reservations
  exhaust the caps — through quote or ratify approvals alike, two individually valid withheld
  sets whose combination crosses denied on the second request, a Setter ratify followed by the
  matching publication reusing one reservation, a partial publication releasing only observed
  leaves while siblings stay reserved, a crossing replacement denied until its retired groups
  are observed invalidated and approved after, a ratify root that does not match its offer set,
  `setConsumed` with a foreign `onBehalf` or non-`MAX_OFFER_CAP` amount denied, a credit-reducing
  offer without `reduceOnly` denied, reduce-only sells accepted at zero lend headroom and denied
  only when their separate accrued-credit unwind inventory is exhausted, a caller-supplied
  `continuousFeeCap` above the snapshot fee denied, a root revocation targeting Midnight instead
  of the ratifier denied, mixed-snapshot reads denied as incoherent,
  missing or inconsistent API indexed-block metadata denied, ladder and bootstrap offers on a
  long-dated market persisted with `min(maturity, signedAt + freshness)` expiry,
  maker-wide cleanup encoded as one policy-checked multicall whose inner `setConsumed` calls all
  pass the same target/maker/cap checks, with nested/empty/foreign-selector batches denied,
  a routine signed-gas budget refusing the next publication while the revoke reserve still
  signs, both/neither of `maxUnits`/`maxAssets` set,
  off-by-one exposure caps, a prospective set that crosses only in combination with live offers,
  PnL vectors for profitable, exact-boundary, and loss-making fills using only the specified
  independent cost-basis inputs; setup-remediation vectors cover every manifest-pinned target,
  selector, chain, asset, spender/operator, allowance/authorization ceiling, zero-value rule,
  nonce lease, rolling gas budget, idempotency key, same-nonce replacement, artifact/catalog
  persistence, and break-glass preemption path, with off-by-one ceilings, foreign fields, arbitrary
  calldata, and missing persistence denied; and provider disagreement or insufficient quorum denied
  with no KMS call.
- **Adversarial state:** intents accompanied by caller-supplied book or position state that
  contradicts chain truth — the Lambda must ignore the caller's view entirely and decide from its
  own reads.
- **Encoding equivalence:** the Lambda-derived EIP-712 digest for a validated offer tree matches
  SDK/bot-side hashing for identical structured input; transaction serialization matches viem's
  for identical fields.
- **Signature correctness:** recovered signer equals the configured maker across both recovery
  parities, reusing the existing strict DER/low-s/recovery-check discipline. The authenticated
  signer-identity setup port reports the KMS-derived maker and passes readiness only when every
  deployed surface attests the same endpoint, chain, key fingerprint, image digest,
  deployment-manifest digest, and configured maker, and each surface's distinct configuration
  digest matches its own manifest entry; drift on any one signing function fails closed without exposing a generic
  challenge-signing surface.
- **Fail-closed negatives:** generic digest-signing requests are rejected; unknown intent
  versions are rejected; an independent-read failure produces a typed denial and no KMS call; a
  missing or invalid policy configuration refuses to serve.
- **Integration:** bot plus deployed Lambda against a KMS test key — quote publish, revoke,
  denial propagation into `make.rejected`, the invocation-failure halt, a break-glass revoke
  invoked by a second IAM principal, an attempted bot invocation of `break-glass-revoke` denied by
  IAM, a routine-revoke payload that claims break-glass identity still charged only to the routine
  budget. Prove the admission-ceiling alert and readiness failure when the maker's native balance
  exceeds its configured maximum, and prove every routine and non-sweep setup-remediation signing
  surface rejects before KMS while operator-only break-glass remains available. Prove the
  manifest-pinned native-balance sweep remains available only above that ceiling and still enforces
  its independently derived value, treasury target, maintenance epoch, nonce lease, attestation, and
  dedicated setup-remediation rolling budget. Exhaust that budget by signed gas and independently by
  transaction count; prove further remediation fails before KMS, cannot spill into the routine or
  break-glass class, and becomes admissible only after the configured rolling window releases capacity.
  Queue routine publications at consecutive
  occupied nonces plus a setup-remediation approval at a nonce with no revocation target, then prove
  break-glass pre-signs and broadcasts replacements for every occupied nonce before waiting, using
  the exact break-glass self-cancel for the remediation-only nonce rather than signing only the lowest
  or the next unused nonce. Raise the base fee above the routine max-fee bump and
  prove break-glass uses `baseFee * 2 + newPriorityFee`, then fails closed when that live result
  exceeds the protected ceiling. Fill the configured occupied-nonce limit and prove a new-nonce
  request is denied while a same-nonce replacement remains allowed; race requests for the final slot
  and prove only one commits. Prove primary-ledger outage cleanup uses the independent transaction
  inventory's exact nonce and fee records; a missing, incoherent, stale-replica, or lagging-watermark
  inventory forces ordered handoff. Enter break-glass while routine-revoke is in flight and prove its
  generation lease drains before cleanup and no new routine revoke can be signed until emergency deny
  is cleared. Crash handlers separately in `reserved`, `kms-in-flight`, and `cataloged`, advance past
  the lease TTL and invocation timeout, and prove reconciliation drains only a terminal pre-KMS
  request or a complete catalog artifact; an ambiguous KMS result keeps containment fail-closed.
  Stop the scheduled attestation refresh, prove records age red without signing traffic, then restore
  refresh and prove each exact alias/version record becomes fresh without a redeploy.
- **Retry and delayed-broadcast safety:** drop the first Lambda response after the durable `signed`
  transition and prove the transaction inventory already contains the exact artifact before an
  idempotent retry returns byte-identical stored artifacts without a second KMS call. Inject an
  inventory-write failure and prove neither the `signed` transition nor stored-artifact delivery is
  possible. Reuse that key with a different canonical intent and prove it returns a typed conflict,
  no artifacts, and no KMS call. Race two routine signing intents at the same pending nonce and prove
  exactly one acquires the pre-sign nonce lease and reaches KMS. Withhold a signed transaction beyond
  its offer freshness expiry and prove its transaction
  record, nonce fence, and signed-gas reservation remain until that nonce is confirmed or replaced/
  cancelled on chain. Sign an economic transaction, then create a same-nonce bump and a self-cancel;
  prove the independent inventory retains every hash, byte string, and fee pair append-only, marks
  only the newest entry active for routine replacement, and derives break-glass fees from the maximum
  across all three artifacts.
- **IAM cutover proof:** demonstrate the middleware uses a newly generated maker key/address never
  exposed to the direct `aws` signer, and prove direct bot and operator access to `kms:Sign` is denied
  before the quarantine expiry clock starts. Keep the old maker quarantined until known artifacts are
  revoked/reconciled, approvals are removed, and every permit/authorization signature class has
  expired; inventory backfill alone is not accepted as proof against unknown historical blind
  signatures. If cleanup retains old-key access, prove the policy-checked cleanup-only path rejects
  quotes, ratifications, setup transactions, and caller-selected payloads, then prove the path is
  removed after cleanup. Demonstrate the bot's principal receives `AccessDenied` on `kms:Sign`
  and `kms:GetPublicKey` after the grant moves, that readiness can invoke setup/health and obtain only
  its constrained response, that each function role can call `kms:GetPublicKey` only on the pinned
  maker key, that the setup/health role cannot call `kms:Sign`, and that each role can invoke only its
  granted production-alias surfaces. Ecrecover includes and attests quote while omitting the ratify
  function, aliases, invoke grants, EventBridge target, readiness entry, and KMS principal; Setter
  makes the symmetric choice by including and attesting ratify while omitting all quote resources and
  permissions. Prove a break-glass principal is denied on setup/health, quote, ratify, and
  setup-remediation, and that the remediation principal is denied on every non-remediation surface.
  Prove a permitted setup approval is canonically encoded
  and signed only during a distinct remediation epoch, while foreign targets/spenders, excessive
  allowance, transfers, permits, non-zero value, and attempts outside the epoch produce no KMS call.
  Prove remediation is denied during a reservation-ledger outage and that opening/closing its epoch
  advances the independent deny generation, drains older leases, and never overlaps a cleanup epoch.
  For every bot and operator surface, prove the exact production alias succeeds while the unqualified
  function ARN, `$LATEST`, every other version/alias, and every cross-surface production alias receive
  `AccessDenied`. Prove each signing role can call `lambda:GetAlias` only on its own unqualified
  function ARN and `lambda:GetFunction` only on its manifest-pinned exact qualified published-version
  ARN. Prove setup/health can make those same reads for every active surface and that all roles are
  denied on every other unqualified or qualified function resource. Because IAM cannot scope
  `GetAlias` to an alias ARN, prove handler/manifest validation accepts only the exact configured alias
  name and rejects every other alias name before trusting the resolved target. Setup/health rejects an
  attestation whose published version differs from the resolved alias target, and fails readiness when
  `RoutingConfig.AdditionalVersionWeights` is non-empty. Add weights after readiness while the registry
  record is still fresh and prove every signing handler's per-request alias preflight rejects before
  reservation or KMS. Prove a deployment-role invoke of an exact version succeeds for the non-signing
  attestation operation but that quote, ratify, revoke, and remediation signing payloads on that same
  version ARN are rejected by `invokedFunctionArn` validation before reservation or KMS. Prove
  deployment automation refuses a weighted production-alias rollout. Replace a function version with
  a different image while preserving all manifest-provided fields and prove the AWS-observed
  `Code.ResolvedImageUri` mismatch fails attestation before its registry write. Prove setup/health can
  call `events:ListTargetsByRule` on each manifest-pinned exact rule ARN, but not on an unlisted rule,
  and prove bot, scheduler, signing, operator, and remediation roles cannot call it. Prove each exact
  EventBridge rule ARN can invoke only its dedicated attestation alias with the immutable non-signing
  payload; prove the bot cannot refresh through a production alias and that the attestation alias rejects
  every signing intent before reservation or KMS. Prove `events:PutTargets`, `events:RemoveTargets`, and
  `events:DeleteRule` are denied to bot, scheduler, signing, and operator roles; mutate a target with the
  deployment role and prove target-tuple drift fails readiness and alarms before freshness acceptance.
  A different rule/service source, inactive alias, cross-surface alias, or arbitrary signing payload is
  denied. Verify those invokes and every active function ARN
  appear in CloudTrail data events. A denied call is part of
  acceptance, not an incident.
- **Protected native-balance proof:** admit routine and setup-remediation artifacts up to the
  occupied-nonce boundary, then prove the next candidate and every sweep fail before KMS if their
  worst-case spend would leave less than `NATIVE_RESERVE_WEI` plus all outstanding routine spend,
  one live-base-fee-derived protected replacement per occupied nonce, and protected full-book cleanup.
  Prove the boundary succeeds exactly and that missing balance, fee-history, or occupied-set evidence
  fails closed.
- Tests follow the repository verification rule: run each new test, break one assertion to
  confirm it fails, restore it.

## Future Considerations

- Nitro-Enclave attestation binding the KMS key policy to attested signing code (Alternative 7)
  as host hardening.
- Generalizing to other bots and keys — multi-tenant policy keyed by principal and key.

- When the on-chain bounded ratifier lands, its bounds and the middleware's price policy should
  agree; the middleware remains necessary for the transaction surface.
- Middleware-direct publication to the Mempool, or ratifier/Mempool-enforced signature freshness,
  to shrink the delayed-publication residual below the freshness ceiling and retire the
  reservation ledger's unpublished-exposure role.

## Open Questions

1. Workspace directory and package naming for the Lambda — proposed `services/quoter-signer`
   under a new top-level `services/` directory; settled at implementation.
2. Whether validation logic is shared with bot domain code (one bug affects both — `@repo/offers`
   is the natural shared home for the crossed-book model) or independently implemented (drift
   risk) — likely a shared schema, independently pinned middleware deployments.
3. The exact PnL/cost-basis model and independent input contract. This must be specified, reviewed,
   and acceptance-tested before v0 quote/ratify signing can be enabled; it is not left to the
   implementer.
4. Policy parameter change/approval workflow — who reviews, how it deploys, how changes are
   audited.
5. The reservation ledger's concrete store and consistency design — DynamoDB conditional writes
   are the default candidate — including release on observed publication/invalidation, expiry
   eviction, per-surface budget partitioning details, and the independently operated,
   high-availability independent emergency-budget store used during a ledger outage. Every outage
   revoke must atomically consume that durable allowance or fail closed; reserved concurrency is
   only availability isolation and never substitutes for budget accounting.
6. The exact deployment-pinned provider members and quorum threshold for independent RPC and Morpho
   API/Mempool reads. The decision posture is settled: disagreement, insufficient quorum, or an
   incoherent snapshot fails closed with no KMS call, and quote/ratify remains disabled until this
   configuration and its integration tests are complete.

## References

- [TIB-2026-07-27: Midnight ladder quoter-bot — v0](./TIB-2026-07-27-midnight-quoter-bot.md)
- [`maker-account.utils.ts`](../../bots/quoter-bot/src/infrastructure/make/maker-account.utils.ts)
  — KMS-backed viem `LocalAccount`
- [`signer-identity.utils.ts`](../../bots/quoter-bot/src/config/signer-identity.utils.ts) —
  signer identity selection
- [`packages/bot-kit/src/signer.ts`](../../packages/bot-kit/src/signer.ts) — shared default-deny
  signer used by the liquidation bots; not on the quoter's signing path today
- [`production-ladder.ts`](../../bots/quoter-bot/src/infrastructure/ladder/production-ladder.ts)
  — on-chain Mempool publication, ratification, and invalidation transactions
- [`ladder-transaction.utils.ts`](../../bots/quoter-bot/src/infrastructure/ladder/ladder-transaction.utils.ts)
  — the quoter's in-process transaction assertions
- [quoter-bot README](../../bots/quoter-bot/README.md) — signed payload classes and `aws`-mode
  deployment
- [Documentation guidance](../GUIDANCE.md)
- [Repository conventions](../CONVENTIONS.md)
- [AWS KMS Sign API](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html)
- [AWS Lambda container images](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)

## Addendum A (2026-08-25) — delivery skeleton: workspace home and public image

Implementation starts with the deployable skeleton, ahead of any policy surface:

- **Open Question 1 is settled as proposed**: the middleware lives at `services/quoter-signer`
  under the new top-level `services/` directory, as workspace package
  `@morpho-org/quoter-signer`. Because the frozen lockfile validates the full workspace importer
  set, every bot `Dockerfile` now copies `services/` alongside `packages/` and `bots/`.
- **Image distribution**: the image builds from `services/quoter-signer/Dockerfile` (repo-root
  context; workspace build stage → AWS Lambda Node.js 24 base runtime stage that receives only the
  self-contained handler bundle) and publishes publicly to Docker Hub as
  `morphoorg/quoter-signer`, extending the
  [TIB-2026-08-14](./TIB-2026-08-14-quoter-bot-dockerhub-publishing.md) third-party
  reproducibility posture to the middleware. ECR remains the deployment registry — AWS Lambda
  pulls container images only from a private ECR repository in the function's region (same-account
  is the simple path; cross-account needs an ECR repository policy) — so operators copy the
  published image into their own ECR; the package
  [README](../../services/quoter-signer/README.md) documents the full build → verify → publish →
  Lambda flow. CI publishing is not wired yet; the README's manual push is the interim channel.
- **v0 image behavior**: the handler is a fail-closed skeleton — it holds no KMS access,
  implements no signing surface, and answers every invocation with a typed
  `SigningNotImplementedError` denial while emitting the `middleware.intent_received` /
  `middleware.intent_denied` JSON-line events with only allowlist-classified intent kinds. The
  signing surfaces, policy checks, reservation ledger, IAM topology, and bot-side intent ports
  land in later increments of this TIB.

## Addendum B (2026-08-25) — v1 wire contract and bot-side middleware identity

The second increment defines the wire contract at the code level and the bot-side selection seam,
still entirely fail-closed:

- **Request DTO**: the versioned JSON intent union (`quote`, `ratify`, `revoke`,
  `setup-remediation`) is typed and strictly parsed in
  [`services/quoter-signer/src/intent.utils.ts`](../../services/quoter-signer/src/intent.utils.ts)
  — canonical decimal strings for uint256-range values, checksummed addresses, explicit
  consumption groups, market-by-`marketId` only (market parameters stay middleware-resolved), the
  80-offer (40 per side)/7-market wire caps, and outright rejection of unknown versions, kinds, and keys via a
  typed `MalformedIntentError`. Well-formed intents still deny with
  `SigningNotImplementedError`; both denials now carry `retryable`.
- **Response DTO**: the approval-or-denial envelope union lives in
  [`services/quoter-signer/src/response.utils.ts`](../../services/quoter-signer/src/response.utils.ts)
  — per-kind approval payloads (tree signature + encoded publication for quote; signed
  transaction artifacts with exact bytes, hash, nonce, and fee fields for ratify, revoke, and
  setup remediation) that the skeleton never produces.
- **Bot-side trigger**: `signer-identity.utils.ts` gains the `middleware` identity method
  alongside `private-key`/`keystore`/`aws`, selected by `QUOTER_SIGNER_LAMBDA_ARN`
  (`identity.quoterSignerLambdaArn`, CLI `--middleware`). The value must be an alias-qualified
  Lambda ARN — this TIB's production-alias invocation rule enforced at configuration time, so
  unqualified ARNs, version qualifiers, and `$LATEST` are rejected — and the AWS region derives
  from the ARN. As specified in §3, the identity is not a drop-in signer:
  `createMakerAccount` fails closed with `MiddlewareSigningUnsupportedError`, so write flows halt
  until the intent ports land; read-only operation is unaffected.

## Addendum C (2026-08-25) — deterministic deployment-policy checks

The third increment lands the policy checks decidable from deployment parameters and the
middleware clock alone, still entirely fail-closed (no KMS access, no signing surface):

- **Policy document**: the `QUOTER_SIGNER_POLICY` environment variable carries one versioned JSON
  policy document, strictly parsed in
  [`services/quoter-signer/src/policy.utils.ts`](../../services/quoter-signer/src/policy.utils.ts)
  with the wire contract's fail-closed discipline. It pins the signing `surface` (the five-function
  shape's per-deployment intent-kind and budget-class pin, never read from caller data), the
  ratifier mode, chain id, maker, and ratifier address, the offer freshness/start windows, a
  non-empty per-market allowlist (maturity, tick bounds within the protocol `MAX_TICK`,
  continuous-fee-cap ceiling within `MAX_CONTINUOUS_FEE`, per-market lend-exposure cap), the
  maker-wide lend-exposure cap, routine and protected fee/gas ceilings, and the manifest-pinned
  setup-remediation variants with per-variant ceilings. Parse-time deployment validation enforces
  quote↔Ecrecover and ratify↔Setter coherence and this TIB's emergency-bump reserve: each protected
  ceiling must cover `max(floor(routine * 1125 / 1000), routine + 1 wei)`, with `protected.gas ≥
routine.gas`. A missing or invalid document refuses to serve with a typed
  `PolicyNotConfiguredError` on every intent ("never run a partial or empty policy").
- **Checks**:
  [`services/quoter-signer/src/policy-check.utils.ts`](../../services/quoter-signer/src/policy-check.utils.ts)
  denies out-of-policy intents with a typed `IntentPolicyViolationError` naming the violated check
  (logged on the `middleware.intent_denied` line, per Observability): surface/intent-kind, chain and
  maker pins, per-kind fee ceilings (protected only on the break-glass surface, per-variant for
  remediation), `cancel-root`/`unratify-root` ratifier-mode coherence, the remediation-variant
  allowlist, and for offer sets: market allowlist, tick price bounds, offer field pins (configured
  ratifier; no callback surface; zero receiver on buys and the maker on sells, the protocol rule),
  reduce-only side pins, per-market continuous-fee-cap ceilings, time windows
  (`start < expiry`, unexpired, `expiry ≤ min(maturity, now + freshness)`,
  `start ≥ now − maxStartAge`), and static lend-exposure caps charged once per consumption domain
  `(market, group, side, cap value)` per §6, so per-book rungs sharing a group count once.
- **Group namespace, resolved**: Midnight consumption groups are content-addressed (the SDK derives
  singleton and shared group ids from offer contents) and consumption is keyed per maker on chain,
  so no maker-owned id namespace exists to pattern-match. The "owned group namespace" field check
  materializes as (a) the static group-coherence rule above — one group id binds one market, side,
  and cap inside an intent, the identity §6's capacity domains rely on — and (b) canonical group and
  root re-derivation from full market parameters at the encoding increment, where the middleware
  injects the pinned maker into every offer it encodes.
- **Explicitly deferred** to later increments: every independent-read property (crossed books, PnL,
  snapshot-derived market fees bounding `continuousFeeCap`, position state), the reservation ledger
  (aggregate signed exposure, signed-gas budgets, nonce leases, occupied-nonce caps,
  native-balance admission), and the recorded-transaction validation of `self-cancel`. Passing every
  deterministic check therefore still ends in the typed `SigningNotImplementedError` denial.
- **Sequencing note**: the freshness ceiling is deliberately ahead of the bot. Today's ladder and
  bootstrap builders pin `expiry = market maturity`, so enforcing this middleware against them
  would deny every quote/ratify intent; the §3 builder change to
  `expiry = min(maturity, signedAt + freshness ceiling)` is a prerequisite of the increment that
  enables quote/ratify signing, and the middleware clock's skew against the bot's block-timestamp
  `signedAt` must be absorbed by the builder's margin and the `maxStartAgeSeconds` window. The
  package README carries the operator guidance for the policy values (tick-band drift with
  time-to-maturity, `maxContinuousFeeCap` defaulting to the protocol maximum so exit sells are
  never blocked by a governance fee raise, start-age sizing for Setter ratify retries).

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
