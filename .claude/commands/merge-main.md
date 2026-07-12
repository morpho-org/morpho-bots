# merge-main

Merge `origin/main` into the current branch with **semantic intent** in mind — not just whatever
git's three-way text merge produces. The goal is a tree that is _correct_, not merely
_conflict-free_. Git operates on lines; it will happily (a) auto-merge two hunks that are textually
disjoint but semantically incompatible, and (b) leave a region untouched that actually needs editing
because of a change elsewhere (a rename, a signature change, a moved file, a new required argument).
This command exists to catch both classes.

## Arguments

`$ARGUMENTS` — optional.

- `--base <ref>` — merge from a base other than `origin/main` (e.g. `origin/develop`).
- `--abort-on-conflict` — stop and hand back to the user the moment git reports conflicts, instead of
  resolving them. Useful when you only want the semantic audit, not the resolution.

## Instructions

### Step 1: Preflight

1. Get the current branch and abort if it's the default branch — never merge main into main:

   ```bash
   BRANCH=$(git rev-parse --abbrev-ref HEAD)
   [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ] && { echo "ERROR: already on the default branch"; exit 1; }
   echo "On branch: $BRANCH"
   ```

2. Require a clean working tree. If `git status --porcelain` is non-empty, **stop** and ask the user
   to commit or stash first. Do not auto-stash — a botched semantic merge on top of uncommitted work
   is hard to untangle. (If the working changes are clearly unrelated scratch work the user told you
   to ignore, say so and ask explicitly before proceeding.)

3. Resolve the base ref **once** and fetch it. Every subsequent step uses `$BASE` — never a
   hard-coded `origin/main` — so the command actually merges what it reports merging:

   ```bash
   BASE=origin/main            # default; if --base <ref> was passed, set BASE to that ref instead
   git fetch "${BASE%%/*}" "${BASE#*/}"   # e.g. BASE=origin/develop -> git fetch origin develop
   echo "Merging base: $BASE"
   ```

4. Compute the merge base and check whether there's anything to do:

   ```bash
   MERGE_BASE=$(git merge-base HEAD "$BASE")
   git rev-list --count HEAD.."$BASE"   # commits on the base not yet on this branch
   ```

   If the count is `0`, the branch is already up to date — report and stop.

### Step 2: Understand both sides BEFORE merging

This is the part that makes the merge semantic rather than mechanical. Build a mental model of _what
each side was trying to do_ before letting git touch anything.

1. **What this branch did** (intent of our changes):

   ```bash
   git log --oneline $MERGE_BASE..HEAD
   git diff --stat $MERGE_BASE...HEAD
   ```

2. **What main did since we diverged** (intent of their changes):

   ```bash
   git log --oneline $MERGE_BASE..$BASE
   git diff --stat $MERGE_BASE...$BASE
   ```

3. **The overlap surface** — files touched on _both_ sides are where textual conflicts will appear,
   but they're not the only risk:

   ```bash
   comm -12 \
     <(git diff --name-only $MERGE_BASE...HEAD | sort) \
     <(git diff --name-only $MERGE_BASE...$BASE | sort)
   ```

4. **The hidden-risk surface** — read main's diff for changes whose blast radius extends beyond the
   files it touched. These are what git _cannot_ detect, because the affected call sites on our branch
   live in files main never modified. Specifically look for, on main's side:
   - **Renames / moves** of exported symbols, files, or modules (`git diff -M --summary $MERGE_BASE...$BASE`).
   - **Signature changes** — added/removed/reordered params, changed return types, widened/narrowed types.
   - **Behavioral changes** to a shared helper, hook, or `@repo/*` package our branch consumes.
   - **Deletions** of anything our branch references.

   For each such change, grep our branch for consumers that main's diff would not have updated:

   ```bash
   git grep -n '<renamed-or-changed-symbol>' $(git diff --name-only $MERGE_BASE...HEAD)
   ```

   Note every consumer that will need a follow-up edit _after_ the textual merge succeeds. This list is
   the core deliverable of the command — keep it.

### Step 3: Perform the merge

```bash
git merge --no-ff --no-commit "$BASE"
```

`--no-commit` stops before finalizing so we can audit the staged result; `--no-ff` keeps an explicit
merge commit. Capture the conflict list:

```bash
git diff --name-only --diff-filter=U
```

If there are conflicts and `--abort-on-conflict` was passed, run `git merge --abort` and hand the
analysis from Step 2 back to the user, then stop.

