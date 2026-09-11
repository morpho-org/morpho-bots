# syntax=docker/dockerfile:1
# Image for the midnight-liquidation bot. The build context MUST be the repo root so the workspace
# packages (packages/*) resolve — docker-compose.yml sets `context: ../..` and the Railway deploy runs
# `railway up` from the repo root. Borrower discovery polls the markets liquidation-candidates HTTP
# API, so there is no indexer/database sidecar to build. Node only: pnpm installs, esbuild bundles.
FROM node:24.14.1-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# The container's environment holds a funded liquidator EOA key, so nothing here may run as root —
# the previous oven/bun base ended with `USER bun`, and the node images define `node` (uid 1000) but
# do not switch to it. Corepack's pnpm shim lands in /usr/local/bin, which only root may write, so
# enable it before dropping privileges; every layer after `USER node` is unprivileged.
RUN corepack enable pnpm
RUN mkdir -p /repo && chown node:node /repo
WORKDIR /repo
USER node

# Manifests first, so the install layer is cached. `corepack install` pre-fetches the pnpm version
# pinned in package.json#packageManager.
COPY --chown=node:node package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN corepack install

# All members' package.json are needed for pnpm to resolve the `workspace:*` links.
COPY --chown=node:node packages ./packages
COPY --chown=node:node bots ./bots
RUN pnpm install --frozen-lockfile

# Bundle at image-build time: workspace dists plus this bot's esbuild bundle (soltag `sol``` templates
# compiled in where present), so the container starts a plain `node` with no runtime transform.
RUN pnpm -r --if-present run build

WORKDIR /repo/bots/midnight-liquidation
CMD ["node", "dist/src/index.js"]
