# syntax=docker/dockerfile:1
# Bun-workspace image for the blue-liquidation bot. The build context MUST be the repo root so the
# workspace packages (packages/*) resolve — docker-compose.yml sets `context: ../..` and the Railway
# deploy runs `railway up` from the repo root. Borrower discovery polls the Morpho GraphQL API, so
# there is no indexer/database sidecar to build.
FROM oven/bun:1.3.12-slim
WORKDIR /repo

# Manifests + workspace members first, so `bun install` is layer-cached. All members' package.json are
# needed for bun to resolve the `workspace:*` links.
COPY package.json bun.lock bunfig.toml ./
COPY packages ./packages
COPY bots ./bots
RUN bun install --frozen-lockfile

# Run the bot from its package dir (`start` builds workspaces via `prestart`, then runs src/index.ts).
WORKDIR /repo/bots/blue-liquidation
CMD ["bun", "run", "start"]
