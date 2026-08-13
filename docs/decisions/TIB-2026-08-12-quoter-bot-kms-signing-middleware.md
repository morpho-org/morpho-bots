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
- Replace blind digest signing with **structured intents** (revoke, quote, ratify) that the middleware
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
  trees**, and **on-chain transactions** — publication itself is one:
  [`production-ladder.ts`](../../bots/quoter-bot/src/infrastructure/ladder/production-ladder.ts)
  sends the SDK-encoded offer payload as a zero-value transaction to the Midnight Mempool
  contract, alongside offer group/root invalidation and `setIsRootRatified` root approval where
  the Setter ratifier is used.
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
`lambda:InvokeFunction` call. The bot submits one of three intent types; the middleware returns
the signatures together with the exact payloads it encoded, so the bot broadcasts exactly what
was validated.

**Revoke intents** invalidate offer groups/roots. They are **near-unconditionally approved** —
revocation only reduces exposure and is the always-available kill switch — constrained to: pinned
chain id, `to` = the Midnight singleton, an invalidation-selector allowlist, zero native value,
and fee/gas ceilings. This mirrors the constraint set the in-process signer guard already pins,
now enforced outside the bot.

Because a signed transaction commits to an account nonce, transaction-signing intents carry
**caller-supplied nonce and fee fields** — liveness parameters, not policy: no nonce value can
move funds, only strand or replace a transaction. The single-writer rule is unchanged from today:
the bot's serialized make/pending queue owns the nonce cursor in routine operation, and a
break-glass revocation deliberately takes over the account's transaction stream during an
incident — concurrent same-nonce signatures resolve on-chain as fee-bump replacements, and the
safety revocation is the one that must win.

Per-transaction fee/gas ceilings alone cannot stop a leaked invoker from bleeding the maker's
native balance one valid cancellation at a time. Transaction-signing intents therefore also draw
on **rolling signed-gas budgets** tracked in the reservation ledger (see Statefulness), and the
budgets are **partitioned by invoke surface**: publication and ratification draw on a routine
budget, while the revoke surface holds its **own protected reserve** — sized for several
full-book cleanups — that routine signing can never draw down, so a compromised bot exhausting
the routine budget cannot starve the kill switch. When the ledger is unavailable, quote/ratify
fail closed while revoke signing continues **uncharged but bounded**: per-transaction ceilings
still apply and the revoke surface is infrastructure-throttled (reserved concurrency), so
worst-case outage spend is rate-limited and the outage itself alerts. The final backstop is that
the maker EOA deliberately holds only a small operational native balance (the existing
`NATIVE_RESERVE_WEI` posture): gas grief can never exceed what is funded. Native-gas spend is
thereby capped and enters the bounded-loss arithmetic.

**Quote intents** carry an array of structured offers. There are **no caller-declared
exclusions**: the prospective book is always the observed live book plus the proposed set,
because a promised-but-unobserved invalidation is worth nothing at the signing boundary — a
signed publication is broadcastable regardless of what the caller claimed it would revoke
first. A replacement therefore sequences exactly as the in-process `MakeService` already does:
request the revoke signature, broadcast it, wait until the middleware's snapshot shows the old
groups gone, then request the quote signature against the now-clean book. A replacement whose
transitional old-plus-new book stays fully in-policy may skip the wait and revoke after
publication. An approved quote intent returns both signed artifacts the publication flow needs:
the EIP-712 tree signature (Ecrecover) and the signed zero-value publication transaction to the
Midnight Mempool contract, whose calldata the middleware itself encoded from the validated set.
The set is approved only when **three properties** all hold:

1. **No crossed books.** The prospective offer set — observed live offers plus the proposed
   set, with no exclusions — must not create a negative spread across books: the same whole-book
   invariant `MakeService` enforces in-process today, now enforced independently at the signing
   boundary. Critically, the middleware does **not** trust bot-supplied book state for this check
   — a compromised bot would lie. It reads live offers and chain state itself, through its own
   RPC and Morpho API/Mempool reads, and every policy read for one intent is pinned to **one
   deterministic snapshot** — a single block tag, with API responses carrying consistent
   indexed-block metadata. If a coherent snapshot cannot be assembled, the intent fails closed.
2. **Price bounds.** Every offer's price/rate must remain inside boundaries encoded as parameters
   of the middleware's own deployment configuration — never supplied per-request.
3. **No PnL drop.** Publishing the offers must not degrade the maker address's PnL: offer prices
   must remain sustainable, i.e. a fill at the offered price must not realize a loss against the
   maker's position/cost basis. The exact PnL/cost-basis model and the independent data it needs
   are open questions; the property itself is a decided policy requirement.

Beneath these three headline properties, **field-level validation** on every offer: market
allowlist; per-market and total exposure caps, enforced against **aggregate signed exposure** —
the proposed set, the maker's already-live offers from the middleware's own reads, and every
still-outstanding signed-but-unpublished reservation (see Statefulness), never per-intent
amounts alone; expiry ≤ market maturity and inside a **freshness ceiling** — a policy parameter
capping offer lifetime from signing time, so a stockpiled signature dies quickly; offer start
not meaningfully before signing time; exact maker/receiver/callback/ratifier fields; owned
group namespace; and cap semantics (exactly one of `maxUnits`/`maxAssets` non-zero).

