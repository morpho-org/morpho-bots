# Quoter signer

The deployable image of the quoter-bot KMS signing policy middleware decided in
[TIB-2026-08-12](../../docs/decisions/TIB-2026-08-12-quoter-bot-kms-signing-middleware.md): an AWS
Lambda container image that will become the **only** `kms:Sign` principal on the maker key,
validating structured intents (quote, ratify, revoke, setup remediation) against its own
independent reads before signing anything.

**Current status: fail-closed build with the v1 wire contract, the deterministic
deployment-policy checks, and the KMS maker-key custody attestation plus digest-signing layer.**
The handler implements no encode-and-sign surface and never calls `kms:Sign`, but it now enforces
the typed request/response contract below at the invocation boundary, validates every well-formed
intent against the deployment policy document (see
[Deployment policy](#deployment-policy-quoter_signer_policy)), and — for intents that pass every
deterministic check — attests the configured KMS maker key (see
[KMS maker key](#kms-maker-key-quoter_signer_kms_key_id-quoter_signer_kms_region)). Payloads
outside the contract are denied with a `MalformedIntentError`; when the policy document is missing
or invalid the build refuses to serve with a `PolicyNotConfiguredError`; out-of-policy intents are
denied with an `IntentPolicyViolationError` naming the violated check; missing or invalid KMS
addressing refuses to serve with a `KmsNotConfiguredError`; a failed KMS call is denied with a
retryable `KmsUnavailableError`; custody drift (wrong key shape, malformed public key, or a
derived address that is not the policy maker) is denied with a `KmsAttestationFailedError`; and
intents that pass every implemented stage are still denied with a `SigningNotImplementedError`:

```json
{
  "contractVersion": 1,
  "service": "quoter-signer",
  "approved": false,
  "denial": {
    "name": "SigningNotImplementedError",
    "message": "no signing surface is implemented in this quoter-signer build; every intent is denied",
    "retryable": false
  }
}
```

Each invocation also emits the TIB's `middleware.intent_received` / `middleware.intent_denied`
JSON log lines to CloudWatch Logs — plus `middleware.kms_error` when the attestation stage fails —
carrying only the allowlist-classified intent kind (`quote`, `ratify`, `revoke`,
`setup-remediation`, or `unknown`), the denial class name, the violated policy check id on a
policy denial, the failed KMS operation or attestation reason on a KMS denial, and the AWS request
id — never caller-supplied data. The image is safe to deploy anywhere: `kms:Sign` is never called,
so it can sign nothing.

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
`idempotencyKey` (retries with the same key must return the stored artifacts once signing exists).
The four kinds:

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
  Approval returns the signed transaction artifact.
- **`setup-remediation`**: a deployment-manifest `remediation` variant id plus `fees`; the
  middleware reads current allowance/authorization state itself and encodes the exact pinned
  transaction. Approval returns the signed transaction artifact.

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

This build answers it with the `SigningNotImplementedError` denial above (once the deployment
policy below is configured and the KMS maker key is configured and attested; without those, the
answer is the `PolicyNotConfiguredError`, `KmsNotConfiguredError`, `KmsUnavailableError`, or
`KmsAttestationFailedError` denial).

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
  "offerWindow": { "freshnessCeilingSeconds": "3600", "maxStartAgeSeconds": "900" },
  "markets": [
    {
      "marketId": "0x5555555555555555555555555555555555555555555555555555555555555555",
      "maturity": "1800000000",
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

These are the deterministic checks only. The TIB's independent-read properties — crossed books,
PnL, snapshot-derived market fees, aggregate reservations, nonce leases, and native-balance
admission — land in later increments, so passing every current check still ends in the
`SigningNotImplementedError` denial.

Operator guidance for the policy values (all fail closed, so a tight value halts quoting rather
than leaking exposure — revocation stays the kill switch):

- **Freshness sequencing**: today's ladder/bootstrap builders pin `expiry = market maturity`, so
  any freshness ceiling shorter than time-to-maturity denies their offers. That is the TIB's
  intended order — the bot-side builder change to `expiry = min(maturity, signedAt + freshness
ceiling)` is a prerequisite of the same increment that enables quote/ratify signing — and is
  irrelevant while this build signs nothing.
- **Tick bounds**: a Midnight tick maps to a rate through time-to-maturity, so the tick for a
  fixed APR drifts upward as the market ages. Set `minTick`/`maxTick` as an envelope over the
  market's whole quoting horizon, not today's rate window.
- **`maxContinuousFeeCap`**: default it to the protocol `MAX_CONTINUOUS_FEE` (317097919) unless a
  market-specific reason exists — a tighter value denies fee-tracking offers, including the
  reduce-only exit sells, after a governance fee raise until the policy is redeployed.
- **`maxStartAgeSeconds`**: offers carry the block timestamp at build time as `start`, and a
  Setter ratify re-presents the same offers later, so size this for block-timestamp lag plus
  build→invoke and ratify-retry latency.

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
attestation and refuses on its own to sign against a stale one, and since no encode-and-sign
surface exists, nothing can be signed before, without, or against a stale attestation.

The same module carries the digest-signing primitive the TIB's encode stages will call
(sign-what-you-encode, §2): `kms:Sign` with `MessageType: 'DIGEST'` and
`SigningAlgorithm: 'ECDSA_SHA_256'` — issued against the resolved key ARN captured at attestation
(never the configured alias, which could be repointed to an unattested key afterwards) on a
single-attempt client (no SDK retries: every CloudTrail `Sign` event must reconcile with exactly
one middleware signing record) — followed by a strict canonical DER parse, low-s
normalization, a recovery check across both parities against the attested maker address, and
capture of the KMS request id — the CloudTrail reconciliation join key each per-artifact signing
record must log, so a `Sign` response without one (or with a blank one) is rejected rather than
becoming an unreconcilable signature. **No intent reaches it yet**: until the encode stages land, every attested
intent is still denied with `SigningNotImplementedError`, and the execution role needs
`kms:GetPublicKey` on the maker key but must not hold `kms:Sign`.

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
in the local container the attestation stage cannot succeed anyway — a fully attested
`SigningNotImplementedError` denial needs the Lambda deployment below.

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
attestation, additionally grant the execution role `kms:GetPublicKey` — and nothing else, in
particular not `kms:Sign` — on the maker key and set the two KMS variables. The deployment policy
document rides in the function's environment; without it every well-formed intent is denied with
`PolicyNotConfiguredError`. The policy is itself JSON, so pass the environment as a file
(`--environment` shorthand cannot safely carry the nested commas and quotes) — with the document
from the Deployment policy section saved as `policy.json`:

```sh
jq -n --arg policy "$(cat policy.json)" \
  '{Variables: {QUOTER_SIGNER_POLICY: $policy, QUOTER_SIGNER_KMS_KEY_ID: "alias/<maker-key-alias>", QUOTER_SIGNER_KMS_REGION: "<region>"}}' > environment.json
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
instantiated from this one image, the invoke-only IAM chain that removes `kms:Sign` from the bot,
the independent-read policy properties (crossed books, PnL, snapshot-derived fees and
`continuousFeeCap`, canonical group and root re-derivation), the reservation ledger with its
aggregate signed-exposure, signed-gas, and nonce-lease accounting, the canonical encode stages
that feed the now-present attested KMS digest signer (sign-what-you-encode — the first stages to
hold `kms:Sign`), and the bot-side intent ports that speak the wire contract above. Until then,
deploying this image grants nothing beyond `kms:GetPublicKey` and signs nothing.
