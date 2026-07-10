# syntax=docker/dockerfile:1
# The blue-liquidation discovery indexer: upstream rindexer + this service's rindexer.yaml + the
# generated Morpho event ABI baked in (so it need not be committed). The build context MUST be the
# repo root so the bun workspace resolves for the ABI build stage — bots/docker-compose.blue.yml sets
# `context: ..` and the Railway service sets RAILWAY_DOCKERFILE_PATH=services/blue-rindexer/Dockerfile.

# --- build @repo/contracts to materialize abis/Morpho.json (single source: IMorpho.sol) -----------
# Throwaway stage; only the emitted ABI JSON is copied into the rindexer image below.
FROM oven/bun:1.3.12-slim AS abi
WORKDIR /repo
COPY package.json bun.lock bunfig.toml ./
COPY packages ./packages
COPY interfaces ./interfaces
COPY bots ./bots
RUN bun install --frozen-lockfile
RUN bun run --filter @repo/contracts build

# --- rindexer: upstream binary + project config (committed yaml + the contracts ABI), no bind mount
FROM ghcr.io/joshstevens19/rindexer:latest
COPY services/blue-rindexer/rindexer.yaml /app/project_path/rindexer.yaml
COPY --from=abi /repo/packages/contracts/abis/Morpho.json /app/project_path/abis/morpho.abi.json
# `rindexer start` resolves rindexer.yaml (and its relative `./abis/…` path) from the working
# directory — this version ignores PROJECT_PATH — so run from the baked project dir.
WORKDIR /app/project_path
# Bake the indexer command into the image so Railway (which cannot set a start command) needs no
# override. Mirrors docker-compose.blue.yml's `command: ['start','indexer']` (keep the two in sync).
CMD ["start", "indexer"]
