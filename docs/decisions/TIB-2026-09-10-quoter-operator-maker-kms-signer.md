# TIB-2026-09-10: Quoter operator maker and delegated KMS signer

| Field          | Value                                            |
| -------------- | ------------------------------------------------ |
| **Status**     | Proposed                                         |
| **Date**       | 2026-09-10                                       |
| **Author**     | @hayden                                          |
| **Scope**      | Bot: quoter-bot                                  |
| **Supersedes** | TIB-2026-08-12-quoter-bot-kms-signing-middleware |

---

## Context

The quoter currently treats one account as three things: the Midnight maker that owns assets and
positions, the signer of Ecrecover offer trees, and the sender of publication and cancellation
transactions. The `aws` identity moved that account's private key into KMS, but it did not separate
capital custody from unattended bot authority. It also made the policy middleware responsible for
every maker transaction needed for setup, publication, ratification, and cleanup.

Operators instead want a funded wallet that remains out of band and a distinct KMS key for routine
offer activity. The operator wallet authorizes the KMS address to sign Ecrecover offers on its
behalf.

That authorization is not offer-scoped. The installed Midnight ABI exposes one
`isAuthorized[authorizer][authorized]` relation to every delegated entry point. An authorized EOA
can withdraw maker credit or collateral to an arbitrary receiver, change consumption, repay or
supply collateral, and authorize another address. The canonical Ecrecover ratifier accepts a tree
signature from the maker or any address for which that same relation is currently true. KMS custody
therefore does not make the delegated key safe to expose: `kms:Sign` signs an opaque digest and AWS
IAM cannot distinguish an offer digest from an arbitrary Ethereum transaction digest.

No custom ratifier or other custom on-chain contract will be introduced. The design must confine
the delegated authority off chain, acknowledge the remaining trust boundary, and retain an
operator-controlled on-chain kill switch.

This TIB replaces
[TIB-2026-08-12](./TIB-2026-08-12-quoter-bot-kms-signing-middleware.md). It retains that TIB's
sign-what-you-encode principle and hardened KMS signature handling, but drops the premise that the
KMS identity is itself the funded maker and consequently removes its setup-remediation, Setter,
maker-publication, and aggregate policy machinery.

## Goals / Non-Goals

**Goals**

- Keep the funded maker EOA and its private key entirely outside the bot and AWS.
- Make a fresh AWS KMS key the only unattended identity authorized to sign offers and cancel the
  resulting Ecrecover roots.
- Make the signing service the only principal allowed to call `kms:Sign`; the bot submits
  structured intents and never submits a hash, calldata, or transaction to sign.
- Publish offers with a separate, unprivileged, gas-only EOA that has no maker authorization.
- Reduce routine invalidation to irreversible cancellation of known Ecrecover roots.
- Fail closed on identity, authorization, policy, simulation, persistence, nonce, or RPC ambiguity.
- Preserve a tested operator path that invalidates every signature from the delegated signer at
  fill time.

**Non-Goals**

- A custom ratifier, wallet module, proxy, or other custom smart contract.
- Claiming that Midnight native authorization is offer-only or that KMS IAM understands the
  semantic content of a digest.
- Protecting against compromise of the signing Lambda's code, execution role, deployment role, or
  AWS account administration. Those components remain in the trusted computing base.
- Enforcing aggregate signed exposure, crossed-book policy, PnL, or a live reservation ledger in
  the signing service. Existing bot checks remain defense in depth.
- Automated funding, approvals, collateral operations, signer authorization, or signer
  deauthorization.
- Setter-ratifier support in this identity mode.

## Current Solution

- `MakerIdentity` selects one read-only, private-key, keystore, direct-AWS, or middleware identity.
  Every writable identity is expected to derive the configured maker address.
- The ladder and bootstrap adapters use that same account to sign offers, publish payloads, and
  call Midnight `setConsumed` for routine invalidation.
- Durable ladder ownership stores offer groups but not their Ecrecover root. The invalidation CLI
  and shutdown paths therefore operate in group units.
- `services/quoter-signer` validates structured quote, ratify, revoke, and setup-remediation
  intents, but its KMS attestation expects the KMS address to equal the maker. The bot's middleware
  write ports are not yet integrated and fail closed.