**Ratify intents** exist for Setter-ratifier deployments, whose ladder flow must send
`setIsRootRatified` before a quote tree becomes takeable. A ratify intent carries the same
structured offer set as a quote intent; the middleware re-validates it in full, re-derives the
root itself, and signs only the `setIsRootRatified(maker, root, true)` transaction for that
derived root — under the same chain/target/value/fee pins as revocations. The middleware never
needs to remember which roots it produced: it recomputes them. Because a ratification enables
publication, ratify is a **quote-enabling intent** and is authorized like quote, never granted
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
intent-level ports — a quote-publication port (signed tree plus signed publication transaction),
an invalidation-signing port, and a root-ratification port for Setter deployments — backed by
middleware-invoking adapters, selected as a new identity method alongside
`private-key`/`keystore`/`aws` in
[`signer-identity.utils.ts`](../../bots/quoter-bot/src/config/signer-identity.utils.ts). Any
residual generic digest-signing path fails closed.

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

- The middleware is an **AWS Lambda function**, invoked by the bot through the AWS SDK
  (`lambda:InvokeFunction`).
- **IAM chain**: the bot's AWS credentials attach to a role whose only permissions are
  `lambda:InvokeFunction` on this function's intent surfaces — the bot loses `kms:Sign` entirely.
  The Lambda's execution role is the only principal with `kms:Sign` on the maker key, plus the
  outbound reads its checks need. Creating that execution role, the invoke-only credentials, and
  the CloudTrail data-event selector for the function (see Observability) is part of the
  deliverable.
- **Caller-to-intent scoping**: principals are authorized per intent type, not merely per
  function. Each of the three intents is its **own invoke surface** — separate qualified ARNs
  (per-alias or per-function) for quote, ratify, and revoke — so IAM grants scope each principal
  to the intent types it may submit, and the handler independently enforces the scope it was
  invoked under. Ratify is quote-enabling and is granted like quote. Break-glass principals
  receive the revoke surface only: leaked break-glass credentials must yield revocations, never
  signed quotes or ratifications.
- Authentication is therefore **IAM/SigV4** — no self-managed ingress, tokens, or mTLS. The
  in-policy guarantee still does not depend on caller identity — any invoker only ever obtains
  in-policy signatures — while the caller-to-intent scoping above decides _which_ in-policy
  intents a given principal may submit, and invoke scoping keeps revoke-griefing/DoS hard and the
  audit trail attributable.
- The Lambda's **code lives in this monorepo** and deploys as a **Docker container image**
  (ECR-hosted Lambda container image) with its own Dockerfile, like the bots. It is not a bot —
  not a long-running program — so it does not live under `/bots/`; the proposed workspace home is
  a new top-level `services/` directory, e.g. `services/quoter-signer`. Final naming and location
  are settled at implementation (open question 1).
- Flow: the bot builds the desired offer array → invokes the Lambda with the structured intent →
  the Lambda validates the three properties plus field checks, canonically encodes, derives the
  digest, calls KMS → returns the signatures and encoded payloads (tree plus publication
  transaction for quotes). Sign-what-you-encode is unchanged by the deployment shape.

### 5. Availability posture

- Lambda and KMS are both **AWS-managed**, which improves the liveness story over a self-hosted
  proxy. The middleware remains a liveness dependency: quoting fails closed when invocation
  fails; the bot halts publication and retries rather than degrading to any local signing path.
- The **revoke path must be the most available operation** — it is the safety action under
  incident conditions.
- **Break-glass revoke is just another IAM principal** granted the revoke invoke surface: an
  operator can invoke the revoke intent directly with their own credentials, with no bot in the
  path — and that surface cannot produce quote signatures.

### 6. Statefulness

The Lambda's compute is **stateless per invocation** — every check is a computation over pinned
chain truth read at invocation time, and ratify intents recompute roots rather than remembering
them — but aggregate enforcement requires one small piece of **required state: a persistent
reservation ledger**. Chain-truth reads cannot see a signature that was returned but never
published, and the freshness ceiling bounds duration, not amount — without a ledger, repeated
sign-and-withhold requests could multiply exposure far beyond the caps inside one window. Every
approved quote intent therefore records a reservation (markets, exposure, root, expiry) at
signing time; aggregate caps are enforced over live offers **plus outstanding reservations**; a
reservation is released when its root is observed live (it then counts as live) or when its
freshness ceiling passes unpublished. The ceiling keeps the ledger tiny and self-expiring;
conditional writes serialize concurrent intents; the same ledger tracks the per-surface
signed-gas budgets, including the protected revoke reserve. The ledger is what makes the
bounded-loss claim hold. Transaction nonces stay
caller-owned (see the intent contract), so the middleware never coordinates the account's
transaction stream.

### 7. Failure posture

