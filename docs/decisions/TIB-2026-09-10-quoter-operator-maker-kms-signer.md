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

The quoter currently uses one account as both the funded Midnight maker and the bot signer. AWS KMS
protects that account's private key from export, but operators still have to configure and fund an
automated account that holds the strategy's positions.

We want two accounts instead:

- an operator-managed maker EOA that owns the assets and Midnight positions; and
- an AWS KMS EOA used directly by the bot to sign offers and send transactions for the maker.

Midnight authorization is broad. An authorized EOA can act for the maker across Midnight, including
withdrawing positions and authorizing other addresses; it is not an offer-only permission. This TIB
accepts that authority and direct bot access to `kms:Sign`. The split removes generic Ethereum
signature authority over the operator maker, but it does not reduce the Midnight capital exposed to
a compromised bot.

This supersedes
[TIB-2026-08-12](./TIB-2026-08-12-quoter-bot-kms-signing-middleware.md), which introduced a Lambda
policy service to constrain KMS signing.

## Goals / Non-Goals

**Goals**

- Keep the funded maker key out of the bot and AWS.
- Let operators fund and manage the maker independently of the bot signer.
- Keep KMS signing in process and non-exportable while routing writes through `@repo/bot-kit`.
- Make the smallest change to the current quoter configuration and runtime.

**Non-Goals**

- Restricting the KMS signer to offer-only authority.
- Containing a fully compromised bot process.
- A signing Lambda, DynamoDB state, custom ratifier, smart-contract wallet module, or separate
  publisher key.
- Changing offer policy, publication semantics, or group cancellation semantics.

## Proposed Solution

### Identities

The deployment has two EOAs:

| Identity | Custody                          | Responsibility                                                                                 |
| -------- | -------------------------------- | ---------------------------------------------------------------------------------------------- |
| Maker    | Operator-managed and out of band | Holds strategy assets and positions, approves Midnight, and authorizes the ratifier and signer |
| Signer   | AWS KMS `ECC_SECG_P256K1`        | Directly signs offers and every bot transaction, including publication and cancellation        |

The maker MUST be dedicated to one quoter deployment. The signer holds only the native token needed
for gas, but its Midnight authorization is intentionally unrestricted. Lack of signer gas is not a
security boundary because anyone can fund an EOA.

Operators set up the deployment out of band by funding the maker, approving Midnight, authorizing
the canonical ratifier, authorizing the KMS signer, and funding both accounts with their required gas
reserves. The bot never loads or signs with the maker key.

### Configuration and runtime

`MAKER_ADDRESS` remains the maker placed in every offer and the `onBehalf` account for Midnight
transactions. In `aws` mode, `AWS_KMS_KEY_ID` and `AWS_REGION` identify a distinct signer; the signer
address is derived from `GetPublicKey` and does not need another configuration value.

The bot runtime may call `kms:GetPublicKey` and `kms:Sign` only on the configured key. It receives no
KMS key-policy, grant, alias, enable/disable, scheduling, or deletion permissions.

The existing KMS account keeps strict SPKI and DER parsing, low-s normalization, and signature
recovery. It stops requiring the derived address to equal `MAKER_ADDRESS`. Private-key and keystore
modes keep their current maker-equality requirement.

For Ecrecover, the KMS account is passed to `EcrecoverRatifierUtils.ratify` as the signing `account`,
while each offer keeps `offer.maker = MAKER_ADDRESS`. For Setter, the KMS account sends
`setIsRootRatified(MAKER_ADDRESS, root, true)`. The KMS account is also the wallet-client sender for
Mempool publication and current `setConsumed(..., onBehalf = MAKER_ADDRESS)` group cancellation.

Protocol transaction shapes, ownership persistence, and offer invariants remain unchanged. All
bootstrap, ladder, single-invalidation, and batch-invalidation writes move through `@repo/bot-kit`'s
signing policy, simulation, pending queue, and fee-replacement seams. Their identity assertions are
split: embedded offer makers, `onBehalf` values, and Setter accounts must equal `MAKER_ADDRESS`;
recovered offer signatures and transaction senders must equal the KMS signer.

The `middleware` key-storage mode and `services/quoter-signer` are removed once this TIB is accepted;
they implement the superseded design and have no production caller.

### Readiness and operation

Setup readiness fails unless:

- the KMS public key is valid and its recovered address differs from the maker;
- the maker has authorized both the configured ratifier and KMS signer in Midnight;
- the maker has the required assets, allowances, and position configuration; and
- the maker retains an emergency native-token reserve and the signer has enough native token for the
  existing transaction policy.

Normal signing, publication, invalidation, shutdown cleanup, and fee replacement remain in process
through `@repo/bot-kit`. There is no remote signing protocol or additional durable state.

For rotation, operators stop the bot, disable the old KMS key, deauthorize the old signer, create and
authorize a fresh KMS signer, update `AWS_KMS_KEY_ID`, and restart only after readiness passes. A
retired signer is never reauthorized because old signed offers or transactions may still be valid.

During a suspected bot or KMS compromise, operators disable the KMS key and use the maker to revoke
the signer and any unexpected delegates, then reconcile positions, allowances, offers, and pending
transactions before the deployment is restarted.

## Security

The KMS signer has full Midnight authorization for the maker, and the bot has direct access to that
key's signing API. A compromised bot can therefore sign arbitrary transactions from the signer,
withdraw or alter the maker's Midnight positions, create additional delegates, publish arbitrary
offers, and burn signer gas. The risk boundary is all capital and positions assigned to the maker
while the authorization is active.

The KMS key still prevents private-key export and separates automated authority from the funded EOA.
It does not constrain what a principal with `kms:Sign` can authorize. In-process assertions are bug
guards, not a security boundary against process compromise.

## Implementation

1. Split maker identity from signing identity in `aws` mode and update KMS account construction,
   offer ratification, wallet clients, and setup checks. Move bootstrap, ladder, single invalidation,
   and batch invalidation through `@repo/bot-kit` and split their maker/signer assertions.
2. Add unit and fork coverage for a signer distinct from the maker, including delegated Ecrecover
   and Setter fills, publication, group cancellation, missing authorization, and signer rotation.
3. Remove the middleware configuration/CLI surface, unsupported intent ports, and
   `services/quoter-signer` package.
4. Before cutover, use the old KMS maker to cancel known offers, reconcile pending transactions,
   remove approvals and delegates, unwind positions, and drain assets. Remove its `kms:Sign` access
   only after cleanup, then permanently retire the address because unknown blind signatures cannot
   be ruled out. Start the fresh maker and signer with limited capital and verify deauthorization
   before raising limits.

## Considered Alternatives

### Signing middleware

A Lambda validates structured intents before calling KMS.

**Why rejected:** the team accepts full Midnight authorization and direct bot access to KMS, so the
additional service, IAM surfaces, state, and failure modes do not enforce an intended boundary.

### Separate publisher

An unprivileged third EOA publishes Mempool payloads.

**Why rejected:** publication can continue from the KMS signer through the existing wallet and nonce
path. A third credential complicates configuration without changing the accepted signer authority.

### Custom ratifier

A contract grants the KMS key offer-only authority.

**Why rejected:** custom smart contracts and ratifiers are outside the accepted scope.

## References

- [Superseded KMS middleware TIB](./TIB-2026-08-12-quoter-bot-kms-signing-middleware.md)
- [Quoter-bot architecture TIB](./TIB-2026-07-27-midnight-quoter-bot.md)
- [AWS KMS `Sign` API](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html)
