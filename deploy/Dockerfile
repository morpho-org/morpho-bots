# syntax=docker/dockerfile:1
# The bot image runs a signer, a per-chain queue daemon, and the JSONL liquidation pipeline.
# The build context MUST be the repo root so the bun workspace
# (packages/*, apps/*) resolves — deploy/docker-compose.*.yml set `context: ..` and Railway services
# set RAILWAY_DOCKERFILE_PATH=deploy/Dockerfile. The oven/bun base ships bash, which the entrypoint
# needs to wire the pipeline through named FIFOs and wait on each stage.

# Pinned Vector binary for the OPTIONAL BetterStack log-forwarding side-car (deploy/vector.yaml).
# Copied into the runtime image below so apt never runs in the final layer. Bump this exact tag to
# upgrade Vector; the `vector --version` check below fails the build if the binary can't run here.
FROM timberio/vector:0.57.0-debian AS vector

FROM oven/bun:1.3.12-slim
WORKDIR /repo

# The optional log-forwarding side-car binary. Placed early (stable layer, cache-friendly). The
# HTTP sink uses TLS, so `vector --version` proves the binary resolves its shared libs in this slim
# base at BUILD time — a runtime failure would only surface once a bot is live. The side-car stays
# inert unless BETTERSTACK_SOURCE_TOKEN is set (see docker-entrypoint.sh).
COPY --from=vector /usr/bin/vector /usr/bin/vector
RUN vector --version

# Manifests + workspace members first, so `bun install` is layer-cached. All members' package.json
# are needed for bun to resolve the `workspace:*` links. deploy/ is copied selectively: its
# package.json makes the `deploy` workspace member resolvable for `bun install --frozen-lockfile`,
# while the non-workspace `deploy/blue-rindexer` (no package.json) isn't needed by this image, so
# copying it wholesale would only bust the install layer on unrelated changes (its own image builds
# from deploy/blue-rindexer/).
COPY package.json bun.lock bunfig.toml ./
COPY packages ./packages
COPY apps ./apps
COPY deploy/package.json ./deploy/package.json
RUN bun install --frozen-lockfile

# The runtime pieces of deploy/: the entrypoint loop (CMD) and the log-forwarder config it starts
# when BetterStack forwarding is enabled. `vector validate` compiles the config + VRL at BUILD time
# (dummy creds satisfy the ${...} placeholders; --no-environment skips the live BetterStack
# connection), so a config or VRL typo fails the build, not a running bot. Vector 0.57 disabled
# ${...} env interpolation by default; VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION re-enables it
# (safe here: the config is baked read-only and the interpolated vars are operator-set, not
# attacker-controlled). The runtime launch in docker-entrypoint.sh sets the same flag.
COPY deploy/docker-entrypoint.sh deploy/vector.yaml ./deploy/
RUN BETTERSTACK_INGESTING_HOST=example.invalid BETTERSTACK_SOURCE_TOKEN=validate-only \
  VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION=true \
  vector validate --no-environment deploy/vector.yaml

# Build @repo/contracts once at image build (the runtime no longer runs `prestart`), then AOT-bundle
# the CLI to apps/cli/dist/main.js. `bun run --filter @repo/cli build` runs both cores' soltag
# plugins under Bun.build, baking the compiled lens bytecode into the bundle — so per-tick spawns pay
# ZERO soltag/solc/transpile cost. This replaces the old warm-soltag-cache trick: the image is now
# "warm by construction" (see the pipeline TIB), no cache dir to prime or keep alive on the volume.
# The entrypoint runs `bun dist/main.js`, not the source, for the same reason.
RUN bun run --filter @repo/contracts build
RUN bun run --filter @repo/cli build

# AOT-bundle the queue daemon to apps/queued/dist/main.js.
RUN bun run --filter @repo/queued build

# State/config home defaults to /data/morpho-bots (docker-entrypoint.sh) — mount a volume at /data
# so cross-tick state survives container restarts. Without one, a restart degrades to fresh-state
# semantics (safe by design; chain truth wins).
CMD ["/repo/deploy/docker-entrypoint.sh"]
