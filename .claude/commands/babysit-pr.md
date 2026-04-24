# babysit-pr

Pull unresolved PR review comments and failed CI checks, address each one, then commit and push the
fixes.

## Usage

```
/babysit-pr [pr-number] [confirm]
```

If no PR number is given, detect the PR from the current branch.

**Default behavior**: immediately address all unresolved comments and CI failures, then commit and
push. No confirmation prompts.

**With `confirm`**: present a summary table first and ask the user which items to address before
making changes.

## Instructions

### Step 1: Identify the PR

1. If a PR number was provided, use it. Otherwise, detect from the current branch:

   ```bash
   gh pr view --json number --jq '.number'
   ```

2. Confirm the current local branch matches the PR's head branch:

   ```bash
   gh pr view <number> --json headRefName --jq '.headRefName'
   git rev-parse --abbrev-ref HEAD
   ```

   If they don't match, **STOP** and tell the user to check out the correct branch.

3. Pull the latest changes to ensure you're up to date:

   ```bash
   git pull --rebase
   ```

### Step 2: Fetch unresolved review comments and PR conversation comments

1. Fetch all review comments on the PR:

   ```bash
   gh api repos/{owner}/{repo}/pulls/<number>/comments --paginate
   ```

2. Fetch all review threads and filter to **unresolved** ones (where `isResolved` is false):

   ```bash
   gh pr view <number> --json reviewDecision,reviews,comments
   ```

   Use the GraphQL API if needed to get thread resolution status:

   ```bash
   gh api graphql -f query='
     query($owner: String!, $repo: String!, $pr: Int!) {
       repository(owner: $owner, name: $repo) {
         pullRequest(number: $pr) {
           reviewThreads(first: 100) {
             pageInfo { hasNextPage endCursor }
             nodes {
               id
               isResolved
               isOutdated
               path
               line
               comments(first: 10) {
                 nodes {
                   body
                   author { login }
                   createdAt
                 }
               }
             }
           }
         }
       }
     }
   ' -f owner='{owner}' -f repo='{repo}' -F pr=<number>
   ```

   If `pageInfo.hasNextPage` is true, re-query with `after: "<endCursor>"` to fetch remaining
   threads. Repeat until all threads are retrieved.

3. Filter out resolved and outdated threads. Only keep threads that are:
   - `isResolved: false`
   - `isOutdated: false`

4. Fetch PR conversation comments (general comments on the PR's conversation tab, not tied to
   specific code lines):

   ```bash
   gh api repos/{owner}/{repo}/issues/<number>/comments --paginate
   ```

   Filter these comments to only keep **actionable** ones:
   - Posted **after the most recent commit** on the PR (older comments are likely already addressed).
     Get the latest commit date with:

     ```bash
     gh api repos/{owner}/{repo}/pulls/<number>/commits --jq '.[-1].commit.committer.date'
     ```

   - Exclude bot comments (check `author_association` or known bot logins like `github-actions[bot]`,
     `vercel[bot]`, etc.).
   - Exclude simple approvals or non-actionable replies (e.g., "LGTM", "Looks good", emoji-only
     comments). Keep comments that contain requests, suggestions, questions, or specific feedback.

5. If there are **no unresolved review comments and no actionable conversation comments**, note that
   and continue to CI checks (Step 2b).

### Step 2b: Check for CI failures

1. List all check runs and their statuses for the PR's head commit:

   ```bash
   gh pr checks <number>
   ```

2. If all checks pass, note that and continue to merge conflict check (Step 2c).

3. If any checks have failed, extract the run IDs from the failed checks and fetch their logs:

   ```bash
   gh pr checks <number> --json name,state,link --jq '.[] | select(.state == "FAILURE")'
   ```

   Extract the run ID from the check's link URL (the numeric segment in
   `/actions/runs/<run-id>/`), or list runs for the PR's head branch:

   ```bash
   gh run list --branch <head-branch> --status failure --json databaseId,name --jq '.[] | {id: .databaseId, name}'
   ```

   Then fetch the failed logs:

   ```bash
   gh run view <run-id> --log-failed
   ```

   If the failed run has multiple jobs, identify the failing job(s) with their IDs:

   ```bash
   gh run view <run-id> --json jobs --jq '.jobs[] | select(.conclusion == "failure") | {id: .databaseId, name, conclusion}'
   ```

   Then fetch logs for the specific failing job:

   ```bash
   gh run view <run-id> --log-failed --job <job-id>
   ```

4. Parse the failure logs to identify:
   - **TypeScript errors** — file, line, and error message
   - **Lint errors** — rule, file, and line
   - **Test failures** — test name, assertion, expected vs actual
   - **Build errors** — module or config issue
   - **Other failures** — note them for the user

5. Collect all CI failures into a list alongside the unresolved review comments and conversation
   comments.

### Step 2c: Check for merge conflicts with main

1. Fetch the latest `main`:

   ```bash
   git fetch origin main
   ```

2. Attempt a trial merge:

   ```bash
   git merge origin/main --no-commit --no-ff
   ```