| Failure                                   | Required behavior                                    |
| ----------------------------------------- | ---------------------------------------------------- |
| Invocation fails (throttle, error, limit) | Halt quoting (fail closed) and retry; offers stand   |
| Cold start latency                        | Tolerated; the hourly-ish cadence absorbs it         |
| Quote intent denied                       | Typed rejection, nothing signed; alert if persistent |
| Revoke intent denied                      | Near-impossible by design; treat as misconfig, alert |
| Concurrent tx signers (bot + break-glass) | Same-nonce fee-bump replacement resolves on-chain    |
| Read fails or snapshot is incoherent      | Fail closed: typed retryable denial, no signature    |
| Reservation ledger unavailable            | Quote/ratify closed; revoke uncharged + throttled    |
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
  the intent surfaces it needs and nothing else; the Lambda's execution role is the sole
  `kms:Sign` principal on the maker key; break-glass operators hold revoke-surface invoke grants
  only.
- Every signed payload class is fully describable as structured intents and canonically
  encodable inside the Lambda (SDK EIP-712 offer-tree hashing and Mempool payload encoding; viem
  transaction serialization).
- The policy surface splits cleanly: price bounds and field pins are **deployment parameters**;
  the crossed-book and no-PnL-drop properties are evaluated against the Lambda's **own
  independent reads** (RPC and Morpho API/Mempool). The Lambda has network egress to those
  sources, and a failed read fails closed. The RPC reads need **strong resilience — fallback
  providers and/or quorum agreement** — because a single lying or censoring provider is the
  remaining way to get a bad set past those two checks (open question 7). Reads for one intent
  are pinned to a single deterministic snapshot; a mixed-block view is a denial, not an input.
- A small managed store with conditional writes (e.g. DynamoDB) is available to the Lambda for
  the reservation ledger and the per-surface signed-gas budgets. It holds no secrets; its
  unavailability fails quoting closed while revocation stays served uncharged under
  infrastructure throttling.
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
- The Lambda's independent read surfaces: resilient RPC access (fallback and/or quorum across
  providers) and the Morpho API/Mempool for live offers, positions, and chain state.
- A small managed state store for the reservation ledger and signed-gas budget (e.g. DynamoDB
  with conditional writes).
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
  Lambda `Invoke` is a CloudTrail **data event and is not logged by default**
  ([Lambda CloudTrail docs](https://docs.aws.amazon.com/lambda/latest/dg/logging-using-cloudtrail.html));
  enabling the data-event selector for this function is an explicit v0 deliverable — without it,
  the invoke side of this audit trail silently does not exist.
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
  middleware; the disagreement posture is open question 7.
- **DoS via invocation throttling or concurrency exhaustion** — quoting downtime; resting offers
  stand until expiry or revocation through a break-glass invoker.

Attacker-obtainable revocations are downtime/griefing plus bounded native-gas spend, not
loan-asset loss — per-intent invoke scoping and the per-surface gas budgets keep that griefing
hard and capped, the protected revoke reserve keeps a compromised routine invoker from starving
break-glass capacity, and the deliberately small funded native balance is the hard ceiling even
during a ledger outage.

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
  all three intent types, including boundary values — price exactly at a bound, expiry exactly at
  maturity or the freshness ceiling, aggregate exposure that overflows only in combination with
  live offers or outstanding reservations, sign-and-withhold sequences denied once reservations
  exhaust the caps, a crossing replacement denied until its retired groups are observed
  invalidated and approved after, a ratify root that does not match its offer set,
  mixed-snapshot reads denied as incoherent, a routine signed-gas budget refusing the next
  publication while the revoke reserve still signs, both/neither of `maxUnits`/`maxAssets` set,
  off-by-one exposure caps, a prospective set that crosses only in combination with live offers.
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
  after the grant moves, that each role can invoke only its granted intent surfaces, and that a
  break-glass principal is denied on the quote and ratify surfaces. A denied call is part of
  acceptance, not an incident.
- Tests follow the repository verification rule: run each new test, break one assertion to
  confirm it fails, restore it.

## Future Considerations

- Nitro-Enclave attestation binding the KMS key policy to attested signing code (Alternative 7)
  as host hardening.
- Generalizing to other bots and keys — multi-tenant policy keyed by principal and key.
- Gating setup-remediation transactions (token approvals) if they move from manual operator
  actions to automated flows (open question 4).
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
3. The exact PnL/cost-basis model the Lambda evaluates for the no-PnL-drop property, and the
   independent data sources it needs.
4. Whether setup-remediation transactions (token approvals) are also gated through the middleware
   or stay manual operator actions. Setter root approvals are decided: they are the ratify
   intent.
5. Policy parameter change/approval workflow — who reviews, how it deploys, how changes are
   audited.
6. The reservation ledger's concrete store and consistency design — DynamoDB conditional writes
   are the default candidate — including release on observed publication/invalidation, expiry
   eviction, per-surface budget partitioning details, and the reserved-concurrency throttle that
   bounds uncharged revoke signing during an outage.
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
- [`production-ladder.ts`](../../bots/quoter-bot/src/infrastructure/ladder/production-ladder.ts)
  — on-chain Mempool publication, ratification, and invalidation transactions
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
