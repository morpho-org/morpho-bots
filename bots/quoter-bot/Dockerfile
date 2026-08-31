# syntax=docker/dockerfile:1
# Image for the quoter-bot bot. The build context MUST be the repository root so workspace
# packages resolve. Node only: pnpm installs, esbuild bundles, node runs.
#
# Two stages so the shipped image carries only this bot: `build` installs the workspace and bundles
# the bot; the runtime stage starts from a fresh base and receives nothing but the bot's
# self-contained bundle. The image publishes publicly on release (morphoorg/quoter), so no other
# bot's code, no workspace source, and no package manager may ship in the final stage.
FROM node:24.14.1-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV HOME=/home/node

# Corepack writes its pnpm shim to /usr/local/bin, so enable it while still root.
RUN /usr/local/bin/corepack enable pnpm
RUN /usr/bin/mkdir -p /repo && /usr/bin/chown node:node /repo

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
COPY --chown=node:node services ./services
RUN pnpm install --frozen-lockfile
RUN pnpm -r --if-present run build

# Runtime stage. dist/src/index.js is a self-contained esbuild bundle (scripts/build.ts,
# bundle: true), so no node_modules ships; the bot's package.json rides along only so node treats
# the bundle's .js as ESM ("type": "module"). Files stay root-owned and read-only to the runtime
# user. Install util-linux explicitly so the runtime always provides setpriv.
FROM node:24.14.1-slim
ENV HOME=/home/node

RUN /usr/bin/apt-get update \
  && /usr/bin/apt-get install -y --no-install-recommends util-linux \
  && /usr/bin/rm -rf /var/lib/apt/lists/*
RUN /usr/bin/mkdir -p /state

COPY --from=build --chown=0:0 --chmod=0555 /repo/bots/quoter-bot/package.json /repo/bots/quoter-bot/package.json
COPY --from=build --chown=0:0 --chmod=0555 /repo/bots/quoter-bot/dist /repo/bots/quoter-bot/dist

# Railway must start the container as root so the entrypoint can repair its root-owned mount. The
# entrypoint stays root only long enough to chown the volume, then setpriv atomically execs the bot
# without root identities or capabilities — runtime configuration may include a funded maker key.
COPY --chown=0:0 --chmod=0555 bots/quoter-bot/scripts/railway-entrypoint.sh /usr/local/sbin/railway-entrypoint.sh
WORKDIR /repo/bots/quoter-bot
CMD ["/usr/local/sbin/railway-entrypoint.sh", "start", "--verbose"]
