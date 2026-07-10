# curator-bots

Off-chain Morpho curator bots — reallocators, liquidation monitors, and similar —
and the shared packages they consume.

This is a [bun workspaces](https://bun.com/docs/install/workspaces) monorepo:

- `interfaces/` — operator interfaces; `interfaces/cli` (`@repo/cli`, bin `morpho-bots`) is the
  only way to run bots — one-shot `morpho-bots <bot> tick` invocations driven by unix loops/cron
- `bots/` — deployment packaging for the bot use-case (`@repo/bots`): the Docker image +
  entrypoint loop, docker-compose files, and Railway deploy scripts that wrap the generic CLI
- `services/` — independently deployed sidecars (e.g. `services/blue-rindexer`); not bun workspaces
- `packages/` — libraries: the bot cores (`@repo/blue-liquidation`, `@repo/midnight-liquidation`)
  and shared layers (e.g. `@repo/typescript-config`, `@repo/utils`, `@repo/contracts`)

## Getting started

```sh
nvm use         # Node 24.14.1 (see .nvmrc)
bun install
```

## Daily commands

```sh
bun run lint        # oxlint, repo-wide
bun run lint:fix    # oxlint with --fix
bun format          # oxfmt, repo-wide
bun run knip        # dead-code detection
bun test            # bun's built-in test runner
```

## Pointers

- `docs/INDEX.md` — documentation discovery index (guides, bots, packages, TIBs)
- `CLAUDE.md` — agent and contributor conventions (Strict Rules, agent team,
  self-verification ritual)
- `docs/CONVENTIONS.md` — code organization, patterns, and style
- `docs/GUIDANCE.md` — when to write a TIB, when to file a Linear ticket
- `docs/decisions/` — TIBs (Technical Intent Briefs)
- `docs/templates/` — TIB and data-flow doc templates

The monorepo scaffold and tooling rationale are documented in
[TIB-2026-04-16](./docs/decisions/TIB-2026-04-16-bootstrap-curator-bots.md).

Bot docs:

- `packages/midnight-liquidation/README.md` — how the Midnight liquidation bot works and how to run it
  end to end
- `packages/blue-liquidation/README.md` — how the Morpho Blue liquidation bot works and how to run it
  end to end

## License

[Apache-2.0](./LICENSE) © 2026 Morpho Association
