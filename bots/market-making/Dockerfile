# syntax=docker/dockerfile:1
# The build context is the repository root so every workspace dependency remains available.
FROM oven/bun:1.3.12-slim
WORKDIR /repo

COPY package.json bun.lock bunfig.toml ./
COPY packages ./packages
COPY bots ./bots
RUN bun install --frozen-lockfile

WORKDIR /repo/bots/market-making
CMD ["bun", "run", "start", "--", "start", "--verbose"]
