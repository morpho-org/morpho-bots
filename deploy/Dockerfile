# syntax=docker/dockerfile:1
# The bot image runs a signer, a per-chain queue daemon, and the JSONL liquidation pipeline.
# The build context MUST be the repo root so the bun workspace
# (packages/*, apps/*) resolves — deploy/docker-compose.*.yml set `context: ..` and Railway services
# set RAILWAY_DOCKERFILE_PATH=deploy/Dockerfile. The oven/bun base ships bash, which the entrypoint
# needs for PIPESTATUS.
FROM oven/bun:1.3.12-slim
WORKDIR /repo

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

# The only runtime piece of deploy/: the entrypoint loop (CMD).
COPY deploy/docker-entrypoint.sh ./deploy/

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
