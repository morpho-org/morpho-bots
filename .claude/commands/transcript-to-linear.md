# Transcript to Linear

Analyze the provided meeting transcript and extract potential Linear tickets, projects, and action
items.

## Input

The user will provide a meeting transcript (from Granola or similar). The transcript may be provided
as:

- Direct paste of transcript text
- A URL to fetch (use WebFetch if needed)

## Analysis Process

Perform a deep analysis of the transcript looking for:

1. **Explicit action items** - Tasks directly assigned to people or agreed upon
2. **Implicit tasks** - Work mentioned that needs to happen but wasn't formally assigned
3. **Bugs or issues discovered** - Problems identified during discussion
4. **Feature requests** - New functionality mentioned or requested
5. **Technical debt** - Refactoring, migrations, or cleanup work discussed
6. **Follow-ups needed** - Items requiring further discussion, scoping, or clarification
7. **Projects to create** - Larger initiatives that need their own project space
8. **Documentation needs** - Docs, processes, or guidelines that should be written

## Output Format

### Section 1: Projects to Create

First, identify any new projects that should be created before tickets. Present as:

| P#  | Project Name | Description | Rationale |
| --- | ------------ | ----------- | --------- |

Where:

- **P#**: Project number for selection (P1, P2, etc.)
- **Project Name**: Clear, descriptive project name
- **Description**: What this project encompasses
- **Rationale**: Why this needs its own project (scope, duration, cross-cutting, etc.)

### Section 2: Tickets to Create

Then present tickets in a numbered table:

| #   | Type | Title | Description | Assignee | Project |
| --- | ---- | ----- | ----------- | -------- | ------- |

Where:

- **#**: Sequential number for selection
- **Type**: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`
- **Title**: Follow the title convention
- **Description**: Brief summary of the work item
- **Assignee**: Person mentioned or "TBD" if unclear
- **Project**: Existing Linear project, or reference to new project (e.g., "→ P1")

### Section 3: Action Items (Non-Ticket)

Finally, list action items that are follow-ups but not formal tickets:

| A#  | Action | Owner | Context |
| --- | ------ | ----- | ------- |

## Title Guidelines

Follow the title convention (types, scopes, rules, and examples).

## After Presenting the Tables

Ask the user:

> **Projects:** Which projects should I create? (e.g., `P1, P2` or `all projects` or `none`)
>
> **Tickets:** Which tickets should I create? (e.g., `1, 3, 5-7` or `all` or `none`)
>
> You can also modify items before creation (e.g., "change #3 assignee to Cash", "rename P1 to XYZ")

## Creating Items

When the user selects items:

### Projects First

1. Create any selected projects using `mcp__linear__create_project` with the appropriate team
   (refer to the Linear Teams table in docs/GUIDANCE.md)
2. Note the created project IDs for use in ticket creation

### Then Tickets

3. Create tickets using `mcp__linear__create_issue`
4. For tickets referencing new projects (→ P1, etc.), use the newly created project ID
5. Report back with links to all created items

## Additional Considerations

- Group related items that might be better as sub-issues under a parent
- Flag items that seem like they need scoping before ticket creation
- Identify any items that might already exist in Linear (duplicates)
- Note any blockers or dependencies between items
- If a project doesn't exist but should, suggest creating it first

$ARGUMENTS