- Ecrecover publication is permissionless. The sender pays gas and emits the payload, but the
  embedded tree signature—not the transaction sender—authorizes the offers.

## Proposed Solution

### 1. Three identities with separate responsibilities

The deployment has three EOAs:

| Identity     | Custody                                      | Capital or protocol authority                                                                              | Runtime responsibility                                                                   |
| ------------ | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Maker        | Operator-managed, out of band                | Owns strategy assets, allowances, and Midnight positions; authorizes the canonical ratifier and KMS signer | None                                                                                     |
| Offer signer | Non-exportable AWS KMS `ECC_SECG_P256K1` key | Broadly authorized by the maker in Midnight                                                                | Sign validated offer trees and known-root cancellations through the signing service only |
| Publisher    | Replaceable bot secret/keystore              | Never authorized by the maker; no token allowances or protocol positions                                   | Simulate and submit exact zero-value Mempool publication payloads                        |

The maker MUST be a dedicated strategy EOA whose balance, allowances, positions, and collateral are
all approved risk capital. It MUST NOT be a treasury or an EOA used by another strategy. Funding it
later increases the amount exposed to the delegated authorization.

The operator performs these setup actions out of band:

1. fund the maker with only the approved strategy capital and native gas needed for operator
   recovery;
2. approve the required loan token to Midnight;
3. authorize the canonical Ecrecover ratifier in Midnight;
4. authorize the fresh KMS signer address in Midnight; and
5. fund the signer with only the bounded native-token cancellation reserve; and
6. fund the publisher with a bounded native-token balance.

The publisher is deliberately a third private key. This avoids putting permissionless publication
transactions on the broadly authorized KMS signer's nonce stream. Publisher compromise permits gas
loss, duplicate or stale publication, and downtime; it cannot create a new valid offer, cancel a
root, or act for the maker.

### 2. A reduced signing-service contract

The signing service exposes three versioned operations as three separate Lambda functions built
from one image. Each function has a dedicated execution role and one exact published-version alias
that pins its operation and deployment policy; the caller cannot choose the surface in its request.
The offer and cancellation roles may call `kms:Sign` and only their own DynamoDB operations. The
health role may call `kms:GetPublicKey` but not `kms:Sign`.

#### `sign-offer-tree`

The bot supplies a canonical, strictly parsed list of structured offers and an idempotency key. The
service supplies or independently resolves every trust-boundary value, reconstructs the exact SDK
tree, derives its EIP-712 digest, and calls KMS only after validation and durable admission.

The service validates at least these invariants:

- the deployment-pinned chain, Midnight singleton, Mempool, maker, KMS signer, and canonical
  Ecrecover ratifier;
- exactly one allowlisted market per tree, matching the current per-market ladder and singleton
  bootstrap publication units;
- the complete allowlisted market struct and its content-addressed market id, including loan token,
  ordered collaterals, maturity, RCF threshold, gates, and Midnight address;
- independently read tick spacing and continuous fee at one coherent block, derive
  `continuousFeeCap` exactly from that observed fee, and deny when it exceeds the deployment-pinned
  maximum;
- canonical offer ordering, tree construction, and group derivation;
- asset-denominated caps only: `maxUnits == 0` and `0 < maxAssets <= uint128.max`;
- buys use `reduceOnly == false`, zero `receiverIfMakerIsSeller`, zero callback, and empty callback
  data;
- sells use `reduceOnly == true`, `receiverIfMakerIsSeller == maker`, zero callback, and empty
  callback data;
- every tick falls inside the deployment-pinned strategy rate range and aligns to the observed tick
  spacing;
- each offer and the sum in one publication stay inside explicit deployment-pinned asset ceilings;
- the service, not the caller, sets `start` to the independently observed block timestamp and sets
  `expiry = min(market maturity, start + 1 hour)`; and
- the derived expiry retains at least 30 seconds for response delivery and publication, otherwise
  the request is denied before KMS.

These ceilings constrain one returned tree, not aggregate signed exposure. A compromised bot can
request many separately valid roots. The hard capital boundary is therefore the maker's live assets,
allowances, collateral, credit, and positions while delegation remains active.

The service MUST call `EcrecoverRatifierUtils.ratify` with the KMS-derived signer as `account` while
every offer retains the operator EOA as `offer.maker`. The installed SDK verifies the supplied
signature against `account`; passing the maker preserves the old equality assumption and rejects a
valid delegated signature.

