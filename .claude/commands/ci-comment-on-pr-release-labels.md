# ci-comment-on-pr-release-labels

## Instructions

For each bot this PR releases, compare the current HEAD to the most recent release tag for that bot,
analyze the diff, and post a concise summary as a GitHub comment.

Release intent lives in the PR description as `Releases <bot>` (bot ids and their packages are in
`packages/ci-scripts/manifest.json`). The `release-<bot>` labels are derived from that line by
`pr-release-label-sync.yml`, so reading the labels is equivalent and simpler.

### Step 1: Identify Release Labels

Use the `gh` CLI to get the current PR's labels (it will auto-detect the PR from the checked-out
branch):

```bash
gh pr view --json number,labels
```

Parse the JSON output to extract:

- The PR number (for posting the comment later)
- Labels that start with `release-` (e.g., `release-quoter-bot`, `release-midnight-liq`)

If no release labels are found, you can stop here -- don't even both posting a comment.

### Step 2: Analyze Each App

For each bot identified by the `release-{bot}` labels:

1. **Find the latest release tag** for that bot. Tags are `{bot}-{PR#}`, so sort by creation date,
   not version:

   ```bash
   git tag -l "{bot}-*" --sort=-creatordate | head -1
   ```

2. **Resolve the bot's directory** from `packages/ci-scripts/manifest.json` (`package` →
   `bots/<dir>/package.json#name`). The new release will be `{bot}-{this PR's number}`; there is no
   version bump to check.

3. **Compare the diff** between the latest tag and the current HEAD:

   ```bash
   git diff {latest-tag}...HEAD -- bots/{dir} packages
   ```

   If no tag exists (initial release), compare against the base branch:

   ```bash
   git diff origin/main...HEAD -- bots/{dir} packages
   ```

4. **Get commit messages** in the release range for context:

   ```bash
   git log {latest-tag}...HEAD --oneline -- bots/{dir} packages
   ```

   (or use `origin/main...HEAD` for initial releases)

5. **Analyze the changes** by examining:
   - Commit messages: understand the intent and scope
   - Code diff: identify what actually changed
   - Package.json: check for dependency updates or version bumps
   - Breaking changes: look for major refactors or API changes

6. **Write a concise summary** (2-3 bullet points) that captures:
   - The main purpose/theme of this release
   - Key user-facing changes (new features, bug fixes, improvements)
   - Any breaking changes or important considerations for deployment

### Step 3: Post Release Notes

Format your analysis as markdown and post it as a sticky comment. Use the PR number from Step 1.

**Comment format:**

```markdown
### Changelog

> [!IMPORTANT]
> | Bot | Previous release | New release | Diff |
> | --- | ---------------- | ----------- | ---- |
> | {bot} | `{previous-tag}` | `{bot}-{PR#}` | https://github.com/morpho-org/morpho-bots/compare/{previous-tag}...{head} |
> | {another-bot} | `{previous-tag}` | `{another-bot}-{PR#}` | https://github.com/morpho-org/morpho-bots/compare/{previous-tag}...{head} |

#### {bot}

- {First key change or feature}
- {Second key change or bug fix}
- {Third change if notable, or omit if only 2 items}

#### {another-bot}

- {Bullet point describing main change}
- {Another bullet point}

---

_Claude will update this release summary on every push_
```

**Sticky comment behavior:**

1. **First, check for an existing release summary comment:**

   ```bash
   gh api repos/{owner}/{repo}/issues/<PR_NUMBER>/comments --jq '.[] | select(.body | startswith("### Changelog")) | .id'
   ```

2. **If a comment ID is found, edit it:**

   ```bash
   gh api repos/{owner}/{repo}/issues/comments/<COMMENT_ID> -X PATCH -f body="$(cat <<'EOF'
   [your formatted markdown here]
   EOF
   )"
   ```

3. **If no comment is found, create a new one:**
   ```bash
   gh pr comment <PR_NUMBER> --body "$(cat <<'EOF'
   [your formatted markdown here]
   EOF
   )"
   ```

### Guidelines

- **Be specific**: Mention actual features, components, or file names when relevant
- **Focus on impact**: Explain what changed and why it matters to users/developers
- **Skip noise**: Ignore pure refactors, linting, or formatting unless they affect behavior
- **Use active voice**: "Adds feature X", "Fixes bug Y", "Updates dependency Z"
- **Group related changes**: Combine similar fixes or features into single bullet points
- **Prioritize user-facing changes**: Features and bug fixes come before internal improvements

### Error Handling

If you encounter errors during processing:

- **No release intent**: Post a comment explaining that the description declares no `Releases <bot>`
- **No tags found**: Treat as an initial release and compare against `origin/main`
- **Git command failures**: Note the error in the summary for that specific bot
- **Empty diffs**: Mention that no changes were detected for that bot

Continue processing all bots even if some fail. Partial information is better than no information.
