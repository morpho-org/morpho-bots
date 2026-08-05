# syntax=docker/dockerfile:1
# pnpm-workspace image for the midnight-crossed-books bot. The build context MUST be the repo root so
# the workspace packages (packages/*) resolve — docker-compose.yml sets `context: ../..`.
#
# pnpm owns installs, but bun is still the runtime, so this image carries both. The base is Node
# because pnpm is activated through corepack, which the oven/bun images do not provide; bun comes in
# as a single copied binary. Both pnpm and bun must stay on PATH in the FINAL image: `start` fires
# `prestart`, which runs `generate:api` and then `pnpm -r run build` for @repo/contracts' dist/.
FROM node:24.14.1-slim
COPY --from=oven/bun:1.3.12-slim /usr/local/bin/bun /usr/local/bin/bun
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# The container's environment holds a funded EOA key, so nothing here may run as root — the previous
# oven/bun base ended with `USER bun`, and the node images define `node` (uid 1000) but do not switch
# to it. Corepack's pnpm shim lands in /usr/local/bin, which only root may write, so enable it before
# dropping privileges; every layer after `USER node` is unprivileged.
RUN corepack enable pnpm
RUN mkdir -p /repo && chown node:node /repo
WORKDIR /repo
USER node

# Manifests first, so the install layer is cached. `corepack install` pre-fetches the pnpm version
# pinned in package.json#packageManager, so no download happens at container start.
COPY --chown=node:node package.json pnpm-workspace.yaml pnpm-lock.yaml bunfig.toml ./
RUN corepack install

# All members' package.json are needed for pnpm to resolve the `workspace:*` links.
COPY --chown=node:node packages ./packages
COPY --chown=node:node bots ./bots
RUN pnpm install --frozen-lockfile

WORKDIR /repo/bots/midnight-crossed-books
CMD ["bun", "run", "start"]
