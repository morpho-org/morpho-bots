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

Every existing guard is **in-process** and dies with a compromised process: the bot-kit signer's
default-deny policy check, the offer invariants, and the serialized `MakeService` with its
`NEGATIVE_SPREAD` prospective-book guard
([TIB-2026-07-27](./TIB-2026-07-27-midnight-quoter-bot.md), §7 and §Security).

[TIB-2026-07-27](./TIB-2026-07-27-midnight-quoter-bot.md) gates any material capital increase on a
V1 security phase: treasury multisig; delegated funding contract; custom on-chain quoter ratifier;
AWS KMS or equivalent key custody. KMS custody has since shipped. This TIB addresses the remaining
**authorization gap** of that custody and is a step in the V1 track. The current hot-key cap is
20,000 USDC per market.

## Goals / Non-Goals

**Goals**

- Make the signing middleware the **only principal** allowed to call `kms:Sign` on the maker key.
  The bot loses direct KMS access entirely; its AWS role is reduced to invoking the middleware.
- Replace blind digest signing with **structured intents** (revoke, quote) that the middleware
  validates against policy it owns — bounds and pins from its own deployment parameters, book and
  position state from its own independent reads. Nothing policy-relevant comes from the request.
- **Sign-what-you-encode**: the middleware canonically encodes each validated intent and derives
  the digest internally. The bot never supplies bytes or hashes to be signed.
- Bound the blast radius of full bot-host compromise to a **quantifiable worst-case loss**:
  signatures over in-policy offers (≈ worst in-policy rate × capped exposure) plus revocations
  (downtime/griefing, no fund loss). No EOA drain, no arbitrary permit.
- Keep revocation the **always-available kill switch**: near-unconditionally approved and the most
  available operation the middleware offers.
- Fail closed: quoting halts when middleware invocation fails or an intent is denied.
- Keep the architecture **reproducible by third-party operators** of the public reference bot: the
  middleware's code ships in this repo and deploys from a standard container image, and `aws`
  custody already presumes an AWS account.

**Non-Goals**

- Replacing the in-bot invariants (offer policy, `NEGATIVE_SPREAD`, signer policy guard). They
  remain as fast-feedback defense in depth; the middleware is the first control that survives full
  bot-host compromise.
- Treasury custody or the delegated funding contract with fund/cap/block controls. Separate V1
  item.
- The custom on-chain quoter ratifier. Complementary track, not replaced by this TIB (see
  Alternative 3).
- Generalizing to other bots or keys in v0. The design should not preclude it, but v0 serves one
  bot and one maker key.
- Changing KMS/HSM procurement. The existing `ECC_SECG_P256K1` KMS key stays where it is.

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
  trees** published off-chain to the Mempool, and **on-chain transactions** — offer group/root
  invalidation, plus `setIsRootRatified` root approval where the Setter ratifier is used.
- In-process guards: [`packages/bot-kit/src/signer.ts`](../../packages/bot-kit/src/signer.ts) runs
  `evaluatePolicy` (default-deny: chain, target, selector, value, gas/fee ceilings) between
  prepare and broadcast and logs `signer.policy_violation`; the offer invariants and serialized
  `MakeService` are documented in [TIB-2026-07-27](./TIB-2026-07-27-midnight-quoter-bot.md).
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
│  · revoke intents        │ ──────► │    bounds, PnL, field-level checks    │ dgst │ ECC_SECG_ │
│  · quote intents         │ (SigV4) │ 2. canonically encode (EIP-712 / tx)  │ ───► │ P256K1    │
│                          │ ◄────── │ 3. derive digest, call kms:Sign       │ ◄─── │ sign-only │
│ no kms:Sign — only       │  sig +  │ 4. return signature + encoded payload │  sig │           │
│ lambda:InvokeFunction    │ payload └──────────────────┬────────────────────┘      └───────────┘
└──────────────────────────┘                            │ independent live reads
                                                        ▼
                                     RPC + Morpho API/Mempool (never bot-supplied state)
