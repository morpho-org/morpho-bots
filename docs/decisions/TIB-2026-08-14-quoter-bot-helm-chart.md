# TIB-2026-08-14: Quoter-bot package-owned Helm chart for Kubernetes self-hosting

| Field      | Value           |
| ---------- | --------------- |
| **Status** | Proposed        |
| **Date**   | 2026-08-14      |
| **Author** | @julien         |
| **Scope**  | Bot: quoter-bot |

---

## Context

[TIB-2026-08-14-quoter-bot-dockerhub-publishing](./TIB-2026-08-14-quoter-bot-dockerhub-publishing.md)
gives third-party operators a public image, `morphoorg/quoter`, but no deployment recipe: a
Kubernetes operator must hand-write manifests and rediscover the bot's non-obvious runtime
constraints — a config loader that rejects symlinked files, ownership-state files checked against
the process uid, an image entrypoint that requires root, singleton nonce semantics, and a shutdown
sequence that legitimately takes minutes. Each of these fails loud but late, at pod startup or
termination. The bot already owns its operator surface (`README.md`, `Dockerfile`,
`docker-compose.yml`, `scripts/deploy-railway.ts`); Kubernetes needs an equivalent package-owned
artifact that encodes those constraints as defaults.

## Goals / Non-Goals

**Goals**

- Ship the recommended self-hosting path for Kubernetes operators consuming `morphoorg/quoter`
  (default tag `latest`), as a chart owned by the bot package:
  `bots/quoter-bot/helm/quoter-bot`.
- One values file fully configures a deployment, reusing the bot's native YAML configuration
  schema so the bot's own startup validation stays the single source of truth.
- Encode the bot's operational invariants — singleton writer, durable state retention, long
  graceful shutdown, non-root execution — as chart defaults rather than README warnings.
- Keep the pod hardened by default: non-root, read-only root filesystem, no Kubernetes API
  access.

**Non-Goals**

- Not publishing the chart to any Helm registry — it is consumed from the repository checkout
  only (`helm install quoter-bot bots/quoter-bot/helm/quoter-bot`), deferred until the chart
  stabilizes.
- Not changing the maintainers' own deployment — Railway remains the deploy path
  ([TIB-2026-07-15](./TIB-2026-07-15-ci-deploy-pipeline.md)); the chart is a third-party operator
  surface alongside `Dockerfile`, `docker-compose.yml`, and `deploy-railway.ts`.
- Not duplicating the bot's configuration validation in a `values.schema.json` — the schema
  would drift from the bot's fail-loud startup validation, which already rejects unknown keys and
  invalid values.
- Not charts for the other bots — quoter-bot is the public reference bot; the liquidators and
  crossed-books have no public image.

## Current Solution

Third-party operators have the public image
([TIB-2026-08-14-quoter-bot-dockerhub-publishing](./TIB-2026-08-14-quoter-bot-dockerhub-publishing.md)),
the `Dockerfile`, and a `docker-compose.yml` for single-host operation. There is no Kubernetes
artifact; the runtime constraints listed in Context are only discoverable by reading source or by
failing in-cluster.

## Proposed Solution

A Helm chart at `bots/quoter-bot/helm/quoter-bot` (`Chart.yaml`, `values.yaml`, `templates/`, its
own `README.md`) rendering one Deployment, an optional chart-managed config Secret, and an
optional PersistentVolumeClaim. Defaults are load-bearing — each encodes a verified runtime
constraint:

**Configuration passthrough.** A single `config` values mapping mirrors the bot's native YAML
schema — the same `chain`/`identity`/`contracts`/`apis`/`markets`/`setup`/`bootstrap`/`ladder`
keys as `quoter-bot.example.yaml` — and is rendered verbatim (`toYaml`) into a chart-managed
Secret, mounted and passed via the CLI root flag
`--config /repo/bots/quoter-bot/quoter-bot.yaml`. One values
file fully describes a deployment, and the bot's startup validation remains the only schema
authority. It is a Secret, not a ConfigMap, because `identity` may carry signing material.

