# squash-and-sign

Squash all commits on the current branch into a single signed commit and force push. Use this when a
branch has unsigned commits that need to be signed before merging to main.

## Arguments

`$ARGUMENTS` — optional. Pass `yes` to skip all confirmation prompts and use the auto-generated
commit message without asking to edit.

## Instructions

### Step 1: Validate branch state

1. Get the current branch name:

   ```bash
   git rev-parse --abbrev-ref HEAD
   ```

2. **Abort if on `main` or `master`** — this command must never run on the default branch:

   ```bash
   if [ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || [ "$(git rev-parse --abbrev-ref HEAD)" = "master" ]; then
     echo "ERROR: Cannot squash-and-sign on the default branch."
     exit 1
   fi
   ```

3. Determine the base branch. Check if there is an open PR for this branch and use its base:

   ```bash
   gh pr view --json baseRefName --jq '.baseRefName'
   ```

   If no PR exists, default to `main`.

4. Fetch the latest base branch:

   ```bash
   git fetch origin <base-branch>
   ```

### Step 2: Preview what will be squashed

1. Show the commits that will be squashed:

   ```bash
   git log origin/<base-branch>..HEAD --oneline
   ```

2. Show the combined diff stats:

   ```bash
   git diff origin/<base-branch>...HEAD --stat
   ```

3. Confirm with the user before proceeding (**skip if `$ARGUMENTS` is `yes`**):

   ```
   I'm about to squash the above <N> commit(s) on branch `<branch>` into a single signed commit
   and force push to `origin/<branch>`.
   Continue? (yes/no)
   ```

### Step 3: Generate the squash commit message

Compose a commit message from the branch's existing commits:

1. If there is only **one** commit, reuse its message as-is.
2. If there are **multiple** commits:
   - Use the PR title (if available) or the first commit's subject as the summary line.
   - List the individual commit subjects as bullet points in the body.

Present the proposed commit message to the user and ask if they want to edit it before proceeding
(**skip if `$ARGUMENTS` is `yes`** — use the generated message as-is).

### Step 4: Perform the squash

1. Compute the merge base and reset to it, keeping changes staged:

   ```bash
   MERGE_BASE=$(git merge-base origin/<base-branch> HEAD)
   git reset --soft $MERGE_BASE
   ```

   Using `merge-base` instead of `origin/<base-branch>` directly ensures correctness even when the
   base branch has advanced since this branch diverged.

2. Create the signed commit with the agreed-upon message:

   ```bash
   git commit -S -m "<commit message>"
   ```

   The `-S` flag signs the commit with the committer's configured GPG/SSH key.

3. Verify the commit is signed:

   ```bash
   git log --show-signature -1
   ```

### Step 5: Force push

Force push the squashed branch:

```bash
git push --force-with-lease
```

Using `--force-with-lease` instead of `--force` provides a safety check — it will refuse to push if
the remote branch has commits you haven't seen locally.

### Step 6: Confirm

Report the result:

```
Squashed and signed! Branch `<branch>` now has a single signed commit force-pushed to origin.

Commit: <short-sha> <subject>
Signature: <verified/unverified>
```

If the commit signature could not be verified, warn the user and suggest they check their signing key
configuration.

## Notes

- This command is destructive — it rewrites history on the branch. That's intentional and expected.
- Never run this on `main` or `master`.
- Always use `--force-with-lease` over `--force` for safety.
- The user must have a GPG or SSH signing key configured in their git config for `-S` to work.
- Subsequent commits made locally don't need to be squash and force pushed again (they include a signature)
