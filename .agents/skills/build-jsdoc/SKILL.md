---
name: build-jsdoc
description: Use when changing externally facing TypeScript in the market-making bot. Inventory public callables, enforce substantive JSDoc, and build browsable TypeDoc output before completion.
version: 1.1.0
author: Morpho
license: Apache-2.0
metadata:
  hermes:
    tags: [typescript, jsdoc, typedoc, market-making, verification]
    related_skills: []
---

# Build Market-Making JSDoc

## Overview

Use the package-owned TypeScript AST inventory and TypeDoc configuration to keep the market-making
public surface documented. The build treats TypeDoc warnings as errors and writes ignored, browsable
HTML; generated output is verification evidence, not a committed artifact.

## When to Use

- Any change to an exported function, class, interface, or type under
  `bots/market-making/src/**`.
- Any change to a public constructor, method, accessor, or exported callable signature.
- Before completing market-making work that could alter runtime/package boundaries.

Do not use this workflow to document private implementation helpers unless their safety behavior cannot
be understood from the public contract.

## Canonical Files and Symlinks

`.agents/skills/build-jsdoc/SKILL.md` is canonical. `.claude/skills` is required exposure and must be
a real symlink to `../.agents/skills`; never create a divergent file or directory copy under
`.claude`. Preserve the existing `.claude` directory and create only its `skills` entry. `AGENTS.md`
points to `CLAUDE.md`, so edit `CLAUDE.md` once and preserve the link.

Verify before editing:

```sh
test -L .claude/skills
test "$(readlink .claude/skills)" = ../.agents/skills
readlink AGENTS.md
stat .agents/skills .claude AGENTS.md CLAUDE.md
```

Completion criterion: `.claude/skills` exists as mode `120000`, reads `../.agents/skills`, resolves to
the canonical tree, and `AGENTS.md` resolves to `CLAUDE.md`.

## Install and Build

Use the repository-pinned pnpm version from `packageManager` (`pnpm@11.1.1`), activated through
corepack:

```sh
pnpm install --frozen-lockfile
pnpm --filter @morpho-org/market-making-bot run jsdoc:check
pnpm --filter @morpho-org/market-making-bot run jsdoc:build
```

- Coverage command: `jsdoc:check`
- TypeDoc config: `bots/market-making/typedoc.json`
- Output: `bots/market-making/build/jsdoc/index.html`
- Output policy: `build/` is ignored; do not stage generated HTML.

Completion criterion: the AST inventory exits zero, TypeDoc emits zero warnings/errors, and
`build/jsdoc/index.html` exists.

## Public-Surface Inventory

The coverage script inventories these market-making boundary and utility files:

- `src/application/operator-error-name.utils.ts`
- `src/application/bootstrap/position-bootstrap-halted.error.ts`
- `src/application/bootstrap/position-bootstrap.service.ts`
- `src/application/ladder/ladder-cycle-halted.error.ts`
- `src/application/ladder/ladder-market-maker.service.ts`
- `src/application/ladder/ladder-market-maker.utils.ts`
- `src/application/setup/setup-check.service.ts`
- `src/application/setup/setup-check.utils.ts`
- `src/application/setup/safe-provider.error.ts`
- `src/application/setup/setup-failed.error.ts`
- `src/application/version.service.ts`
- `src/bootstrap.ts`
- `src/config/config-file.error.ts`
- `src/config/config-source.utils.ts`
- `src/config/config-validation.error.ts`
- `src/config/config.service.ts`
- `src/config/config.utils.ts`
- `src/domain/bootstrap/bootstrap-configuration.error.ts`
- `src/domain/bootstrap/position-bootstrap.ts`
- `src/domain/ladder/ladder-configuration.error.ts`
- `src/domain/ladder/ladder.ts`
- `src/infrastructure/bootstrap/bootstrap-hard-halt.error.ts`
- `src/infrastructure/bootstrap/bootstrap-exposure.utils.ts`
- `src/infrastructure/bootstrap/bootstrap-make.service.ts`
- `src/infrastructure/bootstrap/bootstrap-offer.utils.ts`
- `src/infrastructure/bootstrap/bootstrap-adapter.error.ts`
- `src/infrastructure/bootstrap/bootstrap-group-ownership.utils.ts`
- `src/infrastructure/bootstrap/bootstrap-groups.utils.ts`
- `src/infrastructure/bootstrap/bootstrap-position.service.ts`
- `src/infrastructure/bootstrap/bootstrap-reference-rate.service.ts`
- `src/infrastructure/bootstrap/bootstrap-requirements.utils.ts`
- `src/infrastructure/bootstrap/bootstrap-transaction.utils.ts`
- `src/infrastructure/bootstrap/production-bootstrap.ts`
- `src/infrastructure/cli/cli-usage.error.ts`
- `src/infrastructure/cli/cli.ts`
- `src/infrastructure/cli/market-making-entrypoint.ts`
- `src/infrastructure/make/read-only-bootstrap-make.service.ts`
- `src/infrastructure/make/read-only-ladder-make.service.ts`
- `src/infrastructure/make/read-only-make.utils.ts`
- `src/infrastructure/setup-state/http-json.utils.ts`
- `src/infrastructure/setup-state/provider-pagination.error.ts`
- `src/infrastructure/setup-state/provider-read.error.ts`
- `src/infrastructure/setup-state/provider-read.utils.ts`
- `src/infrastructure/setup-state/provider-response.error.ts`
- `src/infrastructure/setup-state/viem-setup-state.service.ts`
- `src/infrastructure/setup-state/viem-setup-state.utils.ts`
- `scripts/js-doc-validation.error.ts`
- `scripts/bundle-failed.error.ts`

