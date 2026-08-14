# quoter-bot Helm chart

Deploys the Morpho Midnight maker bot from the public Docker Hub image
[`morphoorg/quoter`](https://hub.docker.com/r/morphoorg/quoter) as a single-replica Deployment
with a persistent state volume. One values file carries both the classic workload parameters
(image, resources, persistence, scheduling) and the bot's complete native YAML configuration,
so `helm install --values my-values.yaml` fully describes a deployment.

The chart is consumed from this repository checkout only; it is not published to any Helm
registry yet. All commands below run from the repository root.

## Prerequisites

- Helm 3.8+ (Helm 4 works too) and a Kubernetes cluster.
- A PersistentVolume provisioner (or a pre-created claim) for the `/state` volume.

## Quickstart

Write a values file combining workload parameters with the bot configuration. The `config`
mapping is copied verbatim into a Secret and passed to the bot with `--config`; it uses the
bot's native schema — the same `chain`, `identity`, `contracts`, `apis`, `markets`, `setup`,
`bootstrap`, and `ladder` keys as
[`quoter-bot.example.yaml`](../../quoter-bot.example.yaml), documented field by field in the
[package README](../../README.md#configuration). The bot validates the merged configuration at
startup and fails loudly on unknown keys or invalid values.

```yaml
# my-values.yaml
resources:
  requests:
    cpu: 100m
    memory: 256Mi
  limits:
    memory: 512Mi

config:
  chain:
    id: 8453
    rpcUrl: 'https://base-rpc.example'
    archiveRpcUrl: 'https://base-archive-rpc.example'
  identity:
    makerAddress: '0x1111111111111111111111111111111111111111'
  contracts:
    midnightAddress: '0x2222222222222222222222222222222222222222'
    loanAssetAddress: '0x3333333333333333333333333333333333333333'
    ratifierAddress: '0x4444444444444444444444444444444444444444'
  apis:
    morphoBaseUrl: 'https://api.example'
  markets:
    allowlist:
      - '0x5555555555555555555555555555555555555555555555555555555555555555'
    referenceMarketId: '0x7777777777777777777777777777777777777777777777777777777777777777'
  setup:
    nativeReserveWei: '10000000000000000'
    maximumLendExposureAssets: '10000000000'
  bootstrap:
    - marketId: '0x5555555555555555555555555555555555555555555555555555555555555555'
      targetRate:
        strategy: 'hardcoded'
        hardcodedRateBps: '400'
      creditTarget: '10000000000'
      acceptanceAssets: '100000000'
      offerSize: '500000000'
      premiumBps: -50
      maximumMarketExposure: '20000000000'
      maximumTotalExposure: '30000000000'
      minimumRateBps: 200
      maximumRateBps: 800
      autoRefill: false
  ladder:
    - marketId: '0x5555555555555555555555555555555555555555555555555555555555555555'
      quotePremiumBps: '0'
      spreadBps: '200'
      stepBps: '100'
      rungCount: '3'
      sizeSkewBps: '0'
      lowerRateBudgetAssets: '10000000000'
      higherRateBudgetAssets: '10000000000'
      targetMarketExposureAssets: '20000000000'
      maximumTotalExposureAssets: '30000000000'
      minimumOfferAssets: '101000000'
      groupMode: 'shared-rung'
      loopIntervalSeconds: '60'
      movementToleranceBps: '10'
      minimumRateBps: '200'
      maximumRateBps: '800'

# Environment values override YAML values, so the signing secret stays out of `config`.
env:
  - name: MAKER_PRIVATE_KEY
    valueFrom:
      secretKeyRef:
        name: quoter-bot-signer
        key: makerPrivateKey
```

Create the signer Secret out of band, then install:

```sh
kubectl create namespace quoter-bot
kubectl --namespace quoter-bot create secret generic quoter-bot-signer \
  --from-literal=makerPrivateKey=0x...

helm install quoter-bot bots/quoter-bot/helm/quoter-bot \
  --namespace quoter-bot --create-namespace --values my-values.yaml
```

Start with a read-only rehearsal (`args: ['--readonly', 'start', '--verbose']`) to inspect
every intended action before enabling signing, exactly as recommended in the package README.

**Quote every large integer** (asset amounts, wei values) as a YAML string, exactly like
`quoter-bot.example.yaml` does. Helm parses unquoted numbers as floats, so an unquoted
`10000000000000000` can re-render as `1e+16`, which the bot rejects at startup. Prefer values
files over `--set` for the `config` block for the same reason.

## How configuration reaches the bot

- `config` renders into a chart-managed Secret (a Secret rather than a ConfigMap because
  `identity` may carry signing material) and is mounted at
  `/repo/bots/quoter-bot/quoter-bot.yaml` through `subPath` — the bot opens its config with
  `O_NOFOLLOW` and would reject the symlinks a plain Secret volume mount exposes. The chart
  prepends `--config /repo/bots/quoter-bot/quoter-bot.yaml` to `args`.
- Configuration is read once at startup. Upgrades that change `config` roll the pod through a
  checksum annotation; changes to an `existingConfigSecret` instead require
  `kubectl rollout restart`.
- Every environment variable overrides its YAML counterpart (see the
  [package README](../../README.md#configuration-sources-and-precedence)), so `env`/`envFrom`
  are the right place for the signer secret and the environment-only Better Stack settings.
- To keep the whole file out of Helm release storage, pre-create a Secret with the complete
  configuration under the key `quoter-bot.yaml` and set `existingConfigSecret`.

## Parameters

### Image and workload

| Key                                         | Default                                           | Meaning                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `image.repository`                          | `morphoorg/quoter`                                | Public Docker Hub repository published on every production release.                                                                        |
| `image.tag`                                 | `''` (chart `appVersion`, `latest`)               | Pin an immutable release commit-hash tag for reproducible deployments.                                                                     |
| `image.pullPolicy`                          | `Always`                                          | Safe default while the tag is `latest`; use `IfNotPresent` with a pinned tag.                                                              |
| `imagePullSecrets`                          | `[]`                                              | Pull secrets for private mirrors.                                                                                                          |
| `command`                                   | `[node, /repo/bots/quoter-bot/dist/src/index.js]` | Runs the bundle directly as the unprivileged `node` user, bypassing the root-only Railway entrypoint.                                      |
| `args`                                      | `[start, --verbose]`                              | Root flags and command after the chart-managed `--config` pair, e.g. `['--readonly', 'start', '--verbose']` or `[setup-check, --monitor]`. |
| `resources`                                 | `{}`                                              | CPU/memory requests and limits.                                                                                                            |
| `terminationGracePeriodSeconds`             | `600`                                             | Shutdown invalidates owned offer groups and waits for receipts; 30s would SIGKILL mid-cleanup.                                             |
| `podAnnotations` / `podLabels`              | `{}`                                              | Extra pod metadata.                                                                                                                        |
| `nodeSelector` / `tolerations` / `affinity` | `{}` / `[]` / `{}`                                | Standard scheduling controls.                                                                                                              |
| `priorityClassName`                         | `''`                                              | Optional pod priority class.                                                                                                               |
| `nameOverride` / `fullnameOverride`         | `''`                                              | Standard naming overrides.                                                                                                                 |

### Configuration

| Key                    | Default | Meaning                                                                                          |
| ---------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `config`               | `{}`    | Complete bot YAML configuration, rendered verbatim into a Secret and passed via `--config`.      |
| `existingConfigSecret` | `''`    | Pre-created Secret with the full file under key `quoter-bot.yaml`; replaces the rendered Secret. |
| `env`                  | `[]`    | Extra `EnvVar` objects; environment overrides YAML (signer secret, `BETTERSTACK_*`).             |
| `envFrom`              | `[]`    | Extra `EnvFromSource` objects for whole Secrets/ConfigMaps of overrides.                         |

### Persistence and security

| Key                                  | Default                               | Meaning                                                                                                 |
| ------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `persistence.enabled`                | `true`                                | PersistentVolumeClaim for durable offer-group ownership state; `false` falls back to an emptyDir.       |
| `persistence.mountPath`              | `/state`                              | Mount path; the chart always sets `XDG_STATE_HOME` to it.                                               |
| `persistence.size`                   | `1Gi`                                 | Requested capacity (the state is tiny; this is a floor most provisioners accept).                       |
| `persistence.accessModes`            | `[ReadWriteOnce]`                     | Claim access modes.                                                                                     |
| `persistence.storageClass`           | `''`                                  | Storage class name; `-` disables dynamic provisioning; empty uses the cluster default.                  |
| `persistence.existingClaim`          | `''`                                  | Reuse a pre-created claim instead of creating one.                                                      |
| `persistence.annotations`            | `{}`                                  | Extra claim annotations.                                                                                |
| `persistence.retain`                 | `true`                                | Keeps the claim on uninstall (`helm.sh/resource-policy: keep`); a same-name reinstall re-adopts it.     |
| `volumePermissions.enabled`          | `false`                               | Root init container that chowns the state volume for storage drivers ignoring `fsGroup`.                |
| `podSecurityContext`                 | non-root uid/gid 1000, `fsGroup` 1000 | Runs as the image's `node` user; `fsGroup` makes the volume writable without root.                      |
| `securityContext`                    | hardened                              | No privilege escalation, all capabilities dropped, read-only root filesystem (with an emptyDir `/tmp`). |
| `extraVolumes` / `extraVolumeMounts` | `[]`                                  | Escape hatches, e.g. a keystore file Secret for the `keystore` signer.                                  |

## Operations

- **Singleton writer.** The Deployment pins one replica with a `Recreate` strategy: the bot's
  nonce cursor, serialized mutation queue, and ownership state are per-instance. Never scale
  it or point a second release at the same maker.
- **State volume.** Losing `/state` makes previously bot-issued offer groups unknown, which
  fails readiness until an operator invalidates or adopts them — hence `persistence.retain`
  defaulting to `true`. Chain truth wins for everything else on restart.
- **No probes.** The bot exposes no ports; it fails loudly and exits non-zero, and Kubernetes
  restarts it. Watch the structured `tx.*`/cycle events in the JSON Lines log stream, or
  configure Better Stack shipping and its heartbeat through `env`.
- **Upgrades.** `helm upgrade` with a changed `config` recreates the pod (SIGTERM drain,
  offer cleanup, then start); expect the transition to take up to the grace period.

## Validate locally

```sh
helm lint bots/quoter-bot/helm/quoter-bot
helm template quoter-bot bots/quoter-bot/helm/quoter-bot --values my-values.yaml
```
