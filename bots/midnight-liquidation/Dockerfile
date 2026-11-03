# syntax=docker/dockerfile:1
# Image for the midnight-liquidation bot. The build context MUST be the repo root so the workspace
# packages (packages/*) resolve — docker-compose.yml sets `context: ../..` and CI builds from the repo
# root. Borrower discovery polls the markets liquidation-candidates HTTP API, so there is no
# indexer/database sidecar to build. Node only: pnpm installs, esbuild bundles.
FROM node:24.22.1-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# The environment holds a funded key, so the image runs as `node`. Corepack's pnpm shim lands in
# root-owned /usr/local/bin, so enable it before `USER node`.
RUN corepack enable pnpm
RUN mkdir -p /repo && chown node:node /repo
WORKDIR /repo
USER node

# Manifests first, so the install layer is cached. `corepack install` pre-fetches the pnpm version
# pinned in package.json#packageManager.
COPY --chown=node:node package.json pnpm-workspace.yaml pnpm-lock.yaml ./
# `pnpm-workspace.yaml` declares patchedDependencies, so the install fails without these.
COPY --chown=node:node patches ./patches
RUN corepack install

# All members' package.json are needed for pnpm to resolve the `workspace:*` links.
COPY --chown=node:node packages ./packages
COPY --chown=node:node framework ./framework
COPY --chown=node:node bots ./bots
RUN pnpm install --frozen-lockfile

# Bundle at image-build time: workspace dists plus this bot's esbuild bundle (soltag `sol``` templates
# compiled in where present), so the container starts a plain `node` with no runtime transform.
RUN pnpm -r --if-present run build

# The kernel's ledger and the journal live here, on a volume in production. Owned by `node`, so a
# fresh Compose named volume starts writable.
RUN mkdir -p /repo/state

# The journal names the build that wrote it; pass `--build-arg BUILD_REVISION=$(git rev-parse HEAD)`.
ARG BUILD_REVISION
ARG BUILD_IMAGE_TAG=midnight-liquidation
ENV BUILD_REVISION=$BUILD_REVISION BUILD_IMAGE_TAG=$BUILD_IMAGE_TAG

WORKDIR /repo/bots/midnight-liquidation
CMD ["node", "dist/src/index.js"]
