# quoter-bot Helm chart

Deploys the Morpho Midnight maker bot from the public Docker Hub image
[`morphoorg/quoter`](https://hub.docker.com/r/morphoorg/quoter) as a one-replica StatefulSet
with a persistent state volume. One values file carries both the classic workload parameters
(image, resources, persistence, scheduling) and the bot's complete native YAML configuration,
so `helm install --values my-values.yaml` fully describes a deployment.

The chart is consumed from this repository checkout only; it is not published to any Helm
registry yet. All commands below run from the repository root.

## Prerequisites

- Helm 3.8+ (Helm 4 works too) and a Kubernetes cluster.
- A PersistentVolume provisioner (or a pre-created claim) for the `/state` volume.
- The default `volumePermissions` init container runs as root (with capabilities reduced to
  `CHOWN` + `DAC_OVERRIDE`), which fits the **Baseline** Pod Security Standard but is rejected
  by **Restricted** namespaces. Under Restricted, set `volumePermissions.enabled=false` and
  provide a volume already owned by uid/gid 1000 (a provisioner or storage class that sets
  ownership, or a one-time privileged job outside the namespace) — do not substitute
  `fsGroup`, whose permission-bit changes the bot's state readers reject.

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

Create the signer Secret out of band, then install. The key is read from a hidden prompt and
piped through stdin so it never appears in `kubectl` process arguments or shell history (the
same argv-exposure warning as the package README's `--private-key` guidance):

```sh
kubectl create namespace quoter-bot

read -rs MAKER_PRIVATE_KEY
printf '%s' "$MAKER_PRIVATE_KEY" |
  kubectl --namespace quoter-bot create secret generic quoter-bot-signer \
    --from-file=makerPrivateKey=/dev/stdin
unset MAKER_PRIVATE_KEY

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

| Key                                                | Default                                           | Meaning                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image.repository`                                 | `morphoorg/quoter`                                | Public Docker Hub repository published on every production release.                                                                                                                                                                                                                                                                                   |
| `image.tag`                                        | `''` (chart `appVersion`, `latest`)               | Pin an immutable release commit-hash tag for reproducible deployments.                                                                                                                                                                                                                                                                                |
| `image.pullPolicy`                                 | `Always`                                          | Safe default while the tag is `latest`; use `IfNotPresent` with a pinned tag.                                                                                                                                                                                                                                                                         |
| `imagePullSecrets`                                 | `[]`                                              | Pull secrets for private mirrors.                                                                                                                                                                                                                                                                                                                     |
| `command`                                          | `[node, /repo/bots/quoter-bot/dist/src/index.js]` | Runs the bundle directly as the unprivileged `node` user, bypassing the root-only Railway entrypoint.                                                                                                                                                                                                                                                 |
| `args`                                             | `[start, --verbose]`                              | Root flags and command after the chart-managed `--config` pair, e.g. `['--readonly', 'start', '--verbose']` or `[setup-check, --monitor]`.                                                                                                                                                                                                            |
| `resources`                                        | `{}`                                              | CPU/memory requests and limits.                                                                                                                                                                                                                                                                                                                       |
| `terminationGracePeriodSeconds`                    | `1020`                                            | Shutdown serializes up to five receipt-bounded waits (in-flight cancellation, Setter ratification, in-flight publication, bootstrap cleanup, ladder cleanup); automatically floored to 5× a chart-managed `setup.transactionReceiptTimeoutMs` (or the bot's 180 s default) plus 120s. Size explicitly for many owned groups or env-supplied timeouts. |
| `forceRestartOnUpgrade`                            | `false`                                           | Stamps an upgrade-time annotation so every `helm upgrade` rolls the pod — the way to re-pull a moved `latest` tag.                                                                                                                                                                                                                                    |
| `podAnnotations` / `podLabels`                     | `{}`                                              | Extra pod metadata.                                                                                                                                                                                                                                                                                                                                   |
| `nodeSelector` / `tolerations` / `affinity`        | `{}` / `[]` / `{}`                                | Standard scheduling controls.                                                                                                                                                                                                                                                                                                                         |
| `priorityClassName`                                | `''`                                              | Optional pod priority class.                                                                                                                                                                                                                                                                                                                          |
| `serviceAccount.create` / `.name` / `.annotations` | `false` / `''` / `{}`                             | Dedicated ServiceAccount for workload-identity signers (AWS IRSA / EKS Pod Identity with the `aws` key-storage method); annotate with e.g. `eks.amazonaws.com/role-arn`. The pod keeps `automountServiceAccountToken: false` — credential webhooks inject their own projected tokens.                                                                 |
| `nameOverride` / `fullnameOverride`                | `''`                                              | Standard naming overrides.                                                                                                                                                                                                                                                                                                                            |

### Configuration

| Key                    | Default | Meaning                                                                                                                             |
| ---------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `config`               | `{}`    | Complete bot YAML configuration, rendered verbatim into a Secret and passed via `--config`.                                         |
| `existingConfigSecret` | `''`    | Pre-created Secret with the full file under key `quoter-bot.yaml`; replaces the rendered Secret.                                    |
| `env`                  | `[]`    | Extra `EnvVar` objects; environment overrides YAML (signer secret, `BETTERSTACK_*`). `XDG_STATE_HOME` is reserved and filtered out. |
| `envFrom`              | `[]`    | Extra `EnvFromSource` objects for whole Secrets/ConfigMaps of overrides.                                                            |

### Persistence and security

| Key                                  | Default               | Meaning                                                                                                 |
| ------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------- |
| `persistence.enabled`                | `true`                | PersistentVolumeClaim for durable offer-group ownership state; `false` falls back to an emptyDir.       |
| `persistence.mountPath`              | `/state`              | Mount path; the chart always sets `XDG_STATE_HOME` to it.                                               |
| `persistence.size`                   | `1Gi`                 | Requested capacity (the state is tiny; this is a floor most provisioners accept).                       |
| `persistence.accessModes`            | `[ReadWriteOnce]`     | Claim access modes.                                                                                     |
| `persistence.storageClass`           | `''`                  | Storage class name; `-` disables dynamic provisioning; empty uses the cluster default.                  |
| `persistence.existingClaim`          | `''`                  | Reuse a pre-created claim instead of creating one.                                                      |
| `persistence.annotations`            | `{}`                  | Extra claim annotations.                                                                                |
| `persistence.retain`                 | `true`                | Keeps the claim on uninstall (`helm.sh/resource-policy: keep`); a same-name reinstall re-adopts it.     |
| `volumePermissions.enabled`          | `true`                | Chown-only root init container; preserves strict modes on restored state files.                         |
| `podSecurityContext`                 | non-root uid/gid 1000 | Runs the runtime container as the image's `node` user; intentionally omits `fsGroup`.                   |
| `securityContext`                    | hardened              | No privilege escalation, all capabilities dropped, read-only root filesystem (with an emptyDir `/tmp`). |
| `extraVolumes` / `extraVolumeMounts` | `[]`                  | Escape hatches, e.g. a keystore file Secret for the `keystore` signer.                                  |

## Operations

- **Singleton writer.** The chart runs a one-replica StatefulSet: the bot's nonce cursor,
  serialized mutation queue, and ownership state are per-instance, and a StatefulSet never
  creates the replacement pod until the old one is confirmed fully terminated — covering
  rollouts, graceful pod deletion, and eviction alike, which a Deployment (even with
  `Recreate`) only guarantees for rollouts. Never scale it or point a second release at the
  same maker. Kubernetes' one documented exception is **force deletion**: never
  `kubectl delete pod --force --grace-period=0` (or force-delete a partitioned Node object) —
  the controller then replaces the pod while the original writer may still be running, and the
  bot deliberately has no Kubernetes API access or external lock to defend itself. Fence a
  failed node first, then let the controller replace the pod. Selector identity is pinned to
  the chart and release names, so `nameOverride`/`fullnameOverride` changes cannot invalidate
  the immutable selector — and an upgrade that would _rename_ the StatefulSet is rejected by a
  template guard (a release-name-keyed ConfigMap pins the installed name, read back with a
  name-scoped get, so no StatefulSet list permission is needed), because Helm creates the new
  name before deleting the old one and would briefly run two writers. To rename: run
  `helm uninstall --wait` with `--timeout` beyond `terminationGracePeriodSeconds` — a plain
  uninstall returns while the old pod is still draining — confirm the pod is gone
  (`kubectl wait --for=delete pod/<old-fullname>-0 --timeout=30m`), then reinstall, keeping
  your `persistence.existingClaim` unchanged if you configured one, or setting it to the kept
  `<old-fullname>-state` claim for a chart-created claim, so durable offer-group ownership
  survives the migration. The portless headless Service exists solely to govern the
  StatefulSet.
- **State volume.** Losing `/state` makes previously bot-issued offer groups unknown, which
  fails readiness until an operator invalidates or adopts them — hence `persistence.retain`
  defaulting to `true`. Chain truth wins for everything else on restart.
- **No probes.** The bot exposes no ports; it fails loudly and exits non-zero, and Kubernetes
  restarts it. Watch the structured `tx.*`/cycle events in the JSON Lines log stream, or
  configure Better Stack shipping and its heartbeat through `env`.
- **Upgrades.** `helm upgrade` with a changed `config` rolls the pod (SIGTERM drain, offer
  cleanup, then start); expect the transition to take up to the grace period. With an
  unchanged pod template nothing restarts, so a moved `latest` image is only picked up after
  `kubectl rollout restart statefulset/<release-name>` or with `forceRestartOnUpgrade=true` —
  production deployments should pin an immutable commit tag instead.

## Validate locally

```sh
helm lint bots/quoter-bot/helm/quoter-bot
helm template quoter-bot bots/quoter-bot/helm/quoter-bot --values my-values.yaml
```
