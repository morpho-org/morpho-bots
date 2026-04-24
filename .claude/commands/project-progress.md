# project-progress

Generate a status report for a Linear project, showing incomplete issues in a table with a
dependency graph and linked PR statuses.

## Arguments

- `$ARGUMENTS` should contain: `<linear-project-name-id-or-url>`
- Example: `/project-progress monorepo-access-control-3cbe3f6c0fb3`
- Example: `/project-progress https://linear.app/morpho-labs/project/curator-v2-orpc-migration-0699ca7a`
- Example: `/project-progress "Monorepo Access Control"`

## Instructions

You are generating a progress report for a Linear project. The report combines Linear issue data
with GitHub PR statuses to give a complete picture of where the project stands.

### Step 1: Parse Arguments

Check `$ARGUMENTS`:

- If a **URL** is provided (starts with `https://linear.app/`), extract the project slug from the
  path.
- If a **name, ID, or slug** is provided, use it directly.
- If **no arguments** are provided, ask:
  _"Which Linear project should I report on? (project name, ID, slug, or URL)"_

### Step 2: Resolve the Project

1. Fetch the project using `mcp__linear__get_project` with `includeMilestones: true` and
   `includeMembers: true`.
2. Note the project name, description, status, start/target dates, lead, and health.
3. If the project cannot be found, list available projects with `mcp__linear__list_projects` and ask
   the user to pick one.

### Step 3: Gather All Issues

1. Fetch all issues in the project using `mcp__linear__list_issues` with `project` set to the
   project name/ID. Paginate through all results using `cursor`.

2. For each issue, fetch relations using `mcp__linear__get_issue` with `includeRelations: true` to
   get `blockedBy` and `blocks` data. Batch these calls efficiently.

3. For each **incomplete** issue, fetch its comments using `mcp__linear__list_comments` with the
   issue ID. These comments may contain GitHub PR URLs needed in Step 4.

4. Categorize issues by status type:
   - **Completed** (Done/Merged): Issues with a completed or merged status type
   - **Cancelled**: Issues that were cancelled
   - **Incomplete** (everything else): Backlog, Todo, In Progress, In Review — any non-terminal
     status

5. Compute summary counts:
   - Total issues
   - Completed count and percentage
   - In Progress count
   - Backlog/Todo count
   - Cancelled count

### Step 4: Gather PR Statuses

For each **incomplete** issue, look for linked PRs:

1. Check the issue description and comments (fetched in Step 3.3) for GitHub PR URLs
   (pattern: `github.com/morpho-org/morpho-apps/pull/\d+`).
2. Also check if the issue's `branchName` field has an associated open PR:

   ```bash
   gh pr list --repo morpho-org/morpho-apps --head <branchName> --json number,title,state,isDraft,reviewDecision,headRefName --limit 1
   ```

3. For each found PR, fetch its status:

   ```bash
   gh pr view <number> --repo morpho-org/morpho-apps --json number,state,isDraft,reviewDecision,title,url,statusCheckRollup,reviewRequests,reviews
   ```

4. Summarize each PR's status as a compact badge string:
   - **State**: `Draft`, `Open`, `Merged`, `Closed`
   - **Reviews**: `Approved`, `Changes Requested`, `Review Required`, `N/M approved`
   - **CI**: `Passing`, `Failing`, `Pending`

   Format: `#<number> <State> | <Reviews> | CI: <status>`

   Examples:
   - `#1234 Open | Approved | CI: Passing`
   - `#1235 Draft | Review Required | CI: Failing`
   - `#1236 Open | 1/2 approved | CI: Pending`

### Step 5: Build the Report

Generate the full report with the following sections:

#### 5a: Header

```
## Project Progress: <project-name>

**Status**: <project-status> | **Health**: <health>
**Lead**: <lead-name>
**Timeline**: <start-date> → <target-date>
**Progress**: <completed>/<total> issues (<percentage>%)

| Status       | Count |
| ------------ | ----- |
| Completed    | N     |
| In Progress  | N     |
| Backlog/Todo | N     |
| Cancelled    | N     |
```

#### 5b: Incomplete Issues Table

Display all **incomplete** issues (Backlog, Todo, In Progress, In Review) grouped by milestone
(if milestones exist), otherwise as a flat list. Sort within each group by priority then dependency
order.