The approval response contains the root, group ids, expiry, recovered signer, policy/config digest,
and exact encoded Mempool payload. It exposes neither a raw signing primitive nor a separately
caller-chosen digest. The signature is not treated as secret because it is embedded in the payload
and becomes public when published.

#### `cancel-known-root`

The request contains only an idempotency key and a root already recorded by `sign-offer-tree`. The
service independently encodes exactly
`EcrecoverRatifier.cancelRoot(MAKER_ADDRESS, root)` to the canonical ratifier with zero value. It
rejects unknown roots, arbitrary nonces, calldata, targets, values, batching, group consumption,
authorization changes, and every other transaction.

The service owns preparation, simulation, KMS signing, broadcast, receipt tracking, and bounded
same-action fee replacement. It returns root, nonce, transaction hash, and status, never raw signed
transaction bytes. The exact `{from: signer, to: ratifier, data, value: 0}` call MUST pass the shared
`@repo/bot-kit` simulation and default-deny policy seams immediately before KMS. Estimated gas and
both EIP-1559 fee fields MUST remain under deployment ceilings. A replacement uses the same root,
target, calldata, value, chain, and nonce, and `@repo/bot-kit`'s fee-bump rule compares against every
previously recorded artifact at that nonce.

Only one cancellation may be non-terminal for a signer. The service assigns no later nonce until
that cancellation is confirmed, reverted, or reconciled against
`EcrecoverRatifier.isRootCanceled(maker, root)`. This intentionally trades cancellation throughput
for a small and auditable nonce state machine.

Cancellation admission also atomically charges a deployment-pinned rolling 24-hour signed-gas
budget in DynamoDB before KMS. The charge uses the worst-case `gas * maxFeePerGas` for the original
and every permitted replacement, never the current base fee or eventual receipt cost. Exhausting
the routine budget halts new signing and requires the operator kill switch; it never borrows from
maker or publisher gas. The signer balance has explicit readiness floor and ceiling values, with the
floor sized for one cancellation and all permitted replacements. Third-party funding is possible,
so the balance ceiling limits operator capital and alarms on drift but is not claimed as a security
boundary; the signed-gas ledger remains authoritative.

#### `health`

The non-signing operation returns the KMS-derived address, KMS key fingerprint, published Lambda
version, image digest, policy/config digest, chain, maker, ratifier, and catalog availability. It
cannot dispatch a signing operation and its role has no `kms:Sign` permission.

There is no `ratify`, `consume-groups`, `setConsumed`, `self-cancel`, setup-remediation, approval,
authorization, withdrawal, collateral, transfer, arbitrary-transaction, message, or raw-digest
operation.

### 3. Durable root and cancellation state

One DynamoDB table is authoritative for idempotency, signed-root inventory, and the single active
cancellation nonce. Lambda process memory and RPC `pending` state are never authoritative across
instances or restarts.

For offer signing:

1. validate and canonically hash the request;
2. conditionally reserve `(maker, idempotencyKey)` with that hash and the derived root before KMS;
3. sign only that digest and verify recovery to the configured signer;
4. encode and durably store the exact returned artifact; and
5. only then return it.

Reusing an idempotency key with another canonical request is a conflict. Once an artifact is stored,
retries return it byte-for-byte without another KMS call. KMS ECDSA is nondeterministic, so a crash
after KMS but before artifact persistence cannot promise the same bytes. Because no response or
broadcast occurred, an expired in-flight lease may sign the identical digest again; it may never
change the digest, root, or economic action under that key.

Before its first Lambda invocation, the bot durably stores a pending signing request containing the
idempotency key, canonical structured request, and request hash. A response is accepted only when it
matches that record, after which the root, groups, expiry, and payload hash are attached atomically.
On startup, every pending signing request is retried with the same key and byte-identical request so
the service either returns its stored artifact or safely resumes the same digest. The bot may not
release, replace, or forget a pending request merely because the original response was lost. This
write-before-request and retry protocol is the recovery surface for signed roots hidden by a dropped
Lambda response; the service does not expose an unauthenticated root-listing API.

For root cancellation, an atomic record leases the independently reconciled nonce before KMS. The
signed bytes and hash are stored before broadcast. A crash or timeout after storage rebroadcasts the
stored bytes; an ambiguous broadcast freezes new cancellation signing until stored hashes, receipts,
and both latest and pending nonces reconcile. Every replacement hash remains in the record because
any of them can mine.

