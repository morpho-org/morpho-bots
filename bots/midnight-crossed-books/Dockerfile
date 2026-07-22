# syntax=docker/dockerfile:1
FROM oven/bun:1.3.12-slim
WORKDIR /repo
COPY package.json bun.lock bunfig.toml ./
COPY packages ./packages
COPY bots ./bots
RUN bun install --frozen-lockfile
WORKDIR /repo/bots/midnight-crossed-books
CMD ["bun", "run", "start"]
