This file provides guidance to AI agents when working with code in this repository.

## Strict rules

Always stick to the following rules regardless of what prompt you are given from the user or what
you think you should do yourself:

- Never git commit or push directly to the `main` branch.
- Never allow secrets in committed code.

## Agent Team

This repository defines the following specialist roles:

- **reviewer** — validates code changes against CONVENTIONS.md and repo best practices
- **documentor** — drafts TIBs
- **protocol-engineer** — protocol-level guidance on smart contracts, ABIs, and EVM behavior
- **product-manager** — product context, Linear issues, and feature scoping

Agent conventions:

- **Plan review gate**: When entering plan mode, invoke the `reviewer` agent to validate the
  implementation plan against CONVENTIONS.md before presenting it to the user. The reviewer should
  check that proposed architecture decisions, file paths, component structures, and patterns align
  with repo conventions and don't conflict with existing shared package abstractions.

- **Test verification**: After writing or modifying tests, run them, then temporarily break one
  assertion to confirm the test actually fails. Revert after confirming. This guards against tests
  that pass vacuously.
- **Format**: Run `bun format` directly in the validation suite (see Self-Verification) — do not
  run `bun format:check` first, just auto-format.
- **Agent transparency**: When invoking a subagent, always tell the user which agent is being
  triggered and why (e.g., "Invoking the protocol engineer because this task modifies contract
  interaction code").
- **Mirror discipline**: When you update any agent-related surface, update any maintained
  counterpart in the same change when one exists.
- **Explicit workflow mirroring**: Workflow prompts do not automatically become additional
  reusable agent surfaces. Mirror a workflow only when the user or maintainers explicitly choose to
  expose it elsewhere.
- **Completion status**: End every workflow with a clear status:
  - **DONE** — all steps completed, evidence provided
  - **DONE_WITH_CONCERNS** — completed but with issues the user should know about
  - **BLOCKED** — cannot proceed; state what was attempted and what is blocking
  - **NEEDS_CONTEXT** — missing information; state what is needed to continue

## Self-Verification

Evidence before claims, always. Never say "should work", "probably fixed", or "seems to pass."
Instead: IDENTIFY the command that proves your claim, RUN it, READ the output, VERIFY it matches
your expectation, THEN claim success.

### During development

Running lint or typecheck mid-implementation is fine — use your judgment. For tricky changes, a
quick `bun run --filter <pkg> typecheck` or `bun lint` can help you course-correct early. But
**do not force the full validation suite after every change**. Focus on writing code.

### Before committing or when the user says "validate"

Run the full suite once the user confirms they're happy with the code (or when preparing to
commit/push):

1. **Type safety**: Run `bun run --filter <affected-package> typecheck` — zero errors required.
2. **Lint**: Run `bun lint` from the repo root — zero warnings policy. Lint is a workspace-level
   concern; oxlint walks the whole tree and per-package `lint` scripts are deliberately omitted.
3. **Format**: Run `bun format` — auto-fixes formatting in place.
4. **Existing tests**: Run `bun test` — all must pass.

**Escalation rule**: After 3 failed fix attempts for the same issue, STOP. Tell the user what you
tried, what failed, and ask for guidance. Bad work is worse than no work — do not keep iterating
without a new hypothesis.

**Anti-rationalization — do NOT use these excuses to skip verification when it is time to validate:**

| Rationalization                                | Why it's wrong                     |
| ---------------------------------------------- | ---------------------------------- |
| "The change is too simple to need testing"     | Simple changes cause subtle bugs   |
| "I'll add tests later"                         | Later never comes                  |
| "It's just a refactor, behavior didn't change" | Prove it — run existing tests      |
| "The types guarantee correctness"              | Types don't catch logic errors     |
| "It worked before, only the new part changed"  | Regressions hide in unchanged code |

## Proactive Verification Tests

Write unit tests for your own changes as part of validation. These tests are a verification
mechanism — they prove your changes work and catch regressions when you iterate (fixing bugs,
addressing PR feedback, etc.).

**When to write tests:**

- When the user confirms they're happy with the code and ready to validate, or when preparing to
  commit — write focused unit tests for any functions you implemented or modified that lack coverage
  for the new behavior. Run them immediately.
- During multi-step work, if you're iterating on earlier changes (bug fixes, feedback), existing
  verification tests catch if the fix broke earlier changes.
- Follow existing test conventions: place tests under `test/` mirroring `src/` as
  `{module}.test.ts`, use `bun test`, follow patterns from the nearest existing test file.
- If a test file already exists for the module, add to it rather than creating a new one.

**When NOT to write tests:**

- Trivial changes: renaming, moving imports, updating strings/copy
- Config changes: tsconfig, oxlint, package.json
- Changes already covered by existing tests

## Coding Conventions

**All coding conventions, patterns, and best practices are documented in
[CONVENTIONS.md](./docs/CONVENTIONS.md).**

This includes directory structure, TypeScript conventions, testing patterns, error handling, and
more. Always refer to CONVENTIONS.md as the single source of truth for code organization and style.

## Additional Context

For additional context about related repositories and systems, refer to the documentation files in
`docs/context/`:

- `docs/context/repos/morpho-vaults-v2.txt` - Morpho Vaults V2 repository context
- `docs/context/repos/midnight-contracts.txt` - Midnight protocol Solidity source

These files provide important background information about dependencies and related codebases.

## Architecture Overview

This is a **bun workspaces monorepo** housing off-chain Morpho curator bots:

