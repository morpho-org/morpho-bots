# syntax=docker/dockerfile:1
# Bun-workspace image for the midnight-liquidation bot, plus a derived rindexer image that bakes in
# the generated event ABI (so it need not be committed). The build context MUST be the repo root so
# the workspace packages (packages/*) resolve — docker-compose.yml sets `context: ../..`. The `bot`
# and `rindexer` services select their stage via `target:`.
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
WORKDIR /repo/bots/midnight-liquidation
CMD ["bun", "run", "start"]

# --- build @repo/contracts to materialize abis/Midnight.json (single source: IMidnight.sol) -------
# Throwaway stage; only the emitted ABI JSON is copied into the rindexer image below.
FROM base AS abi
RUN bun run --filter @repo/contracts build

# --- rindexer: upstream binary + project config (committed yaml + the contracts ABI), no bind mount
FROM ghcr.io/joshstevens19/rindexer:latest AS rindexer
COPY bots/midnight-liquidation/rindexer.yaml /app/project_path/rindexer.yaml
COPY --from=abi /repo/packages/contracts/abis/Midnight.json /app/project_path/abis/midnight.abi.json