Signed-root records are append-only apart from monotonic state transitions such as `signed`,
`published`, `cancel-pending`, `canceled`, and `expired`. Expiry is terminal for offer validity but
does not make an outstanding transaction nonce terminal.

### 4. Bot integration and root ownership

Production configuration separates:

- `MAKER_ADDRESS`: the operator EOA placed in every offer;
- `QUOTER_SIGNER_ADDRESS`: the expected KMS-derived delegated signer;
- exact versioned Lambda aliases for offer signing, root cancellation, and health; and
- the gas-only publisher identity and bounded publisher transaction policy.

Direct private-key, keystore, and direct-AWS identities MUST NOT be accepted as production offer
signers. Local injected accounts may remain as test-only seams. Existing configuration that derives
the maker from signing credentials is replaced by independent maker, signer, and publisher
validation.

Ladder and bootstrap ownership records advance to a new schema that persists root, groups, expiry,
payload hash, and publication status together. One root owns every group in one publication. Routine
replacement, shutdown, hard halt, and CLI invalidation resolve owned groups to distinct roots and
cancel the roots. A command naming one group reports the complete affected root and sibling groups;
it never silently claims to cancel only that group.

Normal replacement order is:

1. prepare and persist the replacement publication;
2. cancel every superseded root through `cancel-known-root`;
3. wait for successful cancellation receipts;
4. revalidate the replacement payload; and
5. simulate and submit it from the publisher through `@repo/bot-kit`.

Failure or ambiguity in cancellation stops publication. The publisher never reconstructs the
payload. It submits the exact service-produced zero-value calldata to the pinned Mempool and applies
the existing simulation, transaction policy, pending queue, and receipt controls.

The cutover uses a fresh maker, so legacy group-only ownership files are not upgraded in place. All
legacy groups are invalidated and the old identity is quarantined before the new maker starts. Any
unexpected legacy state under the fresh maker fails readiness instead of being guessed into a root.

### 5. Readiness and AWS boundary

Readiness fails closed unless it proves:

- maker, signer, and publisher are three distinct EOAs;
- KMS public-key parsing and address recovery equal `QUOTER_SIGNER_ADDRESS`;
- the pinned chain, Midnight, Mempool, and Ecrecover ratifier addresses are correct, and the
  ratifier's immutable Midnight linkage matches the singleton;
- `Midnight.isAuthorized(maker, ratifier)` and `Midnight.isAuthorized(maker, signer)` are true;
- `Midnight.isAuthorized(maker, publisher)` is false;
- maker balances, allowances, positions, and collateral match the operator-approved deployment
  envelope;
- maker recovery gas, signer cancellation gas, and publisher operational gas meet explicit floors;
  signer and publisher balances remain under their operator-capital ceilings;
- the rolling signer cancellation-gas budget can fund one cancellation and all permitted
  replacements without exceeding its 24-hour limit;
- the root catalog and cancellation state are available and internally consistent; and
- health attests the exact expected Lambda versions, image, KMS key, and configuration.

Infrastructure tests assume the bot runtime role and make a real negative `kms:Sign` call that must
return `AccessDenied`. Static deployment checks also deny that role `iam:PassRole`, signer-role
assumption, KMS grant or policy mutation, and Lambda code, configuration, version, or alias mutation.
Invoke permission is limited to exact production aliases. AWS deployment and administration roles
remain trusted and are stated explicitly in the threat model.

### 6. Revocation and rotation

Routine quote replacement uses root cancellation. The operator retains the maker-wide kill switch.
During an incident:

1. deny the bot's Lambda invoke permissions and disable the KMS key;
2. use the out-of-band maker to submit and confirm
   `Midnight.setIsAuthorized(oldSigner, false, maker)`;
3. scan authorization events from the maker's creation block and revoke every unexpected delegate,
   because a compromised authorized signer may have delegated again;
4. cancel remaining known roots with maker-signed transactions as useful for permanent cleanup; and
5. if the Lambda, KMS authority, or AWS control plane may have been compromised, revoke the ratifier,
   zero allowances, withdraw or move idle capital, and reconcile all maker positions.

