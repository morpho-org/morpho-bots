# pr-describe

Generate a comprehensive PR description for the current branch.

## Usage

```
/pr-describe
```

## Instructions

You are an expert at writing clear, concise pull request descriptions that help reviewers understand
changes quickly.

### Step 1: Gather Context

1. **Get current branch and PR info**:
   - Use `git rev-parse --abbrev-ref HEAD` to get the current branch name
   - Use `gh pr view --json number,title,url,baseRefName` to check if a PR exists and get its **base
     branch**
   - **Important**: The PR may target a branch other than `main` (e.g., another feature branch).
     Always use the actual base branch for diffs.
   - Use `git log <base-branch>..HEAD --oneline` to see all commits on this branch
   - Use `git diff <base-branch>...HEAD --stat` to get a high-level overview of changed files
   - Use `git diff <base-branch>...HEAD` to see the full diff of changes
   - If the base branch is not `main`, fetch it first: `git fetch origin <base-branch>`

2. **Analyze the changes**:
   - Understand the scope and purpose of the changes
   - Identify the main components/features affected
   - Note any significant refactoring, bug fixes, or new features
   - Look for patterns in the changes (e.g., multiple files in same module)

### Step 2: Generate Initial Description

**Agent consultation:** Review the agent team (`.claude/agents/`) and invoke any agents whose trigger
conditions match the PR's changes. Use their output to enrich the description (e.g., the
`product-manager` can provide operator impact context for feature PRs).

Output the description in a markdown code block so it can be easily copied. Structure as follows:

#### 1. PR Title (First!)

**Always propose the PR title first**, following the title convention.

#### 2. Summary

A concise 2-4 sentence summary that captures:

- What was changed (the "what")
- Why it was changed (the "why")
- The operator-visible impact or benefit (the "so what")

Use the commit messages as a guide but write a higher-level summary.

#### 3. Key Changes

A bulleted list highlighting the most important changes, grouped by component/area:

- Use file links in the format:
  `packages/kill-switch/src/trigger.ts:42`
- Focus on substantive changes, not trivial ones
- Group related changes together (e.g., "Updated all trigger paths to use shared retry helper")
- Include 4-8 key changes maximum

Format example:

```markdown
- **Trigger pipeline**: Extracted retry-with-backoff into a shared helper
  - `packages/kill-switch/src/trigger.ts:45`
  - `packages/kill-switch/src/handlers.ts:120`
- **ABI wiring**: Added VaultV2 deallocate call site
  - `packages/kill-switch/src/actions/deallocate.ts:1`
```

#### 4. Test Plan

A checklist of **manual testing steps** to verify the changes work correctly:

- Specific operator flows to test
- Edge cases to verify
- Any new automated tests added (mention them, but don't ask to run them)

**Important**: Do NOT include steps to run tests or typecheck locally - these are already handled by
CI.

If you're uncertain about the testing approach, note this and you'll ask the user in the next step.

### Step 3: Output Format

Present the description in a format that's easy to copy:

````text
## Proposed PR Title

`<the proposed title>`

---

## PR Description (copy below)

```markdown
## Summary

[2-4 sentence summary]

## Key Changes

[Bulleted list of changes]

## Test Plan

[Manual testing checklist]
````

---

Before finalizing:

1. Is there anything specific you'd like reviewers to focus on?
2. Any testing considerations to add or modify?

````

The PR title is shown separately above the description. The markdown code block contains only the body content that should be copied to the PR description field.

Wait for user feedback and update the description accordingly.

### Step 4: Finalize and Offer to Update

Once the user is satisfied with the description, ask:

```text
✅ Description looks good! Would you like me to update the PR with this description?

I can run: `gh pr edit <number> --body "..."`

(yes/no)
````

If the user confirms:

- If creating a new PR, use `gh pr create --draft --assignee @me` by default. Only omit `--draft`
  if the user explicitly requests a non-draft PR. Always pass `--assignee @me` so the PR creator
  is set as the assignee.
- If updating an existing PR, use `gh pr edit` to update the PR description.
- Confirm success with a link to the PR

### Important Notes

- Keep the summary concise - avoid verbose explanations
- Focus on the "why" and impact, not just the "what"
- File links should use the format `path/to/file.ts:line_number` for easy navigation
- Group related changes to avoid overwhelming the reader
- The test plan should be actionable and specific (manual steps only, no CI commands)
- Always check if a PR exists before offering to update it
- If no PR exists, offer to create one instead
- **Always check the PR's base branch** - it may not be `main`

### Formatting Guidelines

- Use **bold** for component/area names in the key changes section
- Use `code formatting` for file paths and technical terms
- Use bullet points and sub-bullets for hierarchy
- Keep the description scannable - use whitespace effectively

### Step 5: Offer Linear Ticket Creation

After the PR is updated (or if the user declines to update), ask if they want to create Linear
tickets for this work:

```text
Would you like me to create Linear tickets to track this work retrospectively?

(You may already have tickets linked, so feel free to skip this step)

Options:
1. Yes, create ticket(s) based on the PR changes
2. No, I already have tickets linked
3. No, this doesn't need tickets
```

If the user wants a ticket created:

1. **Determine the appropriate team and project** based on:
   - Which bot/package the changes are in (refer to the Linear Teams table in docs/GUIDANCE.md)
   - The nature of the work (bug fix, feature, refactor, etc.)

2. **Create the parent issue** using the Linear MCP tools with:
   - Title following the title convention
   - Description including:
     - Summary of the change
     - Link to the PR
     - Any relevant context
   - Appropriate labels if applicable

3. **Optionally create sub-issues** if the PR contains multiple distinct pieces of work:
   - Each sub-issue should reference the parent issue via `parentId`
   - Sub-issues help break down larger PRs into trackable components

4. **Link the issue to the PR** by updating the PR description to include the Linear issue URL

5. **Confirm creation** with links to both the Linear issue and the updated PR

### Edge Cases

- **No PR exists**: Offer to create one with `gh pr create --draft --assignee @me` (always default
  to draft unless the user explicitly asks for a non-draft PR; always assign the creator)
- **Multiple commits with different scopes**: Group by functional area, not commit
- **Large diffs**: Focus on architectural changes and entry points, not every file
- **Refactoring**: Emphasize the benefit and any behavior changes
- **Bug fixes**: Include the issue being fixed and how to verify the fix
