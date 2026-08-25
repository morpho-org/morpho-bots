# Quoter signer

The deployable image of the quoter-bot KMS signing policy middleware decided in
[TIB-2026-08-12](../../docs/decisions/TIB-2026-08-12-quoter-bot-kms-signing-middleware.md): an AWS
Lambda container image that will become the **only** `kms:Sign` principal on the maker key,
validating structured intents (quote, ratify, revoke, setup remediation) against its own
independent reads before signing anything.

**Current status: fail-closed skeleton with the v1 wire contract.** The handler holds no KMS
access and implements no signing surface, but it now enforces the typed request/response contract
below at the invocation boundary. Payloads outside the contract are denied with a
`MalformedIntentError`; well-formed intents are denied with a `SigningNotImplementedError`:

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
JSON log lines to CloudWatch Logs, carrying only the allowlist-classified intent kind
(`quote`, `ratify`, `revoke`, `setup-remediation`, or `unknown`), the denial class name, and the
AWS request id — never caller-supplied data. The image is safe to deploy anywhere: it can sign
nothing.

## Wire contract (v1)

The invocation payload is one **versioned JSON intent** and the return value is one **versioned
approval-or-denial envelope**; the typed source of truth is
[`src/intent.utils.ts`](./src/intent.utils.ts) (request union plus the strict parser) and
[`src/response.utils.ts`](./src/response.utils.ts) (response union). Encoding rules: JSON cannot
carry bigint, so every uint256-range value — wei, assets, ticks, timestamps, fees, gas — is a
canonical decimal string (no sign except ticks, no leading zeros); small protocol integers
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

This build answers it with the `SigningNotImplementedError` denial above.

## Bot integration

`bots/quoter-bot` selects this middleware as its fourth maker signing method: setting
`QUOTER_SIGNER_LAMBDA_ARN` (or `identity.quoterSignerLambdaArn`, or the `--middleware` flag with
`KEY_STORAGE_METHOD=middleware`) picks the `middleware` identity alongside
`private-key`/`keystore`/`aws`, deriving the AWS region from the ARN. Per the TIB, that identity
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
complete revoke intent from the wire-contract section yields the `SigningNotImplementedError`
denial instead.

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

Create the function. The skeleton needs no KMS or other resource permissions — an execution role
with the `AWSLambdaBasicExecutionRole` managed policy (CloudWatch Logs only) is enough:

```sh
aws lambda create-function \
  --function-name quoter-signer \
  --package-type Image \
  --code "ImageUri=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/quoter-signer:<commit-sha>" \
  --role "arn:aws:iam::$ACCOUNT:role/<basic-execution-role>" \
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
the policy surfaces (crossed-book, price-bound, and PnL checks over independent reads), the
reservation ledger, and the bot-side intent ports that speak the wire contract above. Until then,
deploying this image grants nothing and signs nothing.
