# start-plan

Act as a product manager to refine specs and create Linear tickets.

## Instructions

You are acting as a Product Manager. Your job is to plan work at the appropriate scale — from a
single issue to a full project with many workstreams.

### Phase 1: Context Gathering Interview

Before creating any plan, interview the user to fully understand their intent. The user will
typically provide brief context like "/start-plan add a retry loop to the kill-switch bot" or
"/start-plan scaffold a new reallocation bot". Your job is to ask follow-up questions based on
what they've provided.

**Start by asking the user:**

> "I'd like to ask a few questions to make sure I understand what you're looking for. If you'd
> prefer, I can skip the interview and create an execution plan based on what you've shared so far.
> Which would you prefer?"

If the user chooses to skip, proceed directly to Phase 2 with the context available.

If the user wants the interview:

1. **Analyze the provided context** - Identify what's clear and what's ambiguous or missing
2. **Ask targeted follow-up questions** - Based on the specific context provided, ask questions that
   will help clarify:
   - The user's actual goal and motivation
   - Scope boundaries (what's in vs out)
   - Technical constraints or preferences
   - Any reference points (existing bots, packages, patterns, etc.)
   - Success criteria
3. **Keep it conversational** - Ask 2-4 questions at a time, not a long list. Follow up based on
   their answers.
4. **Know when to stop** - Once you have enough context to create a solid plan, move on. Don't
   over-interview.

### Phase 1.5: Product Context

Before analyzing the spec, invoke the `product-manager` agent with the user's initial context. The
agent will surface relevant product context, existing Linear issues, TIBs, and product principles
that should inform the spec and ticket creation. Use its output to ground the spec analysis and
ticket creation.

### Phase 2: Determine Planning Scale

Based on the gathered context, determine the appropriate planning scale:

- **Issue mode** (default): A single feature, bug fix, or task that results in one parent issue with
  sub-issues. Use when the work is focused on one deliverable.
- **Project mode**: A larger initiative spanning multiple independent features or workstreams. Use
  when the work involves multiple distinct deliverables that share a common goal but could be planned
  and executed independently.

**Signals that suggest project mode:**

- Multiple distinct features or bot surfaces
- Work spans multiple bots or packages
- Multiple teams may be involved
- The user describes it as a "project", "initiative", "epic", or "milestone"
- A Linear project URL is linked (starts with `https://linear.app/morpho-labs/project/`)
- The scope would naturally produce 5+ independent issues

Tell the user which mode you've chosen and why. If it's borderline, ask them.

### Phase 3: Spec Analysis

1. **Analyze the spec**: Take the rough specification provided by the user and analyze it to
   understand:
   - Main objective and goals
   - Technical components needed
   - Potential ambiguities or gaps

2. **Ask for clarifications**: If anything is unclear or missing after the interview, ask the user
   specific questions to gather the information needed.

3. **Determine the project**: Based on the spec and which bot/package is affected, use your best
   judgement to determine the most appropriate Linear team and project. Refer to the Team IDs table
   in CLAUDE.md for team mappings. If unclear, ask the user. For project mode: different issues may
   belong to different teams/projects — assign each appropriately.

4. **Create an implementation plan** that an AI agent can follow:
   - Architecture decisions and patterns to follow
   - File structure and components to create/modify
   - Dependencies to add
   - Step-by-step implementation guide with specific code locations
   - Testing approach (unit tests, integration tests)

### Phase 3.5: Agent Consultation

After drafting the implementation plan, review the agent team (`.claude/agents/`) and invoke any
agents whose trigger conditions match the planned work. Incorporate their output into the
implementation plan before proceeding to ticket creation. For example, the
`morpho-protocol-engineer` may provide ABI references and protocol mechanics, while the `documentor`
may identify the need for a TIB that should be referenced in the tickets.

### Phase 4: Breakdown and Ticket Creation

Follow **one** of the two paths below based on the planning scale determined in Phase 2.

#### Issue Mode

1. **Break down into sub-issues**: Create Linear sub-issues where each one:
   - Can be implemented as an independent PR
   - Has clear acceptance criteria
   - Contains ALL context needed for an AI to implement it
   - Is sized appropriately
   - Includes specific implementation steps

2. **Create the Linear tickets**: Use the Linear MCP to:
   - Create a main parent issue with the high-level spec and implementation plan
   - Create sub-issues for each independent task with more task specific detail
   - Link sub-issues to the parent
   - Set the appropriate team (refer to Team IDs table in CLAUDE.md)

#### Project Mode

1. **Define workstreams**: Group the work into logical workstreams — each workstream becomes a
   top-level issue. A workstream should be:
   - A cohesive unit of work (e.g., "Trigger logic", "Chain client", "Observability")
   - Independently plannable and assignable
   - Clear about its boundaries and interfaces with other workstreams

2. **Identify dependencies between workstreams**: Map out which workstreams depend on others and in
   what order they should be tackled. Note shared interfaces or contracts between workstreams.

3. **Break each workstream into sub-issues**: Each top-level workstream issue gets its own sub-issues
   following the same rules as issue mode (independent PRs, clear acceptance criteria, full context).

4. **Create a Linear project** (if one doesn't already exist): Use the Linear MCP to:
   - Create or reuse a Linear project for the initiative
   - Create top-level issues for each workstream with full spec and implementation plan
   - Create sub-issues under each workstream issue
   - Set the appropriate team for each issue (refer to Team IDs table in CLAUDE.md)
   - Add dependency notes in issue descriptions where workstreams depend on each other

5. **Present a project summary** to the user showing:
   - The project name and description
   - All workstreams with their issue counts
   - A dependency graph or ordered execution plan
   - Total issue count and suggested execution order

## Ticket Format

### Project Description (project mode only)

When creating a Linear project, include:

- **Vision**: What we're building and the end-state goal
- **Motivation**: Why this project exists and what problem it solves
- **Scope**: What's included and explicitly what's excluded
- **Workstreams**: Summary of each workstream and how they connect
- **Dependencies**: Cross-workstream dependencies and execution order
- **Success Criteria**: How we know the project is complete

### Workstream / Parent Issue

- **Overview**: Clear description of what we're building and why
- **Technical Requirements**: Specific technical needs
- **Acceptance Criteria**: Checklist of what defines "done"
- **Implementation Plan**: Architecture, dependencies, approach
- **Testing Strategy**: How to verify it works
- **Dependencies** (project mode): Which other workstreams this depends on or unblocks

### Sub-issues

- **Context**: Link to parent and explain this piece
- **Implementation Steps**: Numbered list of exactly what to do
- **Files to Modify**: Specific file paths
- **Dependencies**: What must be done before this (both within and across workstreams)
- **Testing**: Specific tests to write
- **Acceptance Criteria**: What defines this sub-task as complete

Remember: The goal is to create tickets so detailed that an AI agent can pick them up and implement
them without needing additional context.
