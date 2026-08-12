# syntax=docker/dockerfile:1
# Image for the quoter-bot bot. The build context MUST be the repository root so workspace
# packages resolve. Node only: pnpm installs, esbuild bundles, node runs.
FROM node:24.14.1-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Runtime configuration may include a funded maker key. The entrypoint starts as root only long
# enough to repair Railway's root-owned volume, then drops to the node user before loading the bot.
# Corepack writes its pnpm shim to /usr/local/bin, so enable it while building as root.
RUN corepack enable pnpm
RUN mkdir -p /repo /state && chown node:node /repo
WORKDIR /repo

# Manifests first keep the install layer cacheable. `corepack install` fetches the pnpm version pinned
# in package.json#packageManager.
COPY --chown=node:node package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN corepack install

# All workspace manifests and sources are needed to resolve links and build the bot bundle.
COPY --chown=node:node packages ./packages
COPY --chown=node:node bots ./bots
RUN pnpm install --frozen-lockfile
RUN pnpm -r --if-present run build

WORKDIR /repo/bots/quoter-bot
CMD ["node", "scripts/railway-entrypoint.mjs", "start", "--verbose"]
