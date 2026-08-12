# syntax=docker/dockerfile:1
# Image for the quoter-bot bot. The build context MUST be the repository root so workspace
# packages resolve. Node only: pnpm installs, esbuild bundles, node runs.
FROM node:24.14.1-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# HUSKY=0 keeps the root `prepare` script from installing hooks during image installs; HOME lets
# corepack and pnpm write their user-level caches under the node user.
ENV HUSKY=0
ENV HOME=/home/node

# Runtime configuration may include a funded maker key. The entrypoint starts as root only long
# enough to repair Railway's root-owned volume, then setpriv atomically execs the bot without root
# identities or capabilities. Corepack writes its pnpm shim to /usr/local/bin, so enable it while
# building as root. Install util-linux explicitly so the runtime always provides setpriv.
RUN /usr/bin/apt-get update \
  && /usr/bin/apt-get install -y --no-install-recommends util-linux \
  && /usr/bin/rm -rf /var/lib/apt/lists/*
RUN /usr/local/bin/corepack enable pnpm
RUN /usr/bin/mkdir -p /repo /state && /usr/bin/chown node:node /repo

# Install dependencies and run workspace build scripts without root privileges. The official image
# owns /home/node, so Corepack and pnpm can write their user-level cache under HOME.
USER node
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

# Railway must start the container as root so the entrypoint can repair its root-owned mount. Install
# a fresh root-owned, non-writable copy only after all node-controlled install and build steps, then
# immediately drop to node with setpriv before executing application code.
USER root
COPY --chown=0:0 --chmod=0555 bots/quoter-bot/scripts/railway-entrypoint.sh /usr/local/sbin/railway-entrypoint.sh
WORKDIR /repo/bots/quoter-bot
CMD ["/usr/local/sbin/railway-entrypoint.sh", "start", "--verbose"]
