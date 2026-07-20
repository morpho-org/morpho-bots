# morpho-bots

Off-chain Morpho curator bots — reallocators, liquidation monitors, and similar —
and the shared packages they consume.

This is a [pnpm workspaces](https://pnpm.io/workspaces) monorepo:

- `bots/` — individual bot apps (one per bot); each keeps its own `docs/`
- `packages/` — shared libraries (`@repo/bot-kit`, `@repo/swaps`, `@repo/contracts`,
  `@repo/utils`, `@repo/typescript-config`)

## Getting started

```sh
nvm use         # Node 24.14.1 (see .nvmrc)
pnpm install
```

## Daily commands

```sh
pnpm run lint        # oxlint, repo-wide
pnpm run lint:fix    # oxlint with --fix
pnpm format          # oxfmt, repo-wide
pnpm run knip        # dead-code detection
pnpm test           # vitest
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

- `bots/midnight-liquidation/README.md` — how to run the Midnight liquidation bot and how it works
  end to end
- `bots/blue-liquidation/README.md` — how to run the Morpho Blue liquidation bot and how it works
  end to end

## License

[Apache-2.0](./LICENSE) © 2026 Morpho Association
