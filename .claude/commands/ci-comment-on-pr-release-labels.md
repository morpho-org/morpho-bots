# ci-comment-on-pr-release-labels

## Instructions

For each of the release labels on this PR, compare the current HEAD to the most recent release tag
for that app, analyze the diff, and post a concise summary as a GitHub comment.

### Step 1: Identify Release Labels

Use the `gh` CLI to get the current PR's labels (it will auto-detect the PR from the checked-out
branch):

```bash
gh pr view --json number,labels
```

Parse the JSON output to extract:

- The PR number (for posting the comment later)
- Labels that start with `release-` (e.g., `release-curator`, `release-rewards`)

If no release labels are found, you can stop here -- don't even both posting a comment.

### Step 2: Analyze Each App

For each app identified by the `release-{app}` labels:

1. **Find the latest release tag** for that app:

   ```bash
   git tag -l "{app}-*" --sort=-version:refname | head -1
   ```

2. **Get the current package version** to determine what the new release will be:

   ```bash
   jq -r .version packages/{bot}/package.json
   ```

   If the app version hasn't actually been bumped yet, skip remaining analysis and omit the app from
   release notes.

3. **Compare the diff** between the latest tag and the current HEAD:

   ```bash
   git diff {latest-tag}...HEAD -- packages/{bot}
   ```

   If no tag exists (initial release), compare against the base branch:

   ```bash
   git diff origin/main...HEAD -- packages/{bot}
   ```

4. **Get commit messages** in the release range for context:

   ```bash
   git log {latest-tag}...HEAD --oneline -- packages/{bot}
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
> | App | Old Version | New Version | Diff |
> | --- | ----------- | ----------- | ---- |
> | {app-name} | `{old-version}` | `{new-version}` | https://github.com/morpho-org/curator-bots/compare/{base-tag}...{head} |
> | {another-app-name} | `{old-version}` | `{new-version}` | https://github.com/morpho-org/curator-bots/compare/{another-base-tag}...{head} |

#### {app-name}

- {First key change or feature}
- {Second key change or bug fix}
- {Third change if notable, or omit if only 2 items}

#### {another-app-name}

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

- **No release labels**: Post a comment explaining that no `release-*` labels were found
- **No tags found**: Treat as an initial release and compare against `origin/main`
- **Git command failures**: Note the error in the summary for that specific app
- **Empty diffs**: Mention that no changes were detected for that app

Continue processing all apps even if some fail. Partial information is better than no information.
