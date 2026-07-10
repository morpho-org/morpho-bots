# syntax=docker/dockerfile:1
# The single bot image: every service runs `morpho-bots $BOT tick` in the entrypoint's sleep loop
# (see docker-entrypoint.sh — BOT, CHAIN_ID, TICK_INTERVAL_S select what runs). The build context
# MUST be the repo root so the bun workspace (packages/*) resolves — docker-compose.*.yml set
# `context: .` and Railway services set RAILWAY_DOCKERFILE_PATH=uis/cli/Dockerfile.
FROM oven/bun:1.3.12-slim
WORKDIR /repo

# Manifests + workspace members first, so `bun install` is layer-cached. All members' package.json
# are needed for bun to resolve the `workspace:*` links (bots/ until the wrappers are deleted).
COPY package.json bun.lock bunfig.toml ./
COPY packages ./packages
COPY uis ./uis
COPY bots ./bots
RUN bun install --frozen-lockfile

# Build @repo/contracts once at image build (the runtime no longer runs `prestart`), and warm the
# soltag lens solc-compile cache (packages/*/.soltag/cache) into the image so per-tick process
# spawns never pay a solc compile.
RUN bun run --filter @repo/contracts build
WORKDIR /repo/uis/cli
RUN bun -e 'await import("@repo/blue-liquidation"); await import("@repo/midnight-liquidation")'

# State/config home defaults to /data/morpho-bots (docker-entrypoint.sh) — mount a volume at /data
# so cross-tick state survives container restarts. Without one, a restart degrades to fresh-state
# semantics (safe by design; chain truth wins).
CMD ["./docker-entrypoint.sh"]