Live authorization is checked when an offer is taken, so confirmed signer deauthorization makes old
signatures fail even if a publisher later mines their payloads. Post-deauthorization cleanup MUST be
signed by the maker; the retired signer can no longer act on its behalf.

A retired signer address MUST never be reauthorized. Reauthorization could revive any unexpired,
uncanceled historical tree. Rotation always creates a fresh KMS key and signer address, verifies the
new deployment, authorizes it out of band, and only then admits new signing.

The old direct-KMS maker has stricter quarantine exit criteria because its former callers could ask
KMS to sign arbitrary digests and CloudTrail cannot reconstruct their contents. Before moving its
capital or enabling higher limits on the new maker, operators MUST:

1. remove direct bot and operator `kms:Sign` access and prove `AccessDenied` from every retired
   principal;
2. backfill the catalog and transaction inventory with every known live group, root, signed
   transaction, occupied nonce, and replacement hash;
3. cancel or consume every known offer, confirm or replace every pending transaction, revoke every
   ratifier and delegate, remove all token approvals, and reconcile every position and collateral;
4. wait for every known time-bounded offer, permit, authorization, or other signature class to
   expire before moving assets; and
5. permanently retire the old address after draining it: never restore approvals or authorizations,
   never reuse it as a strategy wallet, and never fund it again except for the minimum gas needed to
   finish quarantine.

The backfilled inventory is necessary for cleanup but is not proof that all historical blind
signatures are known. Permanent address retirement is the containment for an unknown signature with
no useful expiry or a presigned future nonce.

### Implementation Phases

- **Phase 1 — Protocol and failure proof:** pin the installed SDK/ABI and add fork tests proving
  delegated Ecrecover fills, live deauthorization, irreversible root cancellation, and the breadth
  of native authorization.
- **Phase 2 — Reduced signer service:** replace maker equality with separate maker/signer pins;
  reduce the intent union; add the root catalog, cancellation state machine, exact simulation, and
  service-owned broadcast.
- **Phase 3 — Bot identity and ownership:** add the publisher identity, integrate offer/root ports,
  persist publication roots, and replace group consumption with root cancellation across ladder,
  bootstrap, CLI, shutdown, and hard-halt paths.
- **Phase 4 — AWS and operational controls:** deploy version-pinned aliases and roles, negative IAM
  tests, readiness, metrics, alarms, and operator runbooks.
- **Phase 5 — Staged cutover:** invalidate and quarantine the legacy maker, start with fresh maker,
  signer, and publisher identities at low capital, then raise capital only after production evidence
  exercises quote, publish, cancel, rotation, and recovery.

## Considered Alternatives

### Direct bot access to the KMS key

The bot calls `kms:Sign` with offer or transaction digests.

**Why rejected:** KMS receives opaque digests. A compromised bot could use the broadly authorized
signer to create arbitrary Midnight transactions or further delegates.

### Use the KMS signer as publisher

The KMS key signs offers, Mempool publication transactions, and cancellations.

**Why rejected:** Mempool publication is permissionless, so the sender adds no authorization.
Putting every publication on the delegated signer's nonce stream expands transaction-signing code,
durable nonce state, gas exposure, and emergency replacement logic without containing a copied
payload.

### Keep group consumption

The KMS service signs `Midnight.setConsumed` and Midnight multicalls for selected groups.

**Why rejected:** root cancellation is the native, irreversible unit for Ecrecover trees and targets
only the canonical ratifier. Persisting roots lets the service remove general Midnight calldata and
batch parsing from its KMS transaction surface. Canceling sibling groups from the same publication
is an intentional, operator-visible consequence.

### Operator-only routine cancellation

Operators cancel roots manually or the bot waits for expiry before replacement.

**Why rejected:** it either requires continuous operator participation or creates quote gaps and
overlapping live roots. Automated, known-root cancellation is the smallest transaction authority
the KMS service needs.

### Custom offer-scoped ratifier

A new contract recognizes the KMS signer for offers without granting Midnight native authorization.

**Why rejected:** it provides the cleanest on-chain authority boundary, but custom ratifiers and
smart contracts are outside the accepted operational and audit boundary.

### Full economic policy middleware

Retain crossed-book, PnL, aggregate signed exposure, reservation accounting, setup remediation, and
all transaction intents from the superseded TIB.

