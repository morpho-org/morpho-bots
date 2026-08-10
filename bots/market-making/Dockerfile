# syntax=docker/dockerfile:1
# pnpm-workspace image for the market-making bot. The build context MUST be the repo root so the
# workspace packages (packages/*) resolve — docker-compose.yml sets `context: ../..`, the
# deploy-market-making GitHub Actions workflow builds from the repo root for Docker Hub, and
# scripts/deploy-railway.ts points Railway at this file via RAILWAY_DOCKERFILE_PATH. State is
# on-chain plus the Morpho/Router APIs, so there is no indexer/database sidecar to build.
#
# pnpm owns installs, but bun is still the runtime, so this image carries both (the same pattern as
# the liquidator images): the base is Node because pnpm is activated through corepack, which the
# oven/bun images do not provide; bun comes in as a single copied binary.
FROM node:24.14.1-slim
COPY --from=oven/bun:1.3.12-slim /usr/local/bin/bun /usr/local/bin/bun
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# The container's environment holds the maker key, so nothing here may run as root. Corepack's pnpm
# shim lands in /usr/local/bin, which only root may write, so enable it before dropping privileges.
# /state is the XDG_STATE_HOME mount point for durable offer-group ownership: it must exist owned
# by `node` so a fresh named volume inherits writable ownership. Every layer after `USER node` is
# unprivileged.
RUN corepack enable pnpm
RUN mkdir -p /repo /state && chown node:node /repo /state
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

# The entrypoint is the `mm` CLI itself, so the container command selects the subcommand and flags
# (e.g. `--readonly setup-check`, `--config /config/market-making.yaml start`). Configuration comes
# from environment variables and/or a mounted YAML file; a set variable overrides its YAML value.
# The workdir is the package dir, so default discovery also finds a market-making.yaml mounted
# there. The default command is the verbose combined setup, bootstrap, and ladder monitor — Railway
# runs this CMD as provisioned by scripts/deploy-railway.ts.
#
# Durable offer-group ownership state lives under XDG_STATE_HOME (see the *-group-ownership utils).
# Pin it to the /state mount point: writer deployments MUST mount a volume there (Railway
# provisions one; compose declares one), or a recreated container forgets which live on-chain offer
# groups the bot owns.
ENV XDG_STATE_HOME=/state
WORKDIR /repo/bots/market-making
ENTRYPOINT ["bun", "src/index.ts"]
CMD ["start", "--verbose"]