```
### <Milestone Name> (or "Ungrouped" if no milestones)

| # | ID | Title | Status | Priority | Assignee | Blocked By | PR Status |
|---|-----|-------|--------|----------|----------|------------|-----------|
| 1 | APPS-101 | feat(web3): add RBAC module | In Progress | High | @alice | — | #1234 Open \| Approved \| CI: Passing |
| 2 | APPS-102 | feat(cv2): integrate RBAC | Backlog | Normal | — | APPS-101 | — |
```

Column definitions:

- **#**: Row number within the group
- **ID**: Linear issue identifier (e.g., APPS-101)
- **Title**: Issue title
- **Status**: Current Linear status (e.g., In Progress, Backlog, Todo, In Review)
- **Priority**: Urgent, High, Normal, Low
- **Assignee**: Assigned user or `—`
- **Blocked By**: Comma-separated list of blocking issue IDs, or `—`
- **PR Status**: Compact PR badge (from Step 4) or `—` if no PR

#### 5c: Dependency Graph

Build an ASCII dependency graph showing **only incomplete issues** and their relationships. This
makes the remaining work's critical path visible.

Rules for the graph:

- Each node is the issue identifier (e.g., `APPS-101`)
- Arrows (`→`) indicate "blocks" relationships (A → B means A blocks B)
- Group connected components together
- Show independent issues (no deps) on their own line
- If an issue is blocked by a **completed** issue, don't show the completed issue as a node — just
  note the dependency is satisfied
- Annotate each node with its status using a compact marker:
  - `*` = In Progress
  - `~` = In Review
  - (no marker) = Backlog/Todo

Format:

```
### Dependency Graph

APPS-101* → APPS-102 → APPS-105
               ↳ APPS-103
APPS-104* → APPS-106~
APPS-107  (independent)
APPS-108  (independent)

Legend: * = In Progress, ~ = In Review, (unmarked) = Backlog/Todo
```

For larger graphs with many branches, use a tree-style layout:

```
APPS-101*
├→ APPS-102
│  ├→ APPS-105
│  └→ APPS-106
└→ APPS-103
   └→ APPS-107

APPS-104* → APPS-108~

APPS-109  (independent)
```

#### 5d: Blocked Issues Callout

If any incomplete issues are blocked by other incomplete issues, call them out:

```
### Blocked Issues

- **APPS-102** (feat(cv2): integrate RBAC) is blocked by **APPS-101** (In Progress, #1234 Open)
- **APPS-105** (feat(cv2): add permission UI) is blocked by **APPS-102** (Backlog, no PR)
```

#### 5e: PRs Without Issues

Search for open PRs in the repo whose branch names or titles reference the project or its issues but
were not already linked from any issue in Step 4:

```bash
gh pr list --repo morpho-org/morpho-apps --state open --json number,title,headRefName,url --limit 100
```

Filter results for PRs whose `title` or `headRefName` contains a project issue identifier (e.g.,
`APPS-101`) or the project slug, but that were not already discovered in Step 4. For each match,
fetch its full status the same way as Step 4.3.

If any unlinked PRs are found, list them:

```
### Unlinked PRs

- #1240 — "fix(web3): handle edge case in RBAC" (Open | Review Required | CI: Passing)
```

If none are found, omit this section.

### Step 6: Present the Report

Present the full report to the user. Do not create any Linear artifacts — this is a read-only
report.

End with the completion status:

- **DONE** — full report generated with all data
- **DONE_WITH_CONCERNS** — report generated but with data gaps (explain what's missing)
- **BLOCKED** — cannot proceed; state what was attempted and what is blocking
- **NEEDS_CONTEXT** — missing information; state what is needed to continue

---

## Notes

- This is a **read-only** command — it does not create or modify any Linear issues
- Use `gh` CLI for all GitHub operations (PR status, reviews, CI checks)
- The dependency graph should only show incomplete issues to focus on remaining work
- When paginating Linear results, fetch all pages — do not stop at the first page
- PR lookups can be slow — batch them where possible and skip if the issue has no branch or linked
  PR
- The report format is designed to be copy-pasteable into Slack or a Linear status update

$ARGUMENTS
