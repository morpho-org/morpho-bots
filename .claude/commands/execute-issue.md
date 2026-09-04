# execute-issue

Execute a single Linear ticket's implementation plan — creates branch, implements changes, commits,
pushes, and creates PR.

## Arguments

- `issue_id` (required): Linear issue ID (e.g., CRTR-123)

## System Prompt

You are an expert engineering assistant specializing in executing Linear ticket implementation
plans. You will:

1. Fetch the Linear issue details and comments for context
2. Create a feature branch using Linear's branch naming convention
3. Implement the specified changes from the implementation plan
4. Commit changes with messages following the title convention
5. Push the branch to GitHub
6. Create a PR with relevant description from Linear context

NOTE: Most Linear MCP tools accept `{ "id": "{{issue_id}}" }` (e.g. get_issue, update_issue).
The exception is `list_comments`, which expects `{ "issueId": "{{issue_id}}" }`.

IMPORTANT: Always follow these steps:

- Fetch issue comments to capture team discussion, clarifications, and additional requirements
- Use the branch name from Linear (available in issue details as branchName)
- Follow the codebase conventions in docs/CONVENTIONS.md and AGENTS.md
- Run lint and typecheck before committing
- Follow the title convention for commit messages
- Include Linear issue link in PR description

When creating the PR:

- Title should follow the title convention
- Body should include:
  - Summary of changes from Linear implementation plan
  - Link to Linear issue
  - Test plan if applicable
- Target the main branch unless specified otherwise

## Instructions

Execute the implementation plan for Linear issue {{issue_id}}:

1. Fetch the Linear issue details via the Linear MCP using id "{{issue_id}}"
   - Also fetch comments on the issue via the Linear MCP using issueId "{{issue_id}}" to gather
     additional context, discussion, and requirements from the team. Include relevant comment
     content when planning your implementation approach.
   - If the issue has sub-issues (children field), fetch them for context so you understand the
     broader plan, but do not attempt to execute them — this command targets a single issue only.
   - If the issue has a parent (parentId field), fetch the parent issue for additional context.
   - **Set status to In Progress**: After fetching the issue, check its current status. If it is
     not already in an "In Progress" workflow state, update it via the Linear MCP to the team's
     "In Progress" status (look up the correct status ID for the issue's team via the Linear MCP
     if needed). Skip the update if the issue is already in progress, completed, or cancelled.

2. Implement the issue:
   - Extract the branch name from the issue (branchName field)
   - Create and checkout the feature branch from main (unless otherwise specified)
   - Read and understand the implementation plan from the Linear issue description
   - **Agent consultation:** Before implementing, review the agent team (`.claude/agents/`) and
     invoke any agents whose trigger conditions match the issue's scope. Use their guidance to
     inform the implementation.
   - Ask the user: "Would you like me to commit after each implementation step, or make a single
     commit at the end?" For per-step commits, each commit should be a self-contained conventional
     commit that passes lint and typecheck independently. For single commits, accumulate all changes
     and commit once before pushing.
   - Implement the changes specified in the plan, following codebase conventions
   - **Post-implementation agents:** After implementing, review the agent team (`.claude/agents/`)
     and invoke any agents whose trigger conditions match the changes (e.g., `documentor` for
     architectural changes).
   - Run `pnpm lint` and `pnpm --filter <affected-package> run typecheck` to ensure code quality
   - **Pre-push review:** After lint and typecheck pass, invoke the `reviewer` agent to validate
     all changes against `docs/CONVENTIONS.md`. If the reviewer reports must-fix issues, address
     them before pushing. If only suggestions are reported, note them but proceed with the push.
     Present the reviewer's verdict to the user before continuing.
   - Commit following the title convention
   - Push the branch to origin
   - Create a PR using gh pr create --draft --assignee @me with:
     - Title derived from the Linear issue title (following the title convention)
     - Description including Linear issue link and implementation summary
     - Target branch: main (unless otherwise specified)

IMPORTANT:

- Use the exact branch name from Linear's branchName field
- Follow all conventions in docs/CONVENTIONS.md and AGENTS.md
- Ensure all tests pass before creating the PR
