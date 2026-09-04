# Quoter signer

The deployable image of the quoter-bot KMS signing policy middleware decided in
[TIB-2026-08-12](../../docs/decisions/TIB-2026-08-12-quoter-bot-kms-signing-middleware.md): an AWS
Lambda container image that will become the **only** `kms:Sign` principal on the maker key,
validating structured intents (quote, ratify, revoke, setup remediation) against its own
independent reads before signing anything.

**Current status: encode-and-sign build for the ladder create/move surfaces.** On top of the v1
wire contract, the deterministic deployment-policy checks, and the KMS maker-key custody
attestation, the handler now canonically encodes and signs the intents the ladder flow needs:

- **`quote`** (Ecrecover): the offer tree is re-derived from the validated set with the pinned
  maker and the policy-pinned market structs injected, every content-addressed consumption-group
  id is verified against the offer contents, the EIP-712 tree digest is signed with exactly one
  `kms:Sign` call, and the approval returns the re-derived root, the tree signature, and the
  exact zero-value Mempool publication payload.
- **`ratify`** (Setter): the same full re-validation and root re-derivation, then the signed
  `setIsRootRatified(maker, root, true)` transaction plus the signature-free publication payload.
- **`revoke`** (`consume-groups`, `cancel-root`, `unratify-root`): the exact allowlisted
  zero-value call — `setConsumed(group, MAX_OFFER_CAP, maker)` on the pinned singleton (batches
  as one `multicall` built solely from such calls), `cancelRoot(maker, root)` or
  `setIsRootRatified(maker, root, false)` on the pinned ratifier — signed as one transaction
  artifact.

