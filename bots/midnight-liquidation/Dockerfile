# syntax=docker/dockerfile:1
# pnpm-workspace image for the midnight-liquidation bot. The build context MUST be the repo root so
# the workspace packages (packages/*) resolve — docker-compose.yml sets `context: ../..` and the
# Railway deploy runs `railway up` from the repo root. Borrower discovery polls the markets
# liquidation-candidates HTTP API, so there is no indexer/database sidecar to build.
FROM node:24.14.1-slim
# pnpm via corepack, pinned by package.json#packageManager.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable pnpm
WORKDIR /repo

# Manifests + workspace members first, so `pnpm install` is layer-cached. All members' package.json
# are needed for pnpm to resolve the `workspace:*` links.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages ./packages
COPY bots ./bots
RUN pnpm install --frozen-lockfile

# Build at image build time: workspace dists + the bot's esbuild bundle (soltag `sol``` templates
# compiled in), so the container starts with a plain `node` and no runtime transform.
RUN pnpm -r --if-present run build

WORKDIR /repo/bots/midnight-liquidation
CMD ["node", "dist/src/index.js"]
