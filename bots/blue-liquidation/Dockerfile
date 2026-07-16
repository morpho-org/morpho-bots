# syntax=docker/dockerfile:1
# Bun-workspace image for the blue-liquidation bot, plus a derived rindexer image that bakes in the
# generated event ABI (so it need not be committed). The build context MUST be the repo root so the
# workspace packages (packages/*) resolve — docker-compose.yml sets `context: ../..`. The `bot` and
# `rindexer` services select their stage via `target:`.

# Global build arg (declared before the first FROM so it can drive the `final` stage's FROM below).
# Railway always builds the Dockerfile's *final* stage and cannot pass `docker build --target`, so we
# expose a `final` alias selected by BUILD_TARGET (injected from a per-service Railway variable). Keep
# this declaration here and bare — it is only used in FROM substitution; do not move it into a stage.
ARG BUILD_TARGET=bot

FROM oven/bun:1.3.12-slim AS base
WORKDIR /repo

# Manifests + workspace members first, so `bun install` is layer-cached. All members' package.json
# are needed for bun to resolve the `workspace:*` links. Shared by the `bot` and `rindexer` targets.
COPY package.json bun.lock bunfig.toml ./
COPY packages ./packages
COPY bots ./bots
RUN bun install --frozen-lockfile

# --- bot runtime -----------------------------------------------------------------------------------
FROM base AS bot
WORKDIR /repo/bots/blue-liquidation
CMD ["bun", "run", "start"]

# --- build @repo/contracts to materialize abis/Morpho.json (single source: IMorpho.sol) -----------
# Throwaway stage; only the emitted ABI JSON is copied into the rindexer image below.
FROM base AS abi
RUN bun run --filter @repo/contracts build

# --- rindexer: upstream binary + project config (committed yaml + the contracts ABI), no bind mount
FROM ghcr.io/joshstevens19/rindexer:latest AS rindexer
COPY bots/blue-liquidation/rindexer.yaml /app/project_path/rindexer.yaml
COPY --from=abi /repo/packages/contracts/abis/Morpho.json /app/project_path/abis/morpho.abi.json
# `rindexer start` resolves rindexer.yaml (and its relative `./abis/…` path) from the working
# directory — this version ignores PROJECT_PATH — so run from the baked project dir.
WORKDIR /app/project_path
# Bake the indexer command into the image so Railway (which cannot set a start command) needs no
# override. Mirrors docker-compose.yml's `command: ['start','indexer']` (keep the two in sync).
CMD ["start", "indexer"]

# --- final: alias selected by BUILD_TARGET so Railway's "build the final stage" picks bot|rindexer.
# `bot` (the default) and `rindexer` are full runtime stages above; this just re-points the final
# image at one of them. docker-compose.yml is unaffected — it targets the named stages directly and
# never builds `final`.
FROM ${BUILD_TARGET} AS final
