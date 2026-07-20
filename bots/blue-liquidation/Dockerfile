# syntax=docker/dockerfile:1
# pnpm-workspace image for the blue-liquidation bot; bun is the runtime. The build context MUST be
# the repo root so the workspace packages (packages/*) resolve — docker-compose.yml sets
# `context: ../..` and the Railway deploy runs `railway up` from the repo root. Borrower discovery
# polls the Morpho GraphQL API, so there is no indexer/database sidecar to build.
FROM node:24.14.1-slim
# pnpm via corepack, pinned by package.json#packageManager; bun (runtime + script runner) copied
# from its official image.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
COPY --from=oven/bun:1.3.12-slim /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /repo

# Manifests + workspace members first, so `pnpm install` is layer-cached. All members' package.json
# are needed for pnpm to resolve the `workspace:*` links.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml bunfig.toml ./
COPY packages ./packages
COPY bots ./bots
RUN pnpm install --frozen-lockfile

# Run the bot from its package dir (`start` builds workspaces via `prestart`, then runs src/index.ts).
WORKDIR /repo/bots/blue-liquidation
CMD ["bun", "run", "start"]
