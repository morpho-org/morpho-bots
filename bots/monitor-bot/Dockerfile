# syntax=docker/dockerfile:1
# Build context MUST be the repo root (see docker-compose.yml `context: ../..`) so the bun
# workspace (packages/*) resolves.
FROM oven/bun:1.3.12-slim

WORKDIR /repo

COPY package.json bun.lock bunfig.toml ./
COPY packages ./packages
COPY bots ./bots

RUN bun install --frozen-lockfile

WORKDIR /repo/bots/monitor-bot

EXPOSE 3000

CMD ["bun", "run", "start"]
