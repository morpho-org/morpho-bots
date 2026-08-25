# syntax=docker/dockerfile:1
# Image for the quoter-signer KMS signing policy middleware (TIB-2026-08-12). The build context
# MUST be the repository root so workspace packages resolve. Node only: pnpm installs, esbuild
# bundles, the AWS Lambda Node.js runtime loads the bundle.
#
# Two stages so the shipped image carries only this service: `build` installs the workspace and
# bundles the handler; the runtime stage is the AWS Lambda Node.js base image (Runtime Interface
# Client, plus the Runtime Interface Emulator for local runs) and receives nothing but the
# self-contained bundle. The image publishes publicly (morphoorg/quoter-signer), so no bot's code,
# no workspace source, and no package manager may ship in the final stage.
FROM node:24.14.1-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
ENV HOME=/home/node

# Corepack writes its pnpm shim to /usr/local/bin, so enable it while still root.
RUN /usr/local/bin/corepack enable pnpm
RUN /usr/bin/mkdir -p /repo && /usr/bin/chown node:node /repo

# Install dependencies and run the workspace build without root privileges. The official image
# owns /home/node, so Corepack and pnpm can write their user-level cache under HOME.
USER node
WORKDIR /repo

# Manifests first keep the install layer cacheable. `corepack install` fetches the pnpm version
# pinned in package.json#packageManager.
COPY --chown=node:node package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN corepack install

# The frozen lockfile validates the complete workspace importer set, so every workspace project
# must be present even though only the signer is built; nothing outside `services/` survives into
# the runtime stage.
COPY --chown=node:node packages ./packages
COPY --chown=node:node bots ./bots
COPY --chown=node:node services ./services
RUN pnpm install --frozen-lockfile
# Scoped build: the signer plus its workspace dependency closure only — the middleware is the root
# of trust, so its image build does not run every bot's bundler.
RUN pnpm --filter "@morpho-org/quoter-signer..." --if-present run build

# Runtime stage. dist/index.mjs is a self-contained ESM bundle (scripts/build.ts, bundle: true);
# the AWS base image's Node.js runtime resolves the `index.handler` CMD to index.mjs under
# LAMBDA_TASK_ROOT and loads it as ESM. The file stays root-owned and read-only to the sandboxed
# runtime user.
FROM public.ecr.aws/lambda/nodejs:24
ARG GIT_REVISION=""
LABEL org.opencontainers.image.source="https://github.com/morpho-org/morpho-bots"
LABEL org.opencontainers.image.revision="${GIT_REVISION}"

COPY --from=build --chown=0:0 --chmod=0444 /repo/services/quoter-signer/dist/index.mjs ${LAMBDA_TASK_ROOT}/index.mjs
CMD ["index.handler"]