**subPath mount, not a plain Secret volume.** The config loader
(`bots/quoter-bot/src/config/config-source.utils.ts`, `readConfiguration`) opens the file with
`O_RDONLY | O_NONBLOCK | O_NOFOLLOW` and requires a regular file, so the symlink farm a normal
Secret volume mount exposes (`..data/`) would fail startup. The chart bind-mounts the resolved
regular file through `subPath`. Consequence: subPath mounts never receive Secret updates, so the
Deployment pod template carries a `checksum/config` annotation that rolls the pod on
`helm upgrade`; operators using `existingConfigSecret` must
`kubectl rollout restart deployment/<release>-quoter-bot` after editing their Secret.

**The signer stays out of `config`.** Environment values override YAML values (documented
precedence), so the chart's `env`/`envFrom` parameters are the intended carrier for
`MAKER_PRIVATE_KEY` — or the keystore/AWS alternatives from
[TIB-2026-08-12](./TIB-2026-08-12-quoter-bot-kms-signing-middleware.md) — and for the
environment-only `BETTERSTACK_*` variables. Alternatively, `existingConfigSecret` keeps the whole
file out of Helm values and release storage. Verified end to end: the chart-rendered Secret
content was decoded and loaded through `ConfigService.load` in read-only and write mode, with the
env-injected private key resolving to signing method `private-key`.

**Non-root instead of the Railway entrypoint.** The image CMD
(`scripts/railway-entrypoint.sh`) must start as root — it `chown -R`s `/state`, then `setpriv`s
to `node`. The chart bypasses it and runs `node /repo/bots/quoter-bot/dist/src/index.js` directly
as the image's `node` user (uid/gid 1000). A chown-only root init container makes the state
volume writable without asking kubelet to apply `fsGroup` permission changes. This matters because
the ownership-state readers (`src/infrastructure/bootstrap/bootstrap-group-ownership.utils.ts`,
`src/infrastructure/ladder/ladder-group-ownership.utils.ts`) reject state files not owned by the
process uid or carrying mode bits beyond `0600`, so a consistent non-root uid is required across
restarts. Hardened defaults: `runAsNonRoot`, seccomp `RuntimeDefault`,
`allowPrivilegeEscalation: false`, all capabilities dropped, `readOnlyRootFilesystem` with an
emptyDir `/tmp`, and `automountServiceAccountToken: false` (the bot never talks to the
Kubernetes API). The `volumePermissions` init container reuses the bot image's `/usr/bin/chown`
and is enabled by default. It changes ownership but not mode bits, preserving secure restored
state files that would be rejected if `fsGroup` handling added group access.

**Singleton semantics.** The Deployment hardcodes `replicas: 1` with `strategy: Recreate`. The
nonce cursor, serialized mutation queue, and durable offer-group ownership state are
per-instance: two replicas against one maker would race nonces and fight over the offer book.
Recreate guarantees the old pod fully drains (offer cleanup included) before the replacement
starts against the same ReadWriteOnce volume.

**State volume.** `XDG_STATE_HOME` always points at the mount (default `/state`). The PVC
`<fullname>-state` carries `helm.sh/resource-policy: keep` by default (`persistence.retain`):
deleting ownership state makes previously bot-issued groups unknown, which fails readiness until
an operator invalidates or adopts them. A reinstall under the same release name and namespace
re-adopts the kept claim.

**Shutdown budget.** `terminationGracePeriodSeconds` defaults to 600. SIGTERM drains the
in-flight cycle, then invalidates owned offer groups and waits for receipts — bounded per
transaction by `TRANSACTION_RECEIPT_TIMEOUT_MS` (default 180 s) — so shutdown legitimately takes
minutes. Kubernetes' 30-second default would SIGKILL mid-cleanup and leave owned offers on the
book.

**No probes, no Service.** The bot exposes no ports. It fails loud and exits non-zero; the
restart policy plus JSON Lines logs and Better Stack shipping are the observability story.

**Tooling.** oxfmt cannot parse Go-templated YAML, so `.oxfmtrc.json` `ignorePatterns` gains
`**/helm/**/templates/**`; `Chart.yaml`, `values.yaml`, and the chart README stay
formatter-covered. lint-staged's `*.yaml` glob runs oxfmt, so staged templates are skipped
automatically.

## Considered Alternatives

### Alternative 1: StatefulSet

The canonical controller for stateful singletons.

**Why rejected:** `volumeClaimTemplates` complicate `existingClaim` reuse, and a StatefulSet
requires a headless Service — extra surface for a bot with no ports. Deployment + Recreate + the
`keep` resource policy provides the same singleton and state-retention properties.

