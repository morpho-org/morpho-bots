# syntax=docker/dockerfile:1
# Image for the vault-v1-reallocation bot. The build context MUST be the repo root so the workspace
# packages (packages/*, framework/*) resolve; docker-compose.yml sets `context: ../..`. All data
# comes over RPC, so there is no indexer or database sidecar to build. Node only: pnpm installs,
# esbuild bundles, node runs.
FROM node:24.22.1-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# The container's environment holds a funded allocator EOA key, so nothing here may run as root.
# Corepack's pnpm shim lands in /usr/local/bin, which only root may write, so enable it before
# dropping privileges; every layer after `USER node` is unprivileged.
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

# Bundle at image-build time: workspace dists plus this bot's esbuild bundle, so the container
# starts a plain `node` with no runtime transform.
RUN pnpm -r --if-present run build

# The kernel's ledger and the journal live here. Created as `node` so a fresh Docker volume mounted
# over it is writable without root.
RUN mkdir -p /repo/state

# The journal names the build that wrote it; pass `--build-arg BUILD_REVISION=$(git rev-parse HEAD)`.
ARG BUILD_REVISION
ARG BUILD_IMAGE_TAG=vault-v1-reallocation
ENV BUILD_REVISION=$BUILD_REVISION BUILD_IMAGE_TAG=$BUILD_IMAGE_TAG

WORKDIR /repo/bots/vault-v1-reallocation
CMD ["node", "dist/src/index.js"]
