---
name: build-jsdoc
description: Use when changing externally facing TypeScript in the market-making bot. Inventory public callables, enforce substantive JSDoc, and build browsable TypeDoc output before completion.
version: 1.0.0
author: Morpho
license: Apache-2.0
metadata:
  hermes:
    tags: [typescript, jsdoc, typedoc, market-making, verification]
    related_skills: []
---

# Build Market-Making JSDoc

## Overview

Use the package-owned TypeScript AST inventory and TypeDoc configuration to keep the MKT-1459
setup-check public surface documented. The build treats TypeDoc warnings as errors and writes ignored,
browsable HTML; generated output is verification evidence, not a committed artifact.

## When to Use

- Any change to an exported function, class, interface, or type under
  `bots/market-making/src/**`.
- Any change to a public constructor, method, accessor, or exported callable signature.
- Before completing market-making work that could alter runtime/package boundaries.

Do not use this workflow to document private implementation helpers unless their safety behavior cannot
be understood from the public contract.

## Canonical Files and Symlinks

`.agents/skills/build-jsdoc/SKILL.md` is canonical. Keep any `.claude` exposure as a symlink to the
canonical `.agents` tree; never create a divergent copy under `.claude`. Some historical checkouts,
including the MKT-1459 branch point, have a regular `.claude` directory and no `.claude/skills` link;
do not overwrite that directory. `AGENTS.md` points to `CLAUDE.md`, so edit `CLAUDE.md` once and
preserve the link.

Verify before editing:

```sh
test ! -e .claude/skills || readlink .claude/skills
readlink AGENTS.md
stat .agents/skills .claude AGENTS.md CLAUDE.md
```

Completion criterion: no divergent `.claude` skill copy exists, any existing `.claude/skills` link
resolves to `.agents/skills`, and `AGENTS.md` resolves to `CLAUDE.md`.

## Install and Build

Use the repository-pinned Bun version from `packageManager` (`bun@1.3.12`):

```sh
bun install --frozen-lockfile
bun run --filter @morpho-org/market-making-bot jsdoc:check
bun run --filter @morpho-org/market-making-bot jsdoc:build
```

- Coverage command: `jsdoc:check`
- TypeDoc config: `bots/market-making/typedoc.json`
- Output: `bots/market-making/build/jsdoc/index.html`
- Output policy: `build/` is ignored; do not stage generated HTML.

Completion criterion: the AST inventory exits zero, TypeDoc emits zero warnings/errors, and
`build/jsdoc/index.html` exists.

## Public-Surface Inventory

The coverage script inventories these setup-check boundary files:

- `src/application/setup-check.service.ts`
- `src/bootstrap.ts`
- `src/config/config.service.ts`
- `src/infrastructure/cli/cli.ts`
- `src/infrastructure/setup-state/viem-setup-state.service.ts`

It checks exported functions/classes/interfaces/type aliases, interface methods, callable members of
exported type literals, and public constructors/methods/accessors. Every listed declaration needs a
substantive `/** ... */` block. Public callables should document applicable `@param`, `@returns`, and
`@throws` contracts plus read/write side effects, redaction/failure semantics, deadlines, and
`Promise.all` concurrency. Do not satisfy coverage with a restatement of the declaration.

When adding another boundary file, add it to both `scripts/check-jsdoc.ts` and `typedoc.json` in the
same change. Completion criterion: the command's printed inventory contains every added public
callable exactly once.

## Inspect Generated Docs

```sh
test -s bots/market-making/build/jsdoc/index.html
python3 -m http.server 8000 --directory bots/market-making/build/jsdoc
```

Open `http://127.0.0.1:8000/` and inspect the setup-check service, state port, viem adapter,
configuration, CLI, and composition-root pages. Search generated files only for public declaration
names; never copy environment values or execute the bot to generate docs.

Completion criterion: the public setup-check pages are navigable and contain no private key, provider
URL, default runtime environment, raw provider response, or generated source-map secret.

## Failure Handling

1. If `jsdoc:check` fails, use its complete declaration list to add or improve JSDoc; do not weaken the
   inventory or minimum-substance check to make it pass.
2. If TypeDoc warns about an undocumented exported reflection, document it or give the public API an
   explicit documented return type. Do not disable warnings-as-errors.
3. If TypeDoc warns about a private implementation alias, keep the alias private and avoid exposing it
   through an inferred public signature; prefer an explicit exported boundary type.
4. If installation changes unrelated lockfile entries, restore them and reinstall with Bun 1.3.12.
5. If generated HTML is staged, unstage and delete it; only source, config, script, dependency, and
   lockfile changes belong in the PR.

## Verification Checklist

- [ ] Pinned Bun install succeeds with the lockfile frozen.
- [ ] AST coverage prints the exhaustive public declaration inventory and exits zero.
- [ ] TypeDoc exits zero with warnings-as-errors enabled.
- [ ] `bots/market-making/build/jsdoc/index.html` exists and is non-empty.
- [ ] Generated output is ignored and absent from `git status`.
- [ ] Public docs explain failure, side-effect, timeout/deadline, and concurrency behavior where relevant.
- [ ] Independent checks still run concurrently through `Promise.all` where possible.
- [ ] No divergent `.claude` skill exists; any skill link and the `AGENTS.md` link resolve canonically.