It checks exported functions/classes/interfaces/type aliases, interface methods, callable members of
exported type literals, and public constructors/methods/accessors. Every listed declaration needs a
substantive `/** ... */` block. The checker requires a non-filler summary, exact `@param` names,
`@returns` for non-void callables, and `@throws` at its provider-boundary rule. Scoped rules also
enforce read-only, aggregate-deadline, and `Promise.all` concurrency semantics. Do not satisfy
coverage with a restatement of the declaration.

## TypeScript Utility and SDK Discipline

- Keep every utility function out of files containing classes; move it to a focused `*.utils.ts` or
  dedicated module.
- Write every utility as an arrow constant, never a function declaration.
- Prefer viem validation and conversion utilities (`isAddress`, `getAddress`, `isAddressEqual`,
  `isHex`, `size`, `keccak256`, and typed conversions) over equivalent local parsing.
- Inspect installed `@morpho-org/midnight-sdk` and Morpho SDK exports and source before reuse. Import
  only APIs that exist and preserve semantics. Record why any protocol ABI/entity/parser remains
  local; never add a dependency for an imagined export.

Completion criterion: no named utility function declaration remains in changed source, no utility
shares a file with a class, and each protocol/viem reuse or local exception is evidenced in code or
the change report.

For the current market-making implementation, preserve these verified package boundaries:

- `@morpho-org/midnight-sdk@1.3.0/api` owns active-book URL construction and mapping through
  `MidnightApi.fetchBooks`; inject the package's sanitized timeout-aware fetch adapter.
- `@morpho-org/morpho-sdk@5.4.1/abis` owns Morpho Blue's `blueAbi`; do not recreate a local
  `idToMarketParams` / `market` ABI subset.
- Midnight SDK 1.3.0 has no `/users/{maker}/offer-groups` client, entity, or mapper. Keep only the
  local cursor/deadline/page/item guard and strict nested-offer projection until an equivalent SDK
  export exists; never substitute `fetchTakeableOffers`, because it omits fresh active offers whose
  takeable amount has not been measured.

Completion criterion: package source/exports still support each imported symbol, the active-offer
source remains complete, and every local exception has a concrete missing-SDK-export justification.

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
4. If installation changes unrelated lockfile entries, restore them and reinstall with pnpm 11.1.1.
5. If generated HTML is staged, unstage and delete it; only source, config, script, dependency, and
   lockfile changes belong in the PR.

## Verification Checklist

- [ ] Pinned pnpm install succeeds with the lockfile frozen.
- [ ] AST coverage prints the exhaustive public declaration inventory and exits zero.
- [ ] TypeDoc exits zero with warnings-as-errors enabled.
- [ ] `bots/market-making/build/jsdoc/index.html` exists and is non-empty.
- [ ] Generated output is ignored and absent from `git status`.
- [ ] Public docs explain failure, side-effect, timeout/deadline, and concurrency behavior where relevant.
- [ ] Independent checks still run concurrently through `Promise.all` where possible.
- [ ] `.claude/skills` is a real `../.agents/skills` symlink and `AGENTS.md` resolves to `CLAUDE.md`.
