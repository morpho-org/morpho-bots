# syntax=docker/dockerfile:1
# Bun-workspace image for the midnight-liquidation bot. The build context MUST be the repo root so
# the workspace packages (packages/*) resolve — docker-compose.yml sets `context: ../..`.
FROM oven/bun:1.3.12-slim
WORKDIR /repo

# Manifests + workspace members first, so `bun install` is layer-cached. All members' package.json
# are needed for bun to resolve the `workspace:*` links.
COPY package.json bun.lock bunfig.toml ./
COPY packages ./packages
COPY bots ./bots
RUN bun install --frozen-lockfile

WORKDIR /repo/bots/midnight-liquidation
CMD ["bun", "run", "start"]
