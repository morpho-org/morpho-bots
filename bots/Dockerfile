# syntax=docker/dockerfile:1
# The single bot image: every service runs the three-stage pipeline `morpho-bots $BOT sense | act |
# queue` in the entrypoint's sleep loop (see docker-entrypoint.sh — BOT, CHAIN_ID, TICK_INTERVAL_S
# select what runs). The build context MUST be the repo root so the bun workspace (packages/*)
# resolves — bots/docker-compose.*.yml set `context: ..` and Railway services set
# RAILWAY_DOCKERFILE_PATH=bots/Dockerfile. The oven/bun base ships bash, which the entrypoint needs
# for PIPESTATUS.
FROM oven/bun:1.3.12-slim
WORKDIR /repo

# Manifests + workspace members first, so `bun install` is layer-cached. All members' package.json
# are needed for bun to resolve the `workspace:*` links.
COPY package.json bun.lock bunfig.toml ./
COPY packages ./packages
COPY interfaces ./interfaces
COPY bots ./bots
RUN bun install --frozen-lockfile

# Build @repo/contracts once at image build (the runtime no longer runs `prestart`), then AOT-bundle
# the CLI to interfaces/cli/dist/main.js. `bun run --filter @repo/cli build` runs both cores' soltag
# plugins under Bun.build, baking the compiled lens bytecode into the bundle — so per-tick spawns pay
# ZERO soltag/solc/transpile cost. This replaces the old warm-soltag-cache trick: the image is now
# "warm by construction" (see the pipeline TIB), no cache dir to prime or keep alive on the volume.
# The entrypoint runs `bun dist/main.js`, not the source, for the same reason.
RUN bun run --filter @repo/contracts build
RUN bun run --filter @repo/cli build

# State/config home defaults to /data/morpho-bots (docker-entrypoint.sh) — mount a volume at /data
# so cross-tick state survives container restarts. Without one, a restart degrades to fresh-state
# semantics (safe by design; chain truth wins).
CMD ["/repo/bots/docker-entrypoint.sh"]