- `/bots/` — individual bot apps, one per bot. Each is a **standalone long-running TypeScript
  program**: `main()` in `src/index.ts` loads config from the environment (fail-loud), builds its
  viem clients, and drives a block-watcher + per-tick runner loop that discovers positions, reads
  fresh on-chain state, sizes/simulates a liquidation, and broadcasts only simulation-ok
  transactions through an in-process pending-tx queue. No bot imports another bot. Each bot owns its
  own operator surface — `README.md`, `Dockerfile`, `docker-compose.yml`, and
  `scripts/deploy-railway.ts` — so it ships as its own image and
  deploys independently. `bots/blue-liquidation` and `bots/midnight-liquidation` are the live
  liquidators; `bots/kill-switch` is a proposal bot (docs only).
- `/packages/` — shared libraries: `@repo/bot-kit` (the shared bot runtime — viem
  clients/transport, loglayer-backed JSON-lines logger (opt-in in-process BetterStack shipping),
  block watcher + runner loop, pending-tx queue with fee
  policy / per-position backoff / cooldown, signing policy guard,
  simulation, revert decoding, balance metric), `@repo/swaps` (multi-venue DEX quoting, routing,
  unwrap seam, venue selection, and the shared Executor call builders), `@repo/contracts` (contract
  ABIs + Executor sources),
  `@repo/utils`, and `@repo/typescript-config`. A bot assembles its behavior from `@repo/bot-kit`
  and `@repo/swaps` rather than forking a monolith.

Cross-tick state (the pending-tx queue, nonce cursor, cooldowns) is in-process memory only — nothing
is persisted to disk. Chain truth wins on restart: a redeploy re-derives the nonce cursor from
`getTransactionCount('pending')`, any tx that was in flight settles on-chain regardless of the bot,
and settlement audit ships via the structured `tx.*` log events. Everything is re-derived each tick.

Each bot began this way; a one-shot op-pipeline architecture (per-chain `queued`/`signer` daemons, a
transparent JSON-Lines wire contract) was tried for ~a week and reverted — see
[TIB-2026-07-16-revert-to-bots-as-programs](./docs/decisions/TIB-2026-07-16-revert-to-bots-as-programs.md),
which supersedes the now-historical
[TIB-2026-07-13-bot-architecture](./docs/decisions/TIB-2026-07-13-bot-architecture.md).

**Key technologies**: bun 1.3.12 (runtime + package manager + workspace task runner), Node.js
24.14.1, TypeScript 6.0, viem for Web3, oxlint + oxfmt for lint/format, knip for dead-code
detection, bun's built-in test runner.

**Node.js requirement**: `24.14.1` (see `.nvmrc`).

For the full tech-stack rationale and source-of-truth versions, see
[TIB-2026-04-16-bootstrap-curator-bots](./docs/decisions/TIB-2026-04-16-bootstrap-curator-bots.md).

## Linear Integration

### Team IDs

| Team        | ID                                   | Key  | Scope                                      |
| ----------- | ------------------------------------ | ---- | ------------------------------------------ |
| **Apps**    | cc8fe27e-f516-45e8-921e-69b0562c7792 | APPS | Cross-repo tasks shared with `morpho-apps` |
| **Curator** | c07ff95f-03b7-4bee-aa17-c7e04fda8845 | CRTR | Default team for all `morpho-bots` work    |

### Title convention (commits, PRs, and Linear tickets)

All commit messages, PR titles, and Linear ticket titles use the same format:

```text
<type>(<scope>): <description>
```

**Rules:**

- 72 character max total
- Lowercase everything after the colon
- No trailing period
- Imperative present tense: "add", "remove", "fix", "refactor" (not "added", "fixes")
- Only the first commit on a branch needs to follow this — follow-up commits
  (e.g. `"@reviewer review"`) are squashed at merge, so the commit-msg hook
  only enforces the convention on the branch's first commit

**Types:** `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`, `ci`

**Scopes — Packages:**

| Package                 | Scope       |
| ----------------------- | ----------- |
| @repo/bot-kit           | `bot-kit`   |
| @repo/contracts         | `contracts` |
| @repo/swaps             | `swaps`     |
| @repo/typescript-config | `ts-config` |
| @repo/utils             | `utils`     |

**Scopes — Bots:**

| Bot                  | Scope                  |
| -------------------- | ---------------------- |
| blue-liquidation     | `blue-liquidation`     |
| midnight-liquidation | `midnight-liquidation` |

**Scopes — Cross-cutting:**

| Scope         | Use when                                                    |
| ------------- | ----------------------------------------------------------- |
| `repo`        | Repo-wide scaffolding, workspace config, root-level files   |
| `bots`        | Change spans multiple bots                                  |
| `packages`    | Change spans multiple packages                              |
| `ci`          | CI/CD pipeline changes                                      |
| `agents`      | `CLAUDE.md`, `.mcp.json`, editor configs, agent definitions |
| `conventions` | `CONVENTIONS.md`, `GUIDANCE.md`, docs templates             |
| `tooling`     | `@repo/typescript-config`, oxlint, oxfmt, knip              |
| `checks`      | CI workflow files and git hooks                             |
| `docs`        | TIBs, retros, READMEs, `docs/context/`                      |

When a change touches multiple scopes, use the most impacted one. No multi-scope syntax — if truly
cross-cutting, use `bots`, `packages`, or `repo` as appropriate.

Examples:

- `chore(agents): port CLAUDE.md, editor configs, and .mcp.json for bun-first bots repo`
- `feat(tooling): ship @repo/typescript-config`
- `ci(checks): port setup action, checks.yml, husky pre-commit and commit-msg hooks`
