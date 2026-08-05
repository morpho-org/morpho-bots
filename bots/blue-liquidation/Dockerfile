# syntax=docker/dockerfile:1
# pnpm-workspace image for the blue-liquidation bot. The build context MUST be the repo root so the
# workspace packages (packages/*) resolve — docker-compose.yml sets `context: ../..` and the Railway
# deploy runs `railway up` from the repo root. Borrower discovery polls the Morpho GraphQL API, so
# there is no indexer/database sidecar to build.
#
# pnpm owns installs, but bun is still the runtime, so this image carries both. The base is Node
# because pnpm is activated through corepack, which the oven/bun images do not provide; bun comes in
# as a single copied binary. Both pnpm and bun must stay on PATH in the FINAL image: `start` fires
# `prestart`, which shells out to `pnpm -r run build` to compile @repo/contracts' gitignored dist/.
FROM node:24.14.1-slim
COPY --from=oven/bun:1.3.12-slim /usr/local/bin/bun /usr/local/bin/bun
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /repo

# Manifests first, so the install layer is cached. `corepack install` pre-fetches the pnpm version
# pinned in package.json#packageManager, so no download happens at container start.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml bunfig.toml ./
RUN corepack enable pnpm && corepack install

# All members' package.json are needed for pnpm to resolve the `workspace:*` links.
COPY packages ./packages
COPY bots ./bots
RUN pnpm install --frozen-lockfile

# Run the bot from its package dir (`start` builds workspaces via `prestart`, then runs src/index.ts;
# the bot's own bunfig.toml preload compiles its soltag `sol``` lens templates at startup).
WORKDIR /repo/bots/blue-liquidation
CMD ["bun", "run", "start"]
