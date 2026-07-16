# syntax=docker/dockerfile:1
# Bun-workspace image for the midnight-liquidation bot. The build context MUST be the repo root so the
# workspace packages (packages/*) resolve — docker-compose.yml sets `context: ../..` and the Railway
# deploy runs `railway up` from the repo root. Borrower discovery polls the markets
# liquidation-candidates HTTP API, so there is no indexer/database sidecar to build.

# Pinned Vector binary for the OPTIONAL BetterStack log-forwarding side-car (vector.yaml). Copied
# into the runtime image below so apt never runs in the final layer. Bump this exact tag to upgrade
# Vector; the `vector --version` check below fails the build if the binary can't run here. Inert
# unless BETTERSTACK_SOURCE_TOKEN is set (see docker-entrypoint.sh).
FROM timberio/vector:0.57.0-debian AS vector

FROM oven/bun:1.3.12-slim
WORKDIR /repo

# Bake the bot identity so vector.yaml's VRL can stamp `bot` on every forwarded line (CHAIN_ID is set
# per-service). The optional log-forwarding side-car binary: the HTTP sink uses TLS, so
# `vector --version` proves it resolves its shared libs in this slim base at BUILD time.
ENV BOT=midnight
COPY --from=vector /usr/bin/vector /usr/bin/vector
RUN vector --version

# Manifests + workspace members first, so `bun install` is layer-cached. All members' package.json are
# needed for bun to resolve the `workspace:*` links.
COPY package.json bun.lock bunfig.toml ./
COPY packages ./packages
COPY bots ./bots
RUN bun install --frozen-lockfile

# `vector validate` compiles the config + VRL at BUILD time (dummy creds satisfy the ${...}
# placeholders; --no-environment skips the live BetterStack connection), so a config or VRL typo
# fails the build, not a running bot. Vector 0.57 disabled ${...} env interpolation by default;
# VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION re-enables it (safe here: config baked read-only, vars
# operator-set). The runtime launch in the entrypoint sets the same flag.
RUN BETTERSTACK_INGESTING_HOST=example.invalid BETTERSTACK_SOURCE_TOKEN=validate-only \
  VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION=true \
  vector validate --no-environment bots/midnight-liquidation/vector.yaml

# Run the bot from its package dir. The entrypoint fans stdout+stderr to a spool and starts Vector
# when forwarding is enabled, then execs `bun run start` (which builds workspaces via `prestart`,
# then runs src/index.ts). Inert (identical to `bun run start`) when BETTERSTACK_SOURCE_TOKEN is unset.
WORKDIR /repo/bots/midnight-liquidation
CMD ["/repo/bots/midnight-liquidation/docker-entrypoint.sh"]