Transaction-signing intents commit to the maker's **pending nonce read through the middleware's
own RPC endpoint** (see [RPC endpoint](#rpc-endpoint-quoter_signer_rpc_url)); the endpoint's
chain id is verified against the policy pin on every read, and a read failure is a typed
retryable denial with no KMS call. Everything else stays fail-closed with typed denials: payloads
outside the contract (`MalformedIntentError`), a missing or invalid policy document
(`PolicyNotConfiguredError`), out-of-policy intents including group ids that do not re-derive
from the offer contents (`IntentPolicyViolationError` naming the violated check), missing or
invalid KMS or RPC addressing (`KmsNotConfiguredError` / `RpcNotConfiguredError`), chain-read
failures (`RpcUnavailableError`, retryable) and endpoint chain drift (`RpcChainMismatchError`),
attestation-read failures (`KmsUnavailableError`, retryable), custody drift
(`KmsAttestationFailedError`), stale attestations (`KmsAttestationStaleError`, retryable), KMS
signature-validation failures (`KmsSigningFailedError`), a `Sign` call that failed outright
(`KmsSignOutcomeUnknownError`, non-retryable — the outcome is ambiguous), and post-validation
assembly faults (`ArtifactEncodingFailedError`). **`setup-remediation` intents and `self-cancel`
revocations are still denied with `SigningNotImplementedError`**: they need the recorded
transaction inventory and remediation epochs of later TIB increments.

Each invocation emits the TIB's JSON log lines to CloudWatch Logs: `middleware.intent_received`,
then one `middleware.kms_sign` line per completed `Sign` call carrying the middleware-derived
digest and the **KMS request id** (the CloudTrail reconciliation join key — emitted immediately
after the call, so the record exists even if a later assembly stage fails, and emitted on the
denial path too when a completed `Sign` response fails the DER/recovery verification), and finally
`middleware.intent_approved` (re-derived root, nonce, transaction hash, and the expected
`kmsSignCalls` count, per kind) or `middleware.intent_denied`; `middleware.kms_error` and
`middleware.read_failed` accompany the corresponding failures. Lines carry only the
allowlist-classified intent kind, denial class names, check identifiers, and middleware-owned
values — never caller-supplied data. Deploying the image without granting its execution role
`kms:Sign` keeps it sign-inert: every signing attempt then fails closed at the KMS boundary.

## Wire contract (v1)

The invocation payload is one **versioned JSON intent** and the return value is one **versioned
approval-or-denial envelope**; the typed source of truth is
[`src/intent.utils.ts`](./src/intent.utils.ts) (request union plus the strict parser) and
[`src/response.utils.ts`](./src/response.utils.ts) (response union). Encoding rules: JSON cannot
carry bigint, so every uint256-range value — wei, assets, ticks, timestamps, fees, gas — is a
canonical decimal string (unsigned — every protocol offer field is unsigned — no leading
zeros, and bounded to the struct width, e.g. uint128 offer caps); small protocol integers
(`chainId`, nonces) are JSON numbers; addresses are validated and checksummed; unknown keys,
unknown kinds, and unknown contract versions are rejected outright — no best-effort
interpretation.

Every intent carries `contractVersion: 1`, `kind`, `chainId`, `maker`, and a caller-chosen
`idempotencyKey` (inert in this build — stored-artifact retries ride on the reservation ledger of
a later increment, so a replayed key today re-evaluates and, for transaction kinds, re-signs at
the current pending nonce). The four kinds:

- **`quote`** (Ecrecover): `offers` — 1..80 structured offers (at most 40 per side) over at most
  7 distinct markets, in
  exact tree order with explicit consumption groups. Offers mirror the SDK `IOffer` shape but
  carry only the Midnight `marketId`: market parameters are policy-relevant, so the middleware
  resolves them from its own allowlist and independent reads. Approval returns the re-derived
  `root`, the maker `treeSignature`, and the exact zero-value Mempool `publication` payload for
  the constrained non-maker broadcaster — no maker transaction.
- **`ratify`** (Setter): the same `offers` array plus `fees`. Approval returns the re-derived
  `root`, the signed `setIsRootRatified(maker, root, true)` transaction artifact, and the
  `publication` payload.
- **`revoke`**: one constrained `operation` — `consume-groups` (non-empty group list, encoded as
  exact `setConsumed(group, MAX_OFFER_CAP, maker)` calls, batched as one policy-checked
  multicall), `cancel-root`, `unratify-root`, or `self-cancel` at a recorded nonce — plus `fees`.
  Approval returns the signed transaction artifact. `self-cancel` parses but is still denied
  not-implemented: it validates against the recorded-transaction inventory of a later increment.
- **`setup-remediation`**: a deployment-manifest `remediation` variant id plus `fees`; the
  middleware reads current allowance/authorization state itself and encodes the exact pinned
  transaction. Approval returns the signed transaction artifact. Parses but is still denied
  not-implemented: it requires the remediation epochs of a later increment.

`fees` (`maxFeePerGas`, `maxPriorityFeePerGas`, `gas`) are caller-supplied liveness parameters
only — the middleware enforces its own ceilings and budgets on top. Signed transaction artifacts
return the exact broadcastable bytes with their hash, nonce, and signed fee fields. Denials carry
a stable error `name`, a sanitized `message`, and `retryable`.

A complete well-formed revoke intent:

```json
{
  "contractVersion": 1,
  "kind": "revoke",
  "chainId": 8453,
  "maker": "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
  "idempotencyKey": "revoke-2026-08-25-001",
  "operation": { "type": "cancel-root", "root": "0x7777777777777777777777777777777777777777777777777777777777777777" },
  "fees": { "maxFeePerGas": "2000000000", "maxPriorityFeePerGas": "1000000000", "gas": "90000" }
}
```

A fully configured deployment (policy, KMS maker key with `kms:Sign` granted, RPC endpoint)
answers it with the approval envelope — the signed `cancelRoot(maker, root)` transaction artifact
at the maker's pending nonce. Without those, the answer is the corresponding typed denial
(`PolicyNotConfiguredError`, `KmsNotConfiguredError`, `RpcNotConfiguredError`,
`RpcUnavailableError`, `KmsUnavailableError`, or `KmsAttestationFailedError`).

## Deployment policy (`QUOTER_SIGNER_POLICY`)

Policy parameters live in the middleware's deployment, never in the request (TIB-2026-08-12): the
`QUOTER_SIGNER_POLICY` environment variable carries one JSON policy document, strictly parsed by
[`src/policy.utils.ts`](./src/policy.utils.ts) with the same fail-closed discipline as the wire
contract — unknown keys, unknown versions, and out-of-domain values refuse to serve
(`PolicyNotConfiguredError`; "never run a partial or empty policy"). A complete document:

```json
{
  "policyVersion": 1,
  "surface": "routine-revoke",
  "ratifierMode": "ecrecover",
  "chainId": 8453,
  "maker": "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A",
  "ratifier": "0xd6e70365C8E8DDa9a4ca662C07bbE663b017755E",
  "contracts": {
    "midnight": "0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A",
    "mempool": "0xdD6DCE32e21f7b020898a8258dA37355b4017993"
  },
  "offerWindow": { "freshnessCeilingSeconds": "3600", "maxStartAgeSeconds": "900" },
  "markets": [
    {
      "marketId": "0x5555555555555555555555555555555555555555555555555555555555555555",
      "maturity": "1800025200",
      "tickSpacing": "4",
      "loanToken": "0x0000000000000000000000000000000000006000",
      "collateralParams": [
        {
          "token": "0x0000000000000000000000000000000000007000",
          "lltv": "770000000000000000",
          "liquidationCursor": "250000000000000000",
          "oracle": "0x0000000000000000000000000000000000008000"
        }
      ],
      "rcfThreshold": "0",
      "enterGate": "0x0000000000000000000000000000000000000000",
      "liquidatorGate": "0x0000000000000000000000000000000000000000",
      "minTick": "100",
      "maxTick": "5000",
      "maxContinuousFeeCap": "317097919",
      "maxLendExposureAssets": "20000000000"
    }
  ],
  "maxTotalLendExposureAssets": "30000000000",
  "feeCeilings": {
    "routine": { "maxFeePerGas": "3000000000", "maxPriorityFeePerGas": "1500000000", "gas": "400000" },
    "protected": { "maxFeePerGas": "30000000000", "maxPriorityFeePerGas": "15000000000", "gas": "800000" }
  },
  "remediations": [
    {
      "variant": "loan-asset-approval",
      "feeCeiling": { "maxFeePerGas": "3000000000", "maxPriorityFeePerGas": "1500000000", "gas": "120000" }
    }
  ]
}
```

The `contracts` block pins the Midnight singleton (the group-consumption target and every market
struct's `midnight` field) and the Mempool log contract (the zero-value publication target);
neither ever comes from the caller or an address registry. Each market entry now carries the
market's **full immutable parameter struct** — `loanToken`, the `collateralParams` list (strictly
ascending by token, the unique order the protocol enforces at creation), `rcfThreshold`,
`enterGate`, `liquidatorGate` — alongside its `maturity` and the book's live on-chain
`tickSpacing` (1, 2, or 4 — it must divide the protocol default, and every offer tick must align
to it). Parse-time validation re-derives the content-addressed market id from the struct fields
(plus the policy `chainId` and the pinned singleton) through the SDK and refuses to serve unless
it equals the pinned `marketId`, and requires the maturity to sit exactly at 15:00:00 UTC inside
the Mempool codec's safe-timestamp bound — an off-schedule maturity could never publish, so a
mis-pinned document refuses to serve instead of denying every intent. The `marketId` shown above
is a placeholder — use the real id and its real struct.

Every field is required on every surface so one reviewed document serves all deployments of the
shared image; `surface` is the only per-deployment difference and pins which intent kind the
function accepts (`quote`, `ratify`, `revoke` on both revoke surfaces, `setup-remediation`) and
which fee-ceiling class applies. Parse-time deployment validation enforces the TIB's cross-field
rules: the quote surface requires `ratifierMode: "ecrecover"` and ratify requires `"setter"`;
tick bounds must be coherent and within the protocol `MAX_TICK` (6744); continuous-fee ceilings
within the protocol `MAX_CONTINUOUS_FEE`; and each protected fee ceiling must cover one complete
emergency replacement bump — `max(floor(routine × 1125 / 1000), routine + 1 wei)` — of its
routine counterpart, with `protected.gas` at least `routine.gas`, so a routine bid can never
strand the break-glass replacement path.

A well-formed intent is then checked against every rule decidable from these parameters and the
middleware clock ([`src/policy-check.utils.ts`](./src/policy-check.utils.ts)): the surface's
pinned intent kind, chain and maker pins, per-kind fee/gas ceilings (`protected` on the
break-glass surface, per-variant for setup remediation, `routine` otherwise), Ecrecover/Setter
coherence of `cancel-root`/`unratify-root` revocations, the remediation-variant allowlist, and —
for quote and ratify offer sets — the market allowlist, tick price bounds, offer field pins (the
configured ratifier; no callback surface; the zero receiver on buys and the maker itself on
sells), reduce-only side pins (sells must be `reduceOnly: true`, buys must not), per-market
continuous-fee-cap ceilings, the offer time windows (`start < expiry`, not yet expired,
`expiry ≤ min(maturity, now + freshnessCeilingSeconds)`, `start ≥ now − maxStartAgeSeconds`),
group coherence (Midnight groups are content-addressed, so one group id must bind one market,
side, and cap value), and the static lend-exposure caps — buy offers charge their `maxAssets`
once per consumption domain `(market, group, side, cap value)`, so per-book rungs sharing a group
count once, against both the per-market and the maker-wide cap. Violations are denied with
`IntentPolicyViolationError` naming the check; the denial log line carries the same check id.

An offer set that passes these checks is then **re-encoded canonically before signing**
([`src/offer-tree.utils.ts`](./src/offer-tree.utils.ts)): the middleware builds every offer
itself from the validated fields, the pinned maker, and the policy market structs; reconstructs
the consumption groups from the intent's leaf order (offers sharing a declared group must be
contiguous); and denies the set unless every content-addressed group id it derives equals the
caller's declared id (`group-derivation`). Quote sets additionally pass a publication-encoding
preflight — the Mempool payload codec's own offer-struct rules, such as 15:00:00-UTC maturities —
before any KMS call (`offer-encoding` on rejection). What was validated is what is signed, by
construction.

The TIB's independent-read properties — crossed books, PnL, snapshot-derived market fees,
aggregate signed-exposure reservations, nonce leases, signed-gas budgets, and native-balance
admission — remain later increments: this build's approvals charge no durable reservation, and
the production-enablement gates the TIB places on the quote/ratify surfaces (the PnL model,
pinned provider quorum, indexed-block snapshots, write-before-sign catalog persistence) are
unchanged. The pending-nonce read is the one independent read this increment adds.

Operator guidance for the policy values (all fail closed, so a tight value halts quoting rather
than leaking exposure — revocation stays the kill switch):

- **Freshness sequencing**: today's ladder/bootstrap builders pin `expiry = market maturity`, so
  any freshness ceiling shorter than time-to-maturity denies their offers. That is the TIB's
  intended order — the bot-side builder change to `expiry = min(maturity, signedAt + freshness
ceiling)` is a prerequisite of turning the bot's quote/ratify flows onto this middleware, and
  this build now enforces the ceiling on every quote/ratify intent it signs.
- **Tick bounds**: a Midnight tick maps to a rate through time-to-maturity, so the tick for a
  fixed APR drifts upward as the market ages. Set `minTick`/`maxTick` as an envelope over the
  market's whole quoting horizon, not today's rate window.
- **`maxContinuousFeeCap`**: default it to the protocol `MAX_CONTINUOUS_FEE` (317097919) unless a
  market-specific reason exists — a tighter value denies fee-tracking offers, including the
  reduce-only exit sells, after a governance fee raise until the policy is redeployed.
- **`maxStartAgeSeconds`**: offers carry the block timestamp at build time as `start`, and a
  Setter ratify re-presents the same offers later, so size this for block-timestamp lag plus
  build→invoke and ratify-retry latency.

## RPC endpoint (`QUOTER_SIGNER_RPC_URL`)

Transaction-signing intents (ratify and revoke) commit to an account nonce, and nonce ordering is
policy-relevant: the middleware reads the maker's **current pending nonce independently** through
its own HTTP(S) JSON-RPC endpoint — never from the caller — and signs only that nonce
([`src/chain-read.utils.ts`](./src/chain-read.utils.ts), parsed by
[`src/rpc-config.utils.ts`](./src/rpc-config.utils.ts)). Every read first verifies the endpoint's
`eth_chainId` against the policy pin, so a repointed or misconfigured provider cannot feed
another chain's account state into a signature that commits to the pinned chain
(`RpcChainMismatchError`, terminal). A missing or non-HTTP(S) value refuses transaction signing
with `RpcNotConfiguredError`; a failed or malformed read denies with the retryable
`RpcUnavailableError` and the `middleware.read_failed` log line — always before any KMS call.
Quote intents sign no maker transaction and never require the endpoint. The endpoint URL is never
echoed in errors, responses, or logs.

The TIB's nonce-lease fence (refusing a second routine signature at a non-terminal nonce) rides
on the reservation ledger and is a later increment; until it lands, the bot's serialized
make/pending queue remains the single routine writer, as it is today.

## KMS maker key (`QUOTER_SIGNER_KMS_KEY_ID`, `QUOTER_SIGNER_KMS_REGION`)

Like the policy document, KMS addressing lives in the middleware's deployment, never in the
request: callers cannot select which key signs. Two environment variables pin the maker key —
`QUOTER_SIGNER_KMS_KEY_ID` (a key id, key ARN, alias name `alias/...`, or alias ARN) and
`QUOTER_SIGNER_KMS_REGION` (pinned explicitly rather than inherited from the Lambda's own region,
so a cross-region key is a reviewed, fail-loud choice). Both are strictly parsed by
[`src/kms-config.utils.ts`](./src/kms-config.utils.ts); a missing or malformed value refuses to
serve with `KmsNotConfiguredError`.

For an intent that passes every deterministic policy check, the handler then performs the
**maker-key custody attestation** ([`src/kms-signer.utils.ts`](./src/kms-signer.utils.ts)): call
`kms:GetPublicKey` on the configured key, require the exact
`ECC_SECG_P256K1`/`SIGN_VERIFY`/`ECDSA_SHA_256` shape and the resolved key ARN, strictly parse
the canonical uncompressed-secp256k1 `SubjectPublicKeyInfo` (DER is canonical, so the parse is an
exact 23-byte-prefix comparison plus on-curve validation of the point — no ASN.1 library in the
root-of-trust image), derive the maker address, and fail closed unless it equals the
policy-pinned `maker`. The attested signer is cached per execution environment with a
**five-minute freshness bound** (`KMS_ATTESTATION_FRESHNESS_MS`), so a warm container re-proves
custody at the next window and catches key or deployment drift — and the signing primitive
enforces the same bound itself, refusing to sign against an attestation that has aged past the
window (`KmsAttestationStaleError`, retryable after re-attestation), so freshness never depends
on the caller's cache discipline; a failed attestation is evicted
so a transient KMS fault never poisons the container. When both the policy document and the KMS
variables are configured, a best-effort attestation also starts at **cold start**, before the
first invocation. A failed `GetPublicKey` call denies with the retryable `KmsUnavailableError`;
every custody violation denies with `KmsAttestationFailedError` naming an allowlisted reason
(`key-spec`, `key-arn`, `missing-public-key`, `public-key-encoding`, `maker-mismatch`).

**Scope, stated precisely**: this is a per-container attestation gating the signing path, not yet
the TIB's full startup/readiness attestation — the setup/health surface, the per-surface
attestation registry with its manifest-pinned freshness window and scheduled refresh, and the
alias/image/readiness validation are later increments. An unattested container still answers
wire-contract and policy denials (that is fail-closed serving, not signing), and the guarantee
this build does make is strict: the digest-signing primitive is reachable only behind a fresh
attestation and refuses on its own to sign against a stale one, so nothing is ever signed
before, without, or against a stale attestation.

The same module carries the digest-signing primitive the encode stages call
(sign-what-you-encode, §2): `kms:Sign` with `MessageType: 'DIGEST'` and
`SigningAlgorithm: 'ECDSA_SHA_256'` — issued against the resolved key ARN captured at attestation
(never the configured alias, which could be repointed to an unattested key afterwards) on a
single-attempt client (no SDK retries: every CloudTrail `Sign` event must reconcile with exactly
one middleware signing record; a `Sign` call that fails outright maps to the **non-retryable**
`KmsSignOutcomeUnknownError`, because the outcome is ambiguous — a signature may exist
server-side — and blind invocation-level retry could mint a second signature for one artifact) — followed by a strict canonical DER parse, low-s
normalization, a recovery check across both parities against the attested maker address, and
capture of the KMS request id — the CloudTrail reconciliation join key each per-artifact
`middleware.kms_sign` record logs, so a `Sign` response without one (or with a blank one) is
rejected rather than becoming an unreconcilable signature. **The encode stages now reach it**:
quote, ratify, and non-self-cancel revoke intents that pass every earlier stage produce exactly
one `Sign` call per artifact, so a signing deployment's execution role needs `kms:Sign` alongside
`kms:GetPublicKey` on the maker key. A deployment that should stay sign-inert simply withholds
the `kms:Sign` grant: every signing attempt then denies at the KMS boundary with
`KmsSignOutcomeUnknownError` while attestation and every denial path keep working.

## Bot integration

`bots/quoter-bot` selects this middleware as its fourth maker signing method: setting
`QUOTER_SIGNER_LAMBDA_ARN` (or `identity.quoterSignerLambdaArn`, or the `--middleware` flag with
`KEY_STORAGE_METHOD=middleware`) picks the `middleware` identity alongside
`private-key`/`keystore`/`aws`. The value must be an alias-qualified Lambda ARN — the TIB's
production-alias invocation rule, enforced at configuration time: unqualified ARNs, version
qualifiers, and `$LATEST` are rejected — and the AWS region is derived from the ARN. Per the TIB, that identity
is deliberately **not** a drop-in signer: the bot-side generic digest-signing path fails closed
with `MiddlewareSigningUnsupportedError`, and write flows stay halted until the intent ports that
speak this wire contract land.

## Image

- Docker Hub: **`morphoorg/quoter-signer`** — tagged with the immutable source commit hash, plus a
  moving `latest`, mirroring the `morphoorg/quoter` bot image
  ([TIB-2026-08-14](../../docs/decisions/TIB-2026-08-14-quoter-bot-dockerhub-publishing.md)).
- Built from [`Dockerfile`](./Dockerfile) with **build context = repository root** (workspace
  packages must resolve). The build stage installs the pnpm workspace and bundles the handler; the
  runtime stage is the AWS Lambda Node.js 24 base image (`public.ecr.aws/lambda/nodejs:24`) and
  receives only the self-contained ESM bundle — no workspace source, no bot code, no package
  manager.
- CI publishing is not wired yet; maintainers push manually (below). When it lands it follows the
  TIB-2026-08-14 OIDC pattern.

## Build

From the repository root:

```sh
docker build \
  -f services/quoter-signer/Dockerfile \
  --build-arg GIT_REVISION="$(git rev-parse HEAD)" \
  -t morphoorg/quoter-signer:local \
  .
```

The build is host-native (no multi-arch): an Apple Silicon host produces a `linux/arm64` image, an
x86 host `linux/amd64`. Remember which you built — the Lambda function's `--architectures` must
match.

## Try it locally

The AWS base image embeds the Lambda Runtime Interface Emulator, so the image runs standalone:

```sh
docker run --rm -p 9000:8080 morphoorg/quoter-signer:local
```

then, from another shell:

```sh
curl -s -XPOST 'http://localhost:9000/2015-03-31/functions/function/invocations' \
  -d '{"kind": "quote"}'
```

Expect a fail-closed `MalformedIntentError` denial (the payload names a kind but violates the
wire contract), and the two `middleware.*` JSON log lines in the container's output. Sending the
complete revoke intent from the wire-contract section yields the `PolicyNotConfiguredError`
denial — no policy document is configured — and re-running the container with
`-e QUOTER_SIGNER_POLICY='<policy JSON>'` turns that into the policy checks plus the
`KmsNotConfiguredError` denial: the KMS maker key is not configured, and without AWS credentials
and an RPC endpoint in the local container neither the attestation nor the nonce read can succeed
anyway — a signed approval needs the Lambda deployment below.

## Publish to Docker Hub (maintainers)

Until CI publishing lands, releases are pushed manually — immutable commit tag first, then
`latest`:

```sh
REVISION="$(git rev-parse HEAD)"
docker build -f services/quoter-signer/Dockerfile --build-arg GIT_REVISION="$REVISION" \
  -t "morphoorg/quoter-signer:$REVISION" -t morphoorg/quoter-signer:latest .
docker push "morphoorg/quoter-signer:$REVISION"
docker push morphoorg/quoter-signer:latest
```

Build from a clean checkout of the released commit so the OCI `revision` label and the tag both
name the source truthfully.

## Run it in AWS Lambda

Lambda pulls container images only from a **private Amazon ECR repository in the same region as
the function** — same-account is the simple path documented here; cross-account works with an ECR
repository policy — so first copy the published image into your ECR:

```sh
ACCOUNT=<aws-account-id> REGION=<region>
aws ecr create-repository --repository-name quoter-signer --region "$REGION"
docker pull morphoorg/quoter-signer:<commit-sha>
docker tag morphoorg/quoter-signer:<commit-sha> "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/quoter-signer:<commit-sha>"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com"
docker push "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/quoter-signer:<commit-sha>"
```

Create the function. Without KMS configuration an execution role with the
`AWSLambdaBasicExecutionRole` managed policy (CloudWatch Logs only) is enough and every
well-formed in-policy intent is denied with `KmsNotConfiguredError`; to exercise the custody
attestation alone, additionally grant the execution role `kms:GetPublicKey` on the maker key and
set the two KMS variables — withholding `kms:Sign` keeps the deployment sign-inert. **A signing
deployment additionally grants `kms:Sign` on the maker key** and sets `QUOTER_SIGNER_RPC_URL`
(required for ratify/revoke; quote signs without it). The deployment policy
document rides in the function's environment; without it every well-formed intent is denied with
`PolicyNotConfiguredError`. The policy is itself JSON, so pass the environment as a file
(`--environment` shorthand cannot safely carry the nested commas and quotes) — with the document
from the Deployment policy section saved as `policy.json`:

```sh
jq -n --arg policy "$(cat policy.json)" \
  '{Variables: {QUOTER_SIGNER_POLICY: $policy, QUOTER_SIGNER_KMS_KEY_ID: "alias/<maker-key-alias>", QUOTER_SIGNER_KMS_REGION: "<region>", QUOTER_SIGNER_RPC_URL: "https://<rpc-endpoint>"}}' > environment.json
aws lambda create-function \
  --function-name quoter-signer \
  --package-type Image \
  --code "ImageUri=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/quoter-signer:<commit-sha>" \
  --role "arn:aws:iam::$ACCOUNT:role/<basic-execution-role>" \
  --environment file://environment.json \
  --architectures <x86_64|arm64> \
  --region "$REGION"
```

`--architectures` must match the pulled image's platform (see Build). Invoke it:

```sh
aws lambda invoke \
  --function-name quoter-signer \
  --cli-binary-format raw-in-base64-out \
  --payload '{"kind": "quote"}' \
  --region "$REGION" \
  response.json
cat response.json
```

Expect a fail-closed denial envelope in `response.json` and the `middleware.intent_received` /
`middleware.intent_denied` lines in the function's CloudWatch log group
(`/aws/lambda/quoter-signer`).

## What lands next

Everything else in the TIB, in later increments: the mode-aware five-function deployment shape
(setup/health, quote or ratify, routine revoke, break-glass revoke, setup remediation)
instantiated from this one image, the invoke-only IAM chain that removes direct KMS access from
the bot, the remaining independent-read policy properties (crossed books, PnL, snapshot-derived
fees bounding `continuousFeeCap`, position state, pinned provider quorum), the reservation
ledger with its aggregate signed-exposure, signed-gas, nonce-lease, and write-before-sign
catalog accounting, the setup-remediation and self-cancel surfaces, the setup/health attestation
registry, and the bot-side intent ports that speak the wire contract above. The TIB's
production-enablement gates for quote/ratify signing (PnL model, provider quorum, indexed-block
snapshots, catalog persistence, the bot-side freshness-aware builders) are unchanged by this
increment; a production deployment controls exposure through the `kms:Sign` grant and the policy
document it reviews.