**Why rejected:** separating the funded maker removes the need for most maker transaction intents,
and v1 explicitly accepts offer authority within a static envelope. The additional state and
availability machinery is deferred until its tighter economic bound is required.

## Assumptions & Constraints

- The operator maker is an EOA. Contract wallets and Setter ratification require a separate TIB.
- One single-market publication tree is a safe cancellation unit for ladder and bootstrap behavior;
  multi-market trees are rejected.
- Operators accept cancel-confirm-publish latency and the replaceable publisher credential.
- The KMS signer holds no ERC-20 balances, allowances, collateral, or positions. An attacker can
  fund its native gas, so lack of gas is never treated as a security boundary.
- The publisher can reveal or replay any payload it receives; cancellation and live authorization,
  not sender secrecy, contain that behavior.
- Lambda code, its execution/deployment roles, KMS policy administration, DynamoDB integrity, and
  the independently configured RPC are trusted.
- Missing, ambiguous, stale, or conflicting configuration and state always halt signing.

## Dependencies

- Installed `@morpho-org/midnight-sdk` offer/tree, payload, ABI, and Ecrecover helpers. Exact exports
  and signatures are checked rather than inferred.
- `@repo/bot-kit` simulation, transaction policy, fee-bump, signer, and pending-queue seams.
- AWS KMS `ECC_SECG_P256K1`, Lambda versioned aliases, IAM, and DynamoDB conditional writes.
- An independently operated RPC capable of coherent chain reads, simulation, raw transaction
  broadcast, and receipt/nonce reconciliation.

## Observability

Keep existing public log field names stable. Add stable events for intent admission/denial, root
signed/published/cancel-pending/canceled/expired, nonce reconciliation, stored-artifact replay,
publisher submission, identity drift, authorization drift, and IAM negative-test failure. Include
maker, signer, publisher, root, group count, intent kind, policy/config digest, nonce, transaction
hash, Lambda version, and KMS request id where applicable. Never log private keys, credentials, RPC
URLs, response bodies, raw signatures, or signed transaction bytes.

Alert on authorization drift, unexpected delegates, KMS calls outside the signing aliases, root or
nonce ambiguity, repeated policy denials, catalog unavailability, publisher gas outside bounds,
stale live roots, failed cancellation, and any successful `kms:Sign` attempt from the bot role.

## Security

This is a funds-at-risk change. Native Midnight delegation gives the KMS signer substantially more
on-chain authority than the service exposes. The policy service, its exact encoders, KMS/IAM
boundary, durable catalog, simulation, and operator response time are security controls, not merely
availability components.

Full bot-host compromise permits an attacker to request arbitrarily many statically valid offers,
publish or withhold returned payloads, cancel known roots, burn the publisher's bounded gas, and
deny service. It does not grant direct `kms:Sign`, arbitrary transaction encoding, or operator-key
access. Because there is no aggregate signed-exposure ledger, the defensible worst-case economic
bound is all value assigned to the dedicated maker while authorization is live, plus bounded signer
and publisher gas—not the per-publication ceiling.

Compromise of the signing Lambda, its execution/deployment role, or KMS administration can bypass
the off-chain intent boundary and exercise the signer's broad Midnight authority. The incident
runbook therefore treats secondary authorization as possible and removes capital rather than
claiming that signer deauthorization alone always contains such a compromise.

Implementation requires exact ABI/config review, pre-sign simulation, no signing or broadcast path
outside `@repo/bot-kit` seams, exhaustive no-KMS-call negative tests, fork coverage, and independent
review before merge.

## Future Considerations

A later TIB may add independently read crossed-book/PnL policy and a reservation ledger that bounds
aggregate signed but unexpired exposure. That work must define its availability and emergency
semantics before it can narrow the stated blast radius. A future audited offer-scoped ratifier could
remove the broad Midnight delegation risk, but it is not a dependency of this decision.

## References

- [Superseded KMS middleware TIB](./TIB-2026-08-12-quoter-bot-kms-signing-middleware.md)
- [Quoter-bot architecture TIB](./TIB-2026-07-27-midnight-quoter-bot.md)
- [Quoter-signer dependency manifest](../../services/quoter-signer/package.json)
- [Vendored Midnight contract context](../context/repos/midnight-contracts.txt)
- [AWS KMS `Sign` API](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html)
