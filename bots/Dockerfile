# syntax=docker/dockerfile:1
# The single bot image runs TWO processes in the entrypoint (see docker-entrypoint.sh — BOT, CHAIN_ID,
# TICK_INTERVAL_S select what runs): the per-chain `queued` transaction-queue daemon (background,
# supervised) and the three-stage op-pipeline loop `morpho-bots $BOT $SOURCE_OP | $TRANSFORM_OP | queue`
# that feeds it over a Unix socket. The build context MUST be the repo root so the bun workspace
# (packages/*, services/*) resolves — bots/docker-compose.*.yml set `context: ..` and Railway services
# set RAILWAY_DOCKERFILE_PATH=bots/Dockerfile. The oven/bun base ships bash, which the entrypoint needs
# for PIPESTATUS.
FROM oven/bun:1.3.12-slim
WORKDIR /repo

# Manifests + workspace members first, so `bun install` is layer-cached. All members' package.json
# are needed for bun to resolve the `workspace:*` links. Only `services/queued` is copied: it is the
# lone `services/*` workspace member, so `bun install --frozen-lockfile` needs its package.json present
# or the frozen check fails. The non-workspace `services/blue-rindexer` isn't a member (no package.json)
# and isn't needed by this image, so copying it would only bust the install layer on unrelated changes
# (its own image builds from services/blue-rindexer/).
COPY package.json bun.lock bunfig.toml ./
COPY packages ./packages
COPY tools ./tools
COPY services/queued ./services/queued
COPY bots ./bots
RUN bun install --frozen-lockfile

# Build @repo/contracts once at image build (the runtime no longer runs `prestart`), then AOT-bundle
# the CLI to tools/cli/dist/main.js. `bun run --filter @repo/cli build` runs both cores' soltag
# plugins under Bun.build, baking the compiled lens bytecode into the bundle — so per-tick spawns pay
# ZERO soltag/solc/transpile cost. This replaces the old warm-soltag-cache trick: the image is now
# "warm by construction" (see the pipeline TIB), no cache dir to prime or keep alive on the volume.
# The entrypoint runs `bun dist/main.js`, not the source, for the same reason.
RUN bun run --filter @repo/contracts build
RUN bun run --filter @repo/cli build

# AOT-bundle the queue daemon to services/queued/dist/main.js the same way. Its build script runs a
# bare `Bun.build` with NO soltag plugins — the daemon's graph imports only the cores' lens-free
# `./queue` subpaths, so there is nothing to compile and a lens leak would fail the build loudly. The
# entrypoint runs this bundle (`bun /repo/services/queued/dist/main.js`), not the source.
RUN bun run --filter @repo/queued build

# State/config home defaults to /data/morpho-bots (docker-entrypoint.sh) — mount a volume at /data
# so cross-tick state survives container restarts. Without one, a restart degrades to fresh-state
# semantics (safe by design; chain truth wins).
CMD ["/repo/bots/docker-entrypoint.sh"]
