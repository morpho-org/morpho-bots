---
name: review-loop
description: Use before presenting a plan or TIB, after finishing an implementation, and when responding to PR review comments. Runs the satisficing self-check, dispatches independent reviewers in the background, and synthesizes their findings into incorporate / drop / defer decisions.
version: 1.0.0
author: Morpho
license: Apache-2.0
metadata:
  hermes:
    tags: [review, tib, planning, codex, synthesis]
    related_skills: []
---

# Review Loop

One procedure with three parameterizations. Everything below the Engine is a delta — do not restate
the Engine in a caller, point at it.

## The Engine

**1. Self-check before anything else.** Is what you are about to present _necessary and sufficient_
for the stated intent and constraints — no more, no less? Then look at the intent and constraints
themselves. If either is unclear, say so. If a reframe of either would produce a neater, more
ergonomic outcome, say that too, before building on the original framing.

Surface that doubt as prose the engineer can act on. Do not compress a real design question into a
short multiple-choice question: options with one-line labels throw away the context that makes the
choice decidable. Be concise, but concise is not the same as thin.

**2. Dispatch reviewers in the background.** Which ones depends on the parameterization.

**3. Do your own pass while they work — readability, concision, ergonomics.** Naming, ordering,
what a reader hits first, what the shape of the thing implies. **Change nothing semantic until every
reviewer has reported.** Semantic edits mid-flight invalidate the review you are waiting on and you
will not know which findings still apply.

**4. When the findings land, in this order:**

- **Deduplicate.** Two reviewers naming the same defect is one finding, with two votes. Say it once.
- **Synthesize and dissolve.** Findings that look separate are often one root cause wearing several
  hats, and the fix for the root dissolves the rest. Look for the reframe that makes several
  findings stop existing before you write several patches.
- **Discuss** — TIB parameterization only; see below.
- **Decide, per finding: incorporate, drop, or defer as a Linear ticket.** State the call and the
  reason. A dropped finding is a decision, not an oversight, and reads as one only if you say why.

## Parameterization A — TIBs

The bar is higher than for a plan: a TIB is a persistent record of intent written _before_
implementation, so a framing error here is expensive later. Run the Engine's self-check, then
dispatch both agents in parallel.

**Clean-room agent** — a fresh subagent (never `fork`; a fork inherits your context, which is the
whole thing you are trying to avoid). Omit the model override so it inherits the orchestrating
model. Hand it a succinct statement of _the problem_ and nothing else — no draft, no proposed
solution, no ticket. If work already in the tree would reveal your hand, give it a worktree from the
merge-base under `.claude/worktrees/`, and never name the TIB path.

Tell it explicitly that it may up-level the question rather than answer it as posed: "decline to
implement", "this dissolves if we reframe it as X", "fold this into some other issue later" are all
valid outcomes and are the most valuable ones when they are right.

Isolation is best-effort. A clean-room agent that finds the draft anyway is a weaker signal, not a
failed run — weigh it accordingly.

**Review agent** — Codex, GPT Sol at high reasoning, in two rounds against the same session:

1. **Correctness.** Bugs, regressions, and things the TIB failed to consider.
2. **Reframing.** Once round one is in, ask whether it would reframe anything about the spec to
   _dissolve_ the issues it found, rather than patch them.

Then **keep the session**. It will review the implementation later, and it already holds the
argument about this spec.

**Discuss before deciding.** For a TIB, step 4 gains a beat between synthesis and decision: raise
anything interesting to the engineer and talk about it. Do not demand decisions at this point — the
purpose is to think together while the record is still cheap to change.

## Parameterization B — Implementations

You implement first, per the plan or TIB. Then dispatch one reviewer and do your own pass while it
works.

**Review agent** — Codex, GPT Sol at high reasoning. Ask for correctness: bugs, regressions, and
whether the implementation actually respects the plan or TIB it claims to follow. If the TIB's
review session is still available, resume it rather than starting cold — it already knows the intent
and will notice a drift from it that a fresh reviewer cannot.

No discussion beat. Go from synthesis straight to incorporate / drop / defer.

## Parameterization C — Responding to PR review

Identical to B's own-pass-and-synthesize half, with two additions.

**Resolve threads.** Acting on a thread includes resolving it, with a reply when the reply carries
information — what changed, or why you disagreed. A thread you dropped still needs the reply saying
so. **No PR merges with unresolved threads.**

**The bar is high, and it is entropy.** By this point the intent and the implementation have each
been through multiple review rounds. A change at this stage has to _reduce codebase entropy_ —
remove a special case, delete a branch, make one thing behave like its neighbors. Restyling to a
reviewer's preference adds a diff and a merge risk and buys nothing. Drop those, say you dropped
them, and say why.

## Under Devin

The loop works the same, with three model facts that decide whether it is worth anything:

- The **clean-room agent** maps to `subagent_general`, which inherits the parent session's model —
  which is what this loop wants, so do not pin it.
- Never use `subagent_explore` for review. It runs on the cheap default model by design.
- A **custom subagent with no `model:` pinned silently falls back to SWE-1.6**, a fast cheap model.
  An unpinned reviewer still returns findings, they are just worse — and nothing announces it. Every
  manifest in `.devin/agents/` pins `model:` for exactly this reason.

Devin imports this repo's rules, skills, and commands via `read_config_from.claude` in
`.devin/config.json`, but **not** `.claude/agents/` — hence the manifests, which carry only
frontmatter and defer to `.claude/agents/<name>.md` for the instructions.

## Running the Codex reviewer

```sh
codex exec -m gpt-5.6-sol -c model_reasoning_effort=high -s read-only \
  "<prompt>" < /dev/null
```

`< /dev/null` is required. Without it `codex exec` blocks forever reading stdin, and a backgrounded
run looks like it is thinking when it is hung. Use `-s read-only` so the reviewer cannot edit the
thing it is reviewing.

`codex exec` prints `session id: <uuid>` in its header. Capture it:

```sh
grep -m1 '^session id: ' <output> | cut -d' ' -f3
```

Resume with `codex exec resume <session-id> "<prompt>"`.

## Session records

Every TIB gets a sibling `.sessions` file — `docs/decisions/<tib-stem>.sessions` — listing the
review session ids for that decision, one per line with a date and what the session covered. These
are git-ignored: they are local pointers into `~/.codex/sessions/`, not shared history.

Best-effort by design. Sessions expire, and they do not exist on another machine. When resume fails,
re-prime a fresh reviewer with the TIB itself — that is a supported path, not a failure.

## Filing what you defer

Deferred findings go to the **Bots** team per
[`docs/GUIDANCE.md`](../../../docs/GUIDANCE.md) — conventional-commit title, labels for the bots or
packages affected, no project. If no existing label fits the surface, flag the gap to the engineer
rather than filing unlabelled or inventing one.

Every ticket filed from this loop also carries **`code-review`** (the `Provenance` group) and links
the PR or TIB it came from, so what the loop keeps punting stays auditable.
