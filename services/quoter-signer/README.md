# Quoter signer

The deployable image of the quoter-bot KMS signing policy middleware decided in
[TIB-2026-08-12](../../docs/decisions/TIB-2026-08-12-quoter-bot-kms-signing-middleware.md): an AWS
Lambda container image that will become the **only** `kms:Sign` principal on the maker key,
validating structured intents (quote, ratify, revoke, setup remediation) against its own
independent reads before signing anything.

**Current status: fail-closed delivery skeleton.** This first increment ships the image and this
README, not the policy. The handler holds no KMS access, implements no signing surface, and
answers every invocation — whatever the payload — with a typed denial:

```json
{
  "contractVersion": 1,
  "service": "quoter-signer",
  "approved": false,
  "denial": {
    "name": "SigningNotImplementedError",
    "message": "no signing surface is implemented in this quoter-signer build; every intent is denied"
  }
}
```

Each invocation also emits the TIB's `middleware.intent_received` / `middleware.intent_denied`
JSON log lines to CloudWatch Logs, carrying only the allowlist-classified intent kind
(`quote`, `ratify`, `revoke`, `setup-remediation`, or `unknown`) and the AWS request id — never
caller-supplied data. The image is safe to deploy anywhere: it can sign nothing.

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

Expect the fail-closed denial envelope above, and the two `middleware.*` JSON log lines in the
container's output.

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

Expect the denial envelope in `response.json` and the `middleware.intent_received` /
`middleware.intent_denied` lines in the function's CloudWatch log group
(`/aws/lambda/quoter-signer`).

## What lands next

Everything else in the TIB, in later increments: the mode-aware five-function deployment shape
(setup/health, quote or ratify, routine revoke, break-glass revoke, setup remediation)
instantiated from this one image, the invoke-only IAM chain that removes `kms:Sign` from the bot,
the policy surfaces (crossed-book, price-bound, and PnL checks over independent reads), the
reservation ledger, and the bot-side intent ports. Until then, deploying this image grants nothing
and signs nothing.