```

### 1. Structured intents replace digests

The wire contract is a **versioned JSON intent** carried as the payload of an AWS SDK
`lambda:InvokeFunction` call. The bot submits one of two intent types; the middleware returns the
signature together with the derived root/tx payload it encoded, so the bot publishes exactly what
was validated.

**Revoke intents** invalidate offer groups/roots. They are **near-unconditionally approved** —
revocation only reduces exposure and is the always-available kill switch — constrained to: pinned
chain id, `to` = the Midnight singleton, an invalidation-selector allowlist, zero native value,
and fee/gas ceilings. This mirrors the constraint set the in-process signer guard already pins,
now enforced outside the bot.

**Quote intents** carry an array of structured offers. The set is approved only when **three
properties** all hold:

1. **No crossed books.** The prospective offer set, evaluated together with the maker's
   already-live offers, must not create a negative spread across books — the same whole-book
   invariant `MakeService` enforces in-process today, now enforced independently at the signing
   boundary. Critically, the middleware does **not** trust bot-supplied book state for this check
   — a compromised bot would lie. It reads live offers and chain state itself, through its own
   RPC and Morpho API/Mempool reads.
2. **Price bounds.** Every offer's price/rate must remain inside boundaries encoded as parameters
   of the middleware's own deployment configuration — never supplied per-request.
3. **No PnL drop.** Publishing the offers must not degrade the maker address's PnL: offer prices
   must remain sustainable, i.e. a fill at the offered price must not realize a loss against the
   maker's position/cost basis. The exact PnL/cost-basis model and the independent data it needs
   are open questions; the property itself is a decided policy requirement.

Beneath these three headline properties, **field-level validation** on every offer: market
allowlist; per-market and total exposure caps; expiry ≤ market maturity and bounded duration;
exact maker/receiver/callback/ratifier fields; owned group namespace; and cap semantics (exactly
one of `maxUnits`/`maxAssets` non-zero).

Policy parameters live in the middleware's deployment, never in the request; the state feeding
its checks comes from its own reads, never from the caller. A compromised bot can neither relax
the policy nor lie to it.

### 2. Sign-what-you-encode

The middleware itself canonically encodes each validated intent — EIP-712 offer-tree hashing for
Ecrecover ratifier offers, transaction serialization for invalidations — and derives the digest
internally. The bot never supplies bytes or hashes to be signed, so **there is no
decode/re-encode ambiguity to attack**: nothing needs to parse an attacker-supplied encoding and
hope the parse matches what the chain or the ratifier will see. What was validated is what is
signed, by construction.

### 3. Bot-side seam: intent ports, not a drop-in account

The viem `LocalAccount.sign(hash)` blind-digest surface is exactly what is being removed, so the
middleware is deliberately **not** a drop-in `LocalAccount` replacement. The bot-side seam is
intent-level ports — an offer-signing port and an invalidation-signing port — backed by
Lambda-invoking adapters, selected as a new identity method alongside
`private-key`/`keystore`/`aws` in
[`signer-identity.utils.ts`](../../bots/quoter-bot/src/config/signer-identity.utils.ts). Any
residual generic digest-signing path fails closed.

### 4. Deployment shape: an AWS Lambda behind IAM

- The middleware is an **AWS Lambda function**, invoked by the bot through the AWS SDK
  (`lambda:InvokeFunction`).
- **IAM chain**: the bot's AWS credentials attach to a role whose only permission is
  `lambda:InvokeFunction` on this one function ARN — the bot loses `kms:Sign` entirely. The
  Lambda's execution role is the only principal with `kms:Sign` on the maker key, plus the
  outbound reads its checks need. Creating that execution role and the invoke-only credentials is
  part of the deliverable.
- Authentication is therefore **IAM/SigV4** — no self-managed ingress, tokens, or mTLS.
  Correctness still does not depend on caller identity: any invoker only obtains in-policy
  signatures. Invoke-only scoping exists to prevent revoke-griefing/DoS and to keep the audit
  trail attributable — CloudTrail records both the `Invoke` and the `Sign`.
- The Lambda's **code lives in this monorepo** and deploys as a **Docker container image**
  (ECR-hosted Lambda container image) with its own Dockerfile, like the bots. It is not a bot —
  not a long-running program — so it does not live under `/bots/`; the proposed workspace home is
  a new top-level `services/` directory, e.g. `services/quoter-signer`. Final naming and location
  are settled at implementation (open question 1).
- Flow: the bot builds the desired offer array → invokes the Lambda with the structured intent →
  the Lambda validates the three properties plus field checks, canonically encodes, derives the
  digest, calls KMS → returns the signature and encoded payload. Sign-what-you-encode is
  unchanged by the deployment shape.

### 5. Availability posture

- Lambda and KMS are both **AWS-managed**, which improves the liveness story over a self-hosted
  proxy. The middleware remains a liveness dependency: quoting fails closed when invocation
  fails; the bot halts publication and retries rather than degrading to any local signing path.
- The **revoke path must be the most available operation** — it is the safety action under
  incident conditions.
- **Break-glass revoke is just another IAM principal** granted `lambda:InvokeFunction`: an
  operator can invoke the revoke intent directly with their own credentials, with no bot in the
  path.

### 6. Statefulness

The Lambda is **stateless per invocation**. Its per-invocation checks are computations over chain
truth read at invocation time — the crossed-book and PnL properties already require those
independent reads. Cross-invocation aggregates (e.g. total live signed exposure across successive
quote intents) need either external state or per-invocation chain-truth reads; which of those v0
adopts is open question 6.

### 7. Failure posture

| Failure                                   | Required behavior                                    |
| ----------------------------------------- | ---------------------------------------------------- |
| Invocation fails (throttle, error, limit) | Halt quoting (fail closed) and retry; offers stand   |
| Cold start latency                        | Tolerated; the hourly-ish cadence absorbs it         |
| Quote intent denied                       | Typed rejection, nothing signed; alert if persistent |
| Revoke intent denied                      | Near-impossible by design; treat as misconfig, alert |
| Independent state read fails (RPC/API)    | Fail closed: typed retryable denial, no signature    |
| KMS error                                 | Typed failure; never assume a signature was produced |
| Policy parameters missing/invalid at init | Refuse to serve; never run a partial or empty policy |
| Unknown intent type/version               | Reject; no best-effort interpretation of payloads    |

## Considered Alternatives

### Alternative 1: Status quo — in-process policy plus direct KMS

Keep the bot-kit signer policy, offer invariants, and `MakeService` guards, with the bot calling
KMS directly.

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
delegated funding contract. The middleware ships sooner, covers both signed payload classes, and
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

- IAM can express the intended split: the bot's role holds `lambda:InvokeFunction` on exactly one
  function ARN and nothing else; the Lambda's execution role is the sole `kms:Sign` principal on
  the maker key; break-glass operators hold their own invoke grants.
- Both signed payload classes are fully describable as structured intents and canonically
  encodable inside the Lambda (SDK EIP-712 offer-tree hashing; viem transaction serialization).
- The policy surface splits cleanly: price bounds and field pins are **deployment parameters**;
  the crossed-book and no-PnL-drop properties are evaluated against the Lambda's **own
  independent reads** (RPC and Morpho API/Mempool). The Lambda has network egress to those
  sources, and a failed read fails closed.
- One invocation round trip per make/revoke job — including cold starts — is compatible with the
  hourly-ish quote cadence and the one-minute bootstrap monitor.
- The Lambda is meaningfully harder to compromise than the bot host — minimal code and
  dependencies, an AWS-managed runtime, no ingress, no strategy complexity. That asymmetry is the
  premise of moving the root of trust.
- v0 serves one bot and one maker key; the wire contract is versioned so this can widen later.

## Dependencies

- AWS KMS `Sign`/`GetPublicKey` on the existing `ECC_SECG_P256K1` maker key
  ([AWS KMS Sign API](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html)).
- AWS Lambda (container-image function) and ECR for the image, plus IAM for the invoke-only and
  execution role chain
  ([Lambda container images](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)).
- The Lambda's independent read surfaces: an RPC endpoint and the Morpho API/Mempool for live
  offers, positions, and chain state.
- `@morpho-org/midnight-sdk` offer-tree EIP-712 hashing for canonical encoding inside the Lambda.
- viem for transaction serialization and signature parsing/verification in the Lambda.
- [TIB-2026-07-27](./TIB-2026-07-27-midnight-quoter-bot.md) for the V1 security gate this TIB
  advances.

## Observability

- The Lambda emits the same JSON-lines structured logging the bots use (to CloudWatch Logs).
  Every intent produces a decision event with intent type, evaluated properties and constraints,
  the violated check on denial, derived digest, and KMS outcome: `middleware.intent_received`,
  `middleware.intent_approved`, `middleware.intent_denied`, `middleware.kms_error`,
  `middleware.read_failed`.
- This log is an **authorization audit trail that survives bot-host compromise** — the bot cannot
  erase or forge it.
- CloudTrail covers the full chain: `lambda:InvokeFunction` attributes every caller (bot vs
  break-glass principals), and `kms:Sign` has exactly one allowed principal, so the KMS call
  stream must match the Lambda's approval log one-to-one. Divergence is an incident signal.
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
  oversized exposure, over-long expiry, foreign receiver/callback/ratifier, foreign group
  namespace, malformed cap semantics.
- Lying about book state — the crossed-book and PnL properties are evaluated against the Lambda's
  own reads, so a compromised bot cannot feed it a fabricated view.

**What it does not stop:**

- **Compromise of the Lambda's code or deployment pipeline** — the new, deliberately minimal root
  of trust. Mitigated by a small codebase, minimal dependencies, an AWS-managed runtime with no
  ingress, and separate roles; Nitro-attested signing is a recorded future hardening.
- **Policy bugs** — a wrong parameter or check approves what it should not. The policy is small
  and exhaustively testable, but it is code.
- **Economically bad but in-policy quoting** — the residual, deliberately accepted exposure:
  worst case ≈ worst in-policy rate × capped exposure. Bounded and quantifiable.
- **Misbehavior of the providers behind the Lambda's own reads** — a lying or censoring RPC/API
  could wave through a crossed or unsustainable set, or block valid ones. This extends the
  provider-trust posture of [TIB-2026-07-27](./TIB-2026-07-27-midnight-quoter-bot.md) to the
  middleware; the disagreement posture is open question 7.
- **DoS via invocation throttling or concurrency exhaustion** — quoting downtime; resting offers
  stand until expiry or revocation through a break-glass invoker.

Attacker-obtainable revocations are downtime/griefing, not fund loss — and invoke-only IAM
scoping exists precisely to make that griefing hard.

**Bounded-loss framing.** Today, bot-host compromise means unbounded loss of everything the maker
EOA holds or has approved. With the middleware, it means a bounded, pre-computable number derived
from the policy's price bounds and exposure caps. That conversion — unbounded key authority into a
quantifiable worst case — is a prerequisite for lifting the 20,000 USDC per-market cap under the
[TIB-2026-07-27](./TIB-2026-07-27-midnight-quoter-bot.md) V1 gate, alongside the treasury and
on-chain-ratifier tracks.

Policy parameters change through the Lambda's own deployment/review path, unreachable from the
bot. The bot host holds only invoke-scoped AWS credentials — no `kms:Sign`, no policy access.

## Testing and Verification

- **Policy:** exhaustive accept/reject vectors for the three properties and every field check on
  both intent types, including boundary values — price exactly at a bound, expiry exactly at
  maturity, both/neither of `maxUnits`/`maxAssets` set, off-by-one exposure caps, a prospective
  set that crosses only in combination with live offers.
- **Adversarial state:** intents accompanied by caller-supplied book or position state that
  contradicts chain truth — the Lambda must ignore the caller's view entirely and decide from its
  own reads.
- **Encoding equivalence:** the Lambda-derived EIP-712 digest for a validated offer tree matches
  SDK/bot-side hashing for identical structured input; transaction serialization matches viem's
  for identical fields.
- **Signature correctness:** recovered signer equals the configured maker across both recovery
  parities, reusing the existing strict DER/low-s/recovery-check discipline.
- **Fail-closed negatives:** generic digest-signing requests are rejected; unknown intent
  versions are rejected; an independent-read failure produces a typed denial and no KMS call; a
  missing or invalid policy configuration refuses to serve.
- **Integration:** bot plus deployed Lambda against a KMS test key — quote publish, revoke,
  denial propagation into `make.rejected`, the invocation-failure halt, and a break-glass revoke
  invoked by a second IAM principal.
- **IAM cutover proof:** demonstrate the bot's principal receives `AccessDenied` on `kms:Sign`
  after the grant moves, and that its role can invoke nothing but the one function ARN. A denied
  call is part of acceptance, not an incident.
- Tests follow the repository verification rule: run each new test, break one assertion to
  confirm it fails, restore it.

## Future Considerations

- Nitro-Enclave attestation binding the KMS key policy to attested signing code (Alternative 7)
  as host hardening.
- Generalizing to other bots and keys — multi-tenant policy keyed by principal and key.
- Gating Setter-ratifier root approvals and setup-remediation transactions if they move from
  manual operator actions to automated flows (open question 4).
- When the on-chain bounded ratifier lands, its bounds and the middleware's price policy should
  agree; the middleware remains necessary for the transaction surface.
- External state for aggregate exposure accounting if v0 ships with per-invocation chain-truth
  checks alone (open question 6).

## Open Questions

1. Workspace directory and package naming for the Lambda — proposed `services/quoter-signer`
   under a new top-level `services/` directory; settled at implementation.
2. Whether validation logic is shared with bot domain code (one bug affects both — `@repo/offers`
   is the natural shared home for the crossed-book model) or independently implemented (drift
   risk) — likely a shared schema, independently pinned middleware deployments.
3. The exact PnL/cost-basis model the Lambda evaluates for the no-PnL-drop property, and the
   independent data sources it needs.
4. Whether Setter-ratifier root approvals and setup-remediation transactions (approvals) are also
   gated through the middleware or stay manual operator actions.
5. Policy parameter change/approval workflow — who reviews, how it deploys, how changes are
   audited.
6. Exposure accounting across successive quote intents: stateless per-invocation checks over
   chain truth with bounded offer lifetimes, or external state tracking aggregate live signed
   exposure. The bounded-loss claim is strongest with aggregate enforcement.
7. Lambda networking/egress design for its independent RPC and Morpho API/Mempool reads — and the
   decision posture when those providers disagree with the bot's view of the book.

## References

- [TIB-2026-07-27: Midnight ladder quoter-bot — v0](./TIB-2026-07-27-midnight-quoter-bot.md)
- [`maker-account.utils.ts`](../../bots/quoter-bot/src/infrastructure/make/maker-account.utils.ts)
  — KMS-backed viem `LocalAccount`
- [`signer-identity.utils.ts`](../../bots/quoter-bot/src/config/signer-identity.utils.ts) —
  signer identity selection
- [`packages/bot-kit/src/signer.ts`](../../packages/bot-kit/src/signer.ts) — in-process
  default-deny signer policy
- [quoter-bot README](../../bots/quoter-bot/README.md) — signed payload classes and `aws`-mode
  deployment
- [Documentation guidance](../GUIDANCE.md)
- [Repository conventions](../CONVENTIONS.md)
- [AWS KMS Sign API](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html)
- [AWS Lambda container images](https://docs.aws.amazon.com/lambda/latest/dg/images-create.html)

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