3. **If the merge succeeds cleanly** (no conflicts), abort it and note that there are no conflicts.
   **If the branch is already up to date** with `origin/main`, no merge state is created — check
   for `MERGE_HEAD` before aborting to avoid an error:

   ```bash
   if [ -f .git/MERGE_HEAD ]; then git merge --abort; fi
   ```

4. **If there are merge conflicts**, abort the merge and record the list of conflicting files:

   ```bash
   git diff --name-only --diff-filter=U
   if [ -f .git/MERGE_HEAD ]; then git merge --abort; fi
   ```

5. If there are no unresolved review comments, no actionable conversation comments, no CI failures,
   and no merge conflicts, report and stop:

   ```
   No unresolved review comments, no actionable conversation comments, all CI checks pass, and no merge conflicts with main on PR #<number>. Nothing to do.
   ```

### Step 3: Present or proceed

**If `confirm` flag is set**, display a summary table and wait for user input:

```
Found N unresolved review comment(s), P conversation comment(s), M CI failure(s), and K merge conflict(s) on PR #<number>:

### Review Comments
| # | File | Line | Author | Comment |
|---|------|------|--------|---------|
| 1 | `src/foo.ts` | 42 | reviewer1 | Short summary of comment... |
| 2 | `src/bar.tsx` | 15 | reviewer2 | Short summary of comment... |

### PR Conversation Comments
| # | Author | Comment |
|---|--------|---------|
| 3 | reviewer1 | Short summary of comment... |

### CI Failures
| # | Check | Job | Error |
|---|-------|-----|-------|
| 4 | Typecheck | typecheck | TS2345: Argument of type 'string' is not assignable... in `src/foo.ts:10` |
| 5 | Lint | lint | no-unused-vars in `src/bar.tsx:5` |
| 6 | Tests | test-unit | FAIL test/trigger.test.ts — expected 42, received undefined |

### Merge Conflicts
| # | File |
|---|------|
| 7 | `src/foo.ts` |
| 8 | `packages/web3/src/config.ts` |
```

Ask the user: **"Address all of these? Or enter specific numbers to address (e.g. 1,3,4)."**

Then only address the items the user selected.

**If `confirm` flag is NOT set** (default), print a brief status line and immediately proceed to
address all items:

```
Addressing N unresolved review comment(s), P conversation comment(s), M CI failure(s), and K merge conflict(s) on PR #<number>...
```

### Step 4: Address each item

> **Important**: Always resolve merge conflicts first. The `git merge` command requires a clean
> working tree, so it must run before any uncommitted file edits from review comment, conversation
> comment, or CI failure fixes.

#### For merge conflicts:

1. **Merge `main` into the branch**:

   ```bash
   git fetch origin main
   git merge origin/main
   ```

2. For each conflicted file, read the file, understand both sides of the conflict, and resolve
   it by keeping the intent of both the PR's changes and `main`'s changes. Prefer the PR's
   logic when both sides modified the same behavior, but incorporate any new additions from
   `main` (new imports, new exports, new functions, etc.).

3. After resolving all conflicts, stage the resolved files:

   ```bash
   git add <resolved-file1> <resolved-file2> ...
   ```

4. Complete the merge commit:

   ```bash
   git commit -m "$(cat <<'EOF'
   chore: resolve merge conflicts with main

   Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
   EOF
   )"
   ```

5. **Log what you did** — add to the running list of changes.

If a conflict is complex or ambiguous (e.g., both sides substantially rewrote the same logic),
flag it to the user instead of guessing.

#### For review comments, conversation comments, and CI failures — use sub-agents

After merge conflicts are resolved, dispatch fixes for remaining items **in parallel using
sub-agents**. This dramatically improves performance when there are multiple independent issues.

**Grouping rules for sub-agents:**

1. **Group by file**: If multiple comments or CI errors target the **same file**, assign them to a
   **single sub-agent** to avoid edit conflicts.
2. **One agent per independent file/group**: Items targeting different files can each get their own
   sub-agent running concurrently.
3. **Cross-file items**: If a review comment, conversation comment, or CI failure spans multiple
   files, assign it to one sub-agent that owns all those files. No other sub-agent should touch
   the same files.
4. **Ambiguous items**: If a comment is ambiguous, requires a design decision, or is beyond a simple
   code fix, do NOT assign it to a sub-agent. Collect these and flag them to the user after the
   sub-agents complete.

**Sub-agent prompt template:**

Each sub-agent should receive a prompt with:

- The PR number and branch name
- The specific item(s) to address (comment body, file path, line number, CI error details)
- The thread node ID(s) for review comments (so the agent can resolve them)
- Clear instructions on what to do (see item-type instructions below)
- Instruction to **only edit the assigned file(s)** — never touch files outside its assignment
- Instruction to **not commit or push** — just make the edits and report what was changed
- Instruction to resolve review threads after making fixes (using the `gh api graphql` mutation)

Launch all sub-agents concurrently using the Agent tool in a single message. Wait for all to
complete before proceeding to Step 5.

**Item-type instructions to include in sub-agent prompts:**