### Alternative 2: publish the chart to a Helm registry

Push the chart to an OCI registry alongside the Docker Hub image.

**Why rejected:** deferred until the chart stabilizes. Consuming from the repository checkout
keeps the chart versioned with the bot source while both are still churning.

### Alternative 3: ConfigMap for the configuration file

Render `config` into a ConfigMap instead of a Secret.

**Why rejected:** `identity` may carry signing material; a Secret is the safe default for a
verbatim configuration passthrough.

### Alternative 4: run the image's root entrypoint in-cluster

Keep the image CMD (`railway-entrypoint.sh`) and let it chown the volume before dropping
privileges.

**Why rejected:** requires starting the long-lived container as root. The short-lived
`volumePermissions` init container performs only the required chown before the hardened runtime
container starts, without changing restored state-file modes.

## Assumptions & Constraints

- The chart bypasses the image CMD, so it depends on image internals: the bundle at
  `/repo/bots/quoter-bot/dist/src/index.js`, the `node` user at uid/gid 1000, and `/usr/bin/chown`
  for the optional init container. A Dockerfile restructure must update the chart in the same
  change.
- The image contains `/usr/bin/chown` for the default `volumePermissions` init container.
- Large integers in `config` (asset amounts, wei values, bytes32 IDs) must be quoted as YAML
  strings, exactly like `quoter-bot.example.yaml`: Helm parses unquoted numbers as floats and can
  re-render `10000000000000000` as `1e+16`, which the bot rejects at startup.
- Configuration is read once at startup; a pod roll (checksum annotation or manual restart) is
  the only config-change mechanism.
- The chart and the image are versioned independently: a checkout's chart may differ from what
  `latest` ships. Pin an immutable commit tag through `image.tag` for reproducible deployments.

## Security

- The rendered configuration lives in a Secret, but Helm release storage still holds the values
  it came from; `existingConfigSecret` keeps the file out of Helm entirely, and the env-injected
  signer keeps the key out of both the values and the rendered Secret.
- Default pod posture: non-root uid 1000, seccomp `RuntimeDefault`, no privilege escalation, all
  capabilities dropped, read-only root filesystem, no service-account token. The chown-only
  `volumePermissions` init container is the only root surface and exits before the bot starts.

## Observability

The chart adds no probes, Service, or metrics endpoint — there is nothing to scrape. Operability
rests on the bot's own surfaces: fail-loud non-zero exits driving the Kubernetes restart policy,
JSON Lines logs on stdout, and the `BETTERSTACK_*` variables (injected through `env`/`envFrom`)
for log shipping and heartbeat.

## Future Considerations

- **Registry publishing** (OCI chart push, plausibly wired into the same release pipeline as the
  image) once the chart's values surface stabilizes and third-party demand warrants it.

## References

- [TIB-2026-08-14-quoter-bot-dockerhub-publishing](./TIB-2026-08-14-quoter-bot-dockerhub-publishing.md)
  — companion TIB: publishes the `morphoorg/quoter` image this chart consumes.
- [TIB-2026-07-27-midnight-quoter-bot](./TIB-2026-07-27-midnight-quoter-bot.md) — the bot the
  chart deploys.
- [TIB-2026-08-12-quoter-bot-kms-signing-middleware](./TIB-2026-08-12-quoter-bot-kms-signing-middleware.md)
  — the signer methods carried through `env`/`envFrom`.
- [TIB-2026-07-15-ci-deploy-pipeline](./TIB-2026-07-15-ci-deploy-pipeline.md) — Railway, the
  maintainers' own deployment path, unchanged by this TIB.
- Implementation surface: `bots/quoter-bot/helm/quoter-bot/` (`Chart.yaml`, `values.yaml`,
  `templates/`, `README.md`), `.oxfmtrc.json` (`ignorePatterns`).

<!--
TIB conventions:
- Once accepted, do not substantively edit this TIB. If the decision needs to change,
  create a new TIB that supersedes this one and update the Status/Superseded by fields.
- Addenda may be appended to record operational updates that affect
  how the TIB is applied without changing the decision itself.
- TIB identifiers use CalVer (YYYY-MM-DD) based on the date the TIB was first drafted.
-->
