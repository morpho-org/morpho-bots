# start

Quickly create a Linear ticket and local branch to kick off work on a task.

## Instructions

You are helping the user quickly kick off work on a new task. This is a lightweight flow to record
work in Linear and set up a local branch. Do NOT try to create an implementation plan - just capture
the task and get started.

### Step 1: Get the task description

Check if the user provided a description as an argument: `$ARGUMENTS`

- If provided, use it as the basis for the ticket
- If not provided, ask: "What are you working on? (brief description)"

### Step 2: Generate a concise title

Based on the description, create a concise ticket title following the title convention.

### Step 3: Generate a brief description

Write 1-3 sentences describing what needs to be done. Keep it simple - this is just to capture
intent, not a full spec.

### Step 4: Ask for additional details

Present the generated title and description, then ask the user to select:

**Project** (required): Use your best judgement based on the task description and which bot/package
is affected to suggest the most appropriate project from the team's Linear projects. Present
relevant options and include "Other (let them specify)" as a fallback.

**Priority** (optional):

- 1 = Urgent
- 2 = High
- 3 = Normal (default)
- 4 = Low

**Assignee** (optional):

- Ask if they want to assign it to themselves ("me")

### Step 5: Create the Linear ticket

Use the Linear MCP tools to create the issue:

```
Refer to the Team IDs table in CLAUDE.md to select the appropriate team based on scope.
The default team for curator-bots work is Curator (CRTR).
```

Use `mcp__linear__create_issue` with:

- `title`: The generated title
- `description`: The brief description
- `team`: The team selected from the Team IDs table
- `project`: The selected project name
- `priority`: The selected priority (if specified)
- `assignee`: "me" (if they want to self-assign)

### Step 6: Create the local branch

After creating the Linear issue:

1. Extract the `gitBranchName` from the response
2. Detect if we're in a git worktree:

   ```bash
   git rev-parse --git-common-dir
   git rev-parse --git-dir
   ```

   If these differ, we're in a worktree. Store this for step 5.

3. Check the current git branch:

   ```bash
   git branch --show-current
   ```

4. Ask the user which branch to base off:
   - Use AskUserQuestion with options:
     - `main` (Recommended) - most common choice
     - Current branch (`<branch-name>`) - if they're not already on main
     - Other - let them specify a different branch

5. Create the branch:

   **If in a worktree** — do NOT use `git checkout` to switch to the base branch (it may already be
   checked out in another worktree). Instead, branch directly from the appropriate ref:

   ```bash
   # If basing off the current branch — just branch from HEAD
   git checkout -b <gitBranchName>

   # If basing off a different branch (e.g. main) — fetch latest and branch from origin
   git fetch origin <base-branch>
   git checkout -b <gitBranchName> origin/<base-branch>
   ```

   **If NOT in a worktree** — use the standard flow:

   ```bash
   git checkout <base-branch>
   git pull origin <base-branch>
   git checkout -b <gitBranchName>
   ```

### Step 7: Confirm completion

Provide a summary:

```
Created Linear ticket: <issue-identifier> - <title>
<linear-url>

Branch created: <gitBranchName>
Based off: <main or previous-branch>

You're ready to start working!
```

## Example Flow

**User**: `/start add retry-with-backoff to kill-switch deallocate calls`

**Claude**: "I'll create a ticket for this task.

**Title**: `feat(kill-switch): add retry-with-backoff to deallocate calls`

**Description**: Wrap the VaultV2 deallocate call site in the kill-switch bot with a
retry-with-backoff helper so transient RPC failures don't abort the trigger.

Which project should this be in? (based on scope, I'd suggest the Curator team's Kill Switch Bot
project)

1. <suggested project> (Recommended)
2. Other

Priority? (default: Normal)

1. Urgent
2. High
3. Normal
4. Low

Assign to yourself?"

**User**: "1, 3, yes"

**Claude**: _Creates Linear issue, gets branch name_

"Created Linear ticket: CRTR-2300 - feat(kill-switch): add retry-with-backoff to deallocate calls
https://linear.app/morpho-labs/issue/CRTR-2300

Which branch should I base the new branch off?

1. main (Recommended)
2. Other"

**User**: "1"

**Claude**: "Branch created: `feature/crtr-2300-feat-kill-switch-add-retry-with-backoff` Based off:
main

You're ready to start working!"

## Notes

- Keep it lightweight - this is just task kickoff, not planning
- Refer to the Team IDs table in CLAUDE.md to select the appropriate team based on scope
- The `gitBranchName` field from Linear provides the properly formatted branch name
- Always pull latest before branching (when basing off main)
- In worktrees, avoid switching to the base branch (it may be checked out in another worktree).
  Branch from HEAD if basing off current branch, or from `origin/<base>` if basing off a different
  branch
- Don't try to create implementation plans or break down into sub-tasks