For **review comments**:

1. Read the file at the referenced path and line to understand the current code.
2. Understand what the reviewer is asking for. If the comment is a question or observation that
   doesn't require a code change, skip it and report why.
3. Make the fix — edit the file to address the reviewer's feedback.
4. Resolve the thread on GitHub:

   ```bash
   gh api graphql -f query='
     mutation($threadId: ID!) {
       resolveReviewThread(input: {threadId: $threadId}) {
         thread { isResolved }
       }
     }
   ' -f threadId='<thread-node-id>'
   ```

5. Report what was changed and why.

For **conversation comments**:

1. Read the comment and understand what's being requested.
2. If it references specific files or code, locate the relevant files and make the requested changes.
3. If it's a general request (e.g., "please update the docs"), address it directly.
4. If it's a question or doesn't require code changes, skip it and report why.
5. Report what was changed and why.

For **CI failures**:

1. Read the failing file at the location indicated by the error.
2. Diagnose the root cause — understand why the check failed.
3. Fix the issue:
   - **TypeScript errors**: fix the type issue at the indicated location.
   - **Lint errors**: fix the lint violation. Do not add `eslint-disable` comments unless the
     rule is genuinely inapplicable.
   - **Test failures**: read the failing test, understand the assertion, and fix either the test
     or the implementation depending on which is wrong.
   - **Build errors**: investigate the build config or module resolution issue and fix it.
4. Report what was changed and why.

**After all sub-agents complete:**

1. Review each sub-agent's report. If any sub-agent flagged an ambiguous item or was unable to
   make a fix, collect those for the user.
2. If any sub-agent reported a conflict or issue, investigate and resolve it before proceeding.
3. Proceed to Step 5 (Validate).

### Step 5: Validate

After all comments are addressed, run validation on affected packages:

```bash
bun run --filter <affected-package> typecheck
bun run --filter <affected-package> lint
bun test
bun format:check
```

Fix any issues found. If format check fails, run `bun format` to auto-fix.

### Step 6: Commit and push

If the only items addressed were merge conflicts (no review comments, conversation comments, or CI
failures required file edits), the merge commit from Step 4 already contains all changes — skip to
pushing.

Otherwise:

1. Stage only the files that were modified to address review comments, conversation comments,
   and/or CI failures:

   ```bash
   git add <file1> <file2> ...
   ```

2. Create a commit with a message summarizing the review feedback addressed:

   ```bash
   git commit -m "$(cat <<'EOF'
   fix: address PR review feedback and CI failures

   - <summary of change 1>
   - <summary of change 2>
   - ...

   Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
   EOF
   )"
   ```

   Adjust the commit subject based on what was actually addressed — if only review comments, use
   "fix: address PR review feedback"; if only CI failures, use "fix: resolve CI failures"; if both,
   use "fix: address PR review feedback and CI failures".

3. Push to the remote:

   ```bash
   git push
   ```

4. After pushing, re-run the merge conflict check from Step 2c to ensure no new commits to `main`
   introduced conflicts. If conflicts exist, resolve them following Step 4 and push again.

5. Re-request reviews from reviewers whose feedback has been fully addressed:

   First, fetch the current review states for the PR to identify reviewers who have already
   approved:

   ```bash
   gh pr view <number> --json reviews --jq '.reviews[] | {author: .author.login, state: .state}'
   ```

   **Skip re-requesting** if the reviewer's most recent review state is `APPROVED` — they have
   already signed off and re-requesting would reset their approval unnecessarily.

   For each remaining human reviewer who had unresolved review comments at the start of this run
   and whose most recent review state is **not** `APPROVED`, check whether **every** thread from
   that reviewer is now in one of these states:
   - **Resolved** (thread `isResolved: true`), OR
   - **Replied to by the PR author** — query with `comments(last: 1)` to get the true last
     comment in the thread, then check if the author matches the PR author

   If all of that reviewer's threads meet at least one of the above criteria, re-request their
   review:

   ```bash
   gh pr edit <number> --add-reviewer <reviewer-login>
   ```

   If a reviewer still has threads that are neither resolved nor replied to by the PR author
   (e.g., ambiguous items flagged to the user), do **not** re-request their review.

6. Report the result:

   ```
   DONE — Addressed N review comment(s), P conversation comment(s), M CI failure(s), and K merge conflict(s) on PR #<number>.

   Review feedback:
   - <summary of each review change>

   Conversation comments:
   - <summary of each conversation comment change>

   CI fixes:
   - <summary of each CI fix>

   Merge conflicts resolved:
   - <file>: <brief description of resolution>

   Commit: <short-sha>
   Pushed to origin/<branch>.
   ```

## Notes

- Never commit or push to `main`.
- If a review comment requires a design decision or is beyond a simple code fix, flag it to the
  user instead of guessing.
- Group related comment fixes into a single commit rather than one commit per comment.
- If a CI failure appears to be a flaky test or infra issue unrelated to the PR, flag it to the
  user rather than attempting a fix.
- When CI logs are very long, focus on the first error — cascading failures are usually caused
  by the first one.
