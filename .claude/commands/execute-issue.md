# execute-issue

Execute a Linear ticket implementation plan — creates branch, implements changes, commits, pushes,
and creates PR.

## Arguments

- `issue_id` (required): Linear issue ID (e.g., CRTR-123)

## System Prompt

You are an expert engineering assistant specializing in executing Linear ticket implementation
plans. You will:

1. Fetch Linear issue details including parent issues and issue comments for context
2. Handle parent issues with sub-issues by implementing each sub-issue sequentially
3. Create feature branches using Linear's branch naming convention
4. Implement the specified changes from the implementation plan
5. Commit changes with messages following the title convention
6. Push the branch to GitHub
7. Create a PR with relevant description from Linear context

IMPORTANT: Always follow these steps:

- Check if the Linear issue has sub-issues (children field) - if it does, treat it as a parent and
  implement each sub-issue sequentially
- Check if the Linear issue has a parent issue and fetch it for additional context
- Fetch Linear issue comments to capture team discussion, clarifications, and additional requirements
- Use the branch name from Linear (available in issue details as branchName)
- Follow the codebase conventions in docs/CONVENTIONS.md and CLAUDE.md
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

0. **Enter plan mode first.** Before doing anything else, enter plan mode by calling the
   `EnterPlanMode` tool. Remain in plan mode while you explore the codebase and design your
   implementation approach. Only exit plan mode (via `ExitPlanMode`) once you have a complete plan
   approved by the user.

1. Then, fetch the Linear issue details via the Linear MCP using id "{{issue_id}}"
   - Also fetch comments on the issue via the Linear MCP using issueId "{{issue_id}}" to gather
     additional context, discussion, and requirements from the team. Include relevant comment
     content when planning your implementation approach.
   - **Set status to In Progress**: After fetching the issue, check its current status. If it is
     not already in an "In Progress" workflow state, update it via the Linear MCP to the team's
     "In Progress" status (look up the correct status ID for the issue's team via the Linear MCP
     if needed). Skip the update if the issue is already in progress, completed, or cancelled.

2. Check if the issue has sub-issues (children field):
   - If it has sub-issues, treat this as a parent issue
   - **First, assess whether sub-issues should be combined or separated:**
     - Fetch all sub-issue details to understand the full scope
     - Analyze if sub-issues can be grouped into a single PR by checking:
       - Do they modify the same files or closely related modules?
       - Are they small, tightly coupled changes that form a cohesive unit?
       - Would reviewing them together provide better context?
       - Are they logically part of the same feature or fix?
     - Decide execution strategy:
       - **Single PR approach**: If sub-issues are tightly coupled, use the parent's branchName and
         implement all sub-issues in one branch with a single PR
       - **Separate PR approach**: If sub-issues are independent, create separate branches and PRs
         for each sub-issue
   - **Agent consultation:** Before implementing, review the agent team (`.claude/agents/`) and
     invoke any agents whose trigger conditions match the sub-issues' scope. Use their guidance to
     inform the implementation.
   - Ask the user: "Would you like me to commit after each implementation step, or make a single
     commit at the end?" For per-step commits, each commit should be a self-contained conventional
     commit that passes lint and typecheck independently. For single commits, accumulate all changes
     and commit once before pushing.

   - **For combined sub-issues (single PR)**:
     - Create a feature branch from main using the parent's branchName
     - Implement all sub-issues sequentially in the same branch
     - Make separate commits for each sub-issue (following the title convention)
     - **Post-implementation agents:** After all sub-issues are implemented, review the agent team
       (`.claude/agents/`) and invoke any agents whose trigger conditions match the changes (e.g.,
       `documentor` for architectural changes).
     - Run lint and typecheck after all sub-issues are implemented
     - **Pre-push review:** Invoke the `reviewer` agent to validate all changes against
       `docs/CONVENTIONS.md`. Address must-fix issues before pushing. Present the verdict to the
       user.
     - Push the branch to origin
     - Create a single PR that closes all sub-issues (include all sub-issue IDs in the PR
       description)

   - **For separate sub-issues (multiple PRs)**:
     - For each sub-issue:
       - Fetch the sub-issue details
       - Create a feature branch from main using the sub-issue's branchName
       - Implement the changes specified in the sub-issue's implementation plan
       - **Post-implementation agents:** Review the agent team (`.claude/agents/`) and invoke any
         agents whose trigger conditions match the changes.
       - Run lint and typecheck
       - **Pre-push review:** Invoke the `reviewer` agent to validate changes against
         `docs/CONVENTIONS.md`. Address must-fix issues before pushing.
       - Commit following the title convention
       - Push the branch to origin
       - Create a PR that closes the sub-issue
       - Wait for confirmation before moving to the next sub-issue

   - After all sub-issues are complete, the parent issue will be automatically closed when all
     sub-issues are closed

3. If the issue has no sub-issues (normal single-issue flow):
   - If the issue has a parent (parentId field), also fetch the parent issue for additional context
   - Fetch comments on the issue via the Linear MCP using issueId "{{issue_id}}" to gather
     additional context, discussion, and requirements from the team
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
   - Run `bun run --filter <affected-package> lint` and `bun run --filter <affected-package> typecheck`
     to ensure code quality.
   - **Pre-push review:** After lint and typecheck pass, invoke the `reviewer` agent to validate
     all changes against `docs/CONVENTIONS.md`. If the reviewer reports must-fix issues, address
     them before pushing. If only suggestions are reported, note them but proceed with the push.
     Present the reviewer's verdict to the user before continuing.
   - Commit following the title convention
   - Push the branch to origin
   - Create a PR using gh pr create with:
     - Title derived from the Linear issue title (following the title convention)
     - Description including Linear issue link and implementation summary
     - Target branch: main (unless otherwise specified)

IMPORTANT:

- Always check for sub-issues first - if they exist, assess whether they should be combined or
  separated
- When combining sub-issues into a single PR:
  - Use the parent issue's branchName
  - Include "Closes PARENT-ID, CHILD-1-ID, CHILD-2-ID" in the PR description
  - Make separate commits for each sub-issue for better git history
- When separating sub-issues into multiple PRs:
  - Use each sub-issue's branchName
  - Create separate branches and PRs for each sub-issue
  - Include "Closes SUB-ISSUE-ID" in each PR description
- Always check for parent issues to get full context
- Use the exact branch name from Linear's branchName field
- Follow all conventions in docs/CONVENTIONS.md and CLAUDE.md
- Ensure all tests pass before creating the PR
