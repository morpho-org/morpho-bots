# curator-bots

Off-chain Morpho curator bots — reallocators, liquidation monitors, kill-switch
bots, and similar — and the shared packages they consume.

This is a [bun workspaces](https://bun.com/docs/install/workspaces) monorepo:

- `bots/` — individual bot apps (one per bot)
- `packages/` — shared libraries (e.g. `@repo/typescript-config`, `@repo/utils`,
  `@repo/abis`)

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

- `CLAUDE.md` — agent and contributor conventions (Strict Rules, agent team,
  self-verification ritual)
- `docs/CONVENTIONS.md` — code organization, patterns, and style
- `docs/GUIDANCE.md` — when to write a TIB, when to file a Linear ticket
- `docs/decisions/` — TIBs (Technical Intent Briefs)
- `docs/templates/` — TIB and data-flow doc templates

Bot docs:

- `bots/midnight-liquidation/README.md` — how to run the Midnight liquidation bot and how it works
  end to end
