# syntax=docker/dockerfile:1
# Bun-workspace image for the market-making bot. The build context MUST be the repo root so the
# workspace packages (packages/*) resolve — docker-compose.yml sets `context: ../..` and
# scripts/deploy-docker-hub.ts builds from the repo root. State is on-chain plus the Morpho/Router
# APIs, so there is no indexer/database sidecar to build.
FROM oven/bun:1.3.12-slim
WORKDIR /repo

# Manifests + workspace members first, so `bun install` is layer-cached. All members' package.json are
# needed for bun to resolve the `workspace:*` links.
COPY package.json bun.lock bunfig.toml ./
COPY packages ./packages
COPY bots ./bots
RUN bun install --frozen-lockfile

# The entrypoint is the `mm` CLI itself, so the container command selects the subcommand and flags
# (e.g. `--readonly setup-check`, `--config /config/market-making.yaml start`). Configuration comes
# from environment variables and/or a mounted YAML file; a set variable overrides its YAML value.
# The workdir is the package dir, so default discovery also finds a market-making.yaml mounted there.
WORKDIR /repo/bots/market-making
ENTRYPOINT ["bun", "src/index.ts"]
CMD ["start"]