### Step 4: Resolve textual conflicts by intent

For each conflicted file, do **not** mechanically pick a side. Reconstruct what each side intended
(from Step 2) and write the version that satisfies both intents. When the two intents are genuinely
incompatible, stop and ask the user which should win — don't guess on semantics.

If [difftastic](https://difftastic.wilfred.me.uk/) (`difft`) is installed, use it to inspect conflicts
_structurally_ rather than line-wise — it diffs by syntax tree, so it distinguishes a real logic change
from a reflow/rename:

```bash
GIT_EXTERNAL_DIFF=difft git diff $MERGE_BASE $BASE -- <file>
```

Stage each file only once it represents both intents: `git add <file>`.

### Step 5: The semantic audit (the part git can't do)

Even with zero conflicts, the merge is **not** done. Work through the hidden-risk list from Step 2(4)
and verify the merged tree is actually coherent:

1. For every renamed/moved/changed symbol on main, confirm our branch's consumers now reference the
   new name/signature/location. Edit the ones that don't — these are edits git had no way to know were
   required.
2. For every new required argument, config key, or env var main introduced, confirm our branch's new
   call sites supply it.
3. For files auto-merged textually, spot-check that the interleaved hunks make sense _together_ (e.g.
   our branch added a call inside a block main deleted; or both sides added an import that's now
   duplicated; or both added a key to the same object/enum/switch and only one is reachable).
4. If a deleted file on one side is still imported by the other, resolve it.

Treat this list as a checklist and report which items applied.

### Step 6: Validate

Per [CLAUDE.md](../../CLAUDE.md), once the merge looks coherent run the validation suite scoped to the
affected packages — a merge is exactly the kind of change where regressions hide in untouched code:

```bash
pnpm typecheck --filter=<affected-packages>
pnpm lint --filter=<affected-packages>
pnpm format
pnpm test:unit --filter=<affected-packages>
```

Typecheck is the highest-value gate here: most "git merged it but it's wrong" failures from a
signature/rename change surface as type errors. If any check fails, fix and re-run before committing.
Do not commit a merge that doesn't typecheck.

### Step 7: Commit and report

1. Stage everything the audit and validation produced. The semantic edits from Step 5 and any
   `pnpm format` rewrites from Step 6 land in the working tree **unstaged**, so a bare
   `git commit` would record only the index from the textual merge and drop them. Re-stage and
   eyeball the result first so the committed tree is exactly the tree you audited and tested:

   ```bash
   git add -A
   git status   # confirm no unintended files; confirm the audited/formatted edits are staged
   ```

2. Finalize the merge commit (keep the default merge message, or summarize the semantic resolutions
   in the body if any were non-trivial):

   ```bash
   git commit --no-edit   # or: git commit  to add a body describing manual resolutions
   ```

3. Report with a clear completion status (per CLAUDE.md):
   - Commits pulled in from main (count + one-line summary of their intent).
   - Files with **textual** conflicts and how each was resolved.
   - **Semantic** edits made beyond conflicts (the hidden-risk items) — call these out explicitly,
     because they're the ones a reviewer won't see as conflict markers.
   - Validation results (typecheck / lint / tests), with evidence.
   - End with **DONE**, **DONE_WITH_CONCERNS**, or **BLOCKED**.

Do **not** push — leave that to the user.

## Optional tooling (high bar — only suggest if the user hits real pain)

These are not required. Only recommend installing if the merge is large and the user is struggling to
review it by hand:

- **[difftastic](https://difftastic.wilfred.me.uk/)** (`brew install difftastic`) — structural,
  syntax-aware diff. Most useful tool here: it shows _semantic_ changes and ignores pure reformatting,
  which is exactly the signal Step 5 needs. Used read-only via `GIT_EXTERNAL_DIFF=difft`.
- **[mergiraf](https://mergiraf.org/)** (`cargo install mergiraf`) — a tree-sitter-based merge driver
  that resolves many conflicts git can't by understanding language structure. Higher bar: it changes
  the merge driver, so only suggest for a genuinely conflict-heavy merge the user wants help landing.

## Notes

- This command never pushes and never runs on the default branch.
- "Conflict-free" ≠ "correct". The whole point is Step 5 — the audit git cannot perform.
- When two intents genuinely conflict, ask the user; never silently pick a side on a semantic call.
- Prefer fixing forward over re-running the merge; if the merge state gets confusing, `git merge --abort`
  returns to the pre-merge HEAD cleanly.
