# morpho-bots — agent instructions

Off-chain Morpho curator bots. Every bot here is a long-running program that holds a key, signs
transactions, and moves real funds on mainnets with no human approving each action. Optimize for
safe and explainable over clever or fast.

Orientation: [`README.md`](./README.md) for layout and commands,
[`docs/INDEX.md`](./docs/INDEX.md) to find anything,
[`docs/MISSION.md`](./docs/MISSION.md) for why the repo is shaped this way.

## Never

- Commit or push to `main`. Branch first.
- Commit a secret, a private key, or a credentialed RPC URL — or log one.
- Bypass a hook or a signature: no `--no-verify`, no `--no-gpg-sign`, no
  `-c commit.gpgsign=false`. `main` requires signed commits server-side, so an unsigned commit is
  rejected at merge rather than at push. Fix the gpg agent instead.
- Commit plans or scratch write-ups. Durable decisions go to `docs/decisions/`.

## Funds at risk

A change is funds-at-risk when it touches calldata, ABIs, target addresses, signing policy, sizing,
slippage or fee bounds, simulation, nonce handling, or the pending-tx queue. Then:

- Read the exact ABI and the per-bot chain config. Never infer a signature, and never invent an SDK
  export — check the installed package.
- Stay inside `@repo/bot-kit`'s signing, policy, queue, and simulation seams. Broadcasting outside
  them, or without a passing simulation, is a defect and not a shortcut.
- Fail loud and closed on missing or ambiguous config — never default and continue.
- Keep operator-visible errors free of credentials, URLs, and response bodies.
- Say so in your summary, and get a review pass before it merges.

## Working

Understand the real flow first — a small diff in the wrong place is a second bug — then stop at the
first rung that holds:

1. Does it need to exist at all?
2. Does a `@repo/*` package or the Morpho / Midnight SDK already do it?
3. Does viem already do it (Hex and address parsing, equality, hashing, byte size)?
4. Can it be one line?
5. Only then, write the minimum that works.

- Fix the root cause, not the reported path. The ticket names one symptom; grep the other callers of
  whatever you change, because one guard in the shared function is a smaller diff than one per
  caller.
- Shared behavior belongs in `@repo/*`. No bot imports another bot.
- Deletion over addition. No abstraction until a second real caller exists.
- Not lazy about: trust-boundary validation, on-chain safety, logs an operator can reconstruct the
  decision from, and anything explicitly asked for.

## Done

Evidence, not adjectives. Name the command, run it, read the output, then claim it — "should work"
is not a status.

- `pnpm --filter <pkg> run typecheck`, then root `pnpm lint`, `pnpm format`, `pnpm knip`,
  `pnpm test`. Run them when the work is ready, not after every edit.
- Non-trivial new behavior leaves one runnable check behind, under `test/` mirroring `src/`.
- Stop when you are out of hypotheses, not after some number of tries, and say what you tried and
  what is blocking.
- Close with **DONE**, **DONE_WITH_CONCERNS**, **BLOCKED**, or **NEEDS_CONTEXT**, then what changed,
  what you ran, and what risk is left.

## Traps

- **Worktrees** go in `.claude/worktrees/` (gitignored and knip-ignored) or outside the repo.
  Anywhere else inside it, knip walks the copy and false-fails the pre-commit hook.
- **Stacked PRs here are real GitHub stacks** — restack with `gh stack`. Merging `main` into a child
  wedges CI and GitHub keeps reporting the PR dirty.
- **Log field names are a public interface.** BetterStack dashboards parse fields like `label` as
  metric expressions, so renaming one breaks them silently.
- **A lens or soltag change needs `pnpm build`.** The CLI compiles at optimizer runs=1 and degrades
  to an empty ABI while still exiting 0.
- **A new bot's `Dockerfile` must `COPY services/`** — `pnpm install --frozen-lockfile` needs the
  full workspace importer set or the image build fails.
- **Production may not be running `main`.** Check the deployed image before diagnosing a live bot
  from local code.
- **Old TIBs describe roads not taken** — a reverted op-pipeline architecture, a former Bun
  toolchain, rindexer-based discovery. Code and the newest applicable TIB win.

## Elsewhere

| Need                                     | Source of truth                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code style, errors, tests, imports, viem | [`docs/CONVENTIONS.md`](./docs/CONVENTIONS.md)                                                                                                                                                                                                                                                                                                                          |
| What a bot does and how to run it        | that bot's own `README.md`                                                                                                                                                                                                                                                                                                                                              |
| Why the repo is built this way           | [`docs/decisions/`](./docs/decisions/) — newest applicable wins                                                                                                                                                                                                                                                                                                         |
| When to write a TIB, and Linear team IDs | [`docs/GUIDANCE.md`](./docs/GUIDANCE.md)                                                                                                                                                                                                                                                                                                                                |
| Commit and PR titles                     | `type(scope): description`, ≤72 chars, lowercase, no trailing period. Scope is the bot or package directory name (`typescript-config` → `ts-config`), or `repo`, `bots`, `packages`, `ci`, `agents`, `conventions`, `tooling`, `checks`, `docs` when cross-cutting. `.husky/commit-msg` checks type, case, and length — not scope. Open PRs with `gh pr create --draft` |
| Specialists and workflows                | `.claude/agents/`, `.claude/commands/`                                                                                                                                                                                                                                                                                                                                  |
| quoter-bot public API docs               | [`.agents/skills/build-jsdoc/SKILL.md`](./.agents/skills/build-jsdoc/SKILL.md)                                                                                                                                                                                                                                                                                          |
