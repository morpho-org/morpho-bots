# learn

Extract learnings from the current conversation and persist them as rules

## Instructions

You are reviewing the current conversation to extract reusable rules from mistakes, corrections,
and failures. Your goal is to identify learnable moments and propose where to persist them so future
sessions benefit.

### Step 1: Scan the conversation

Review the full conversation and identify learnable moments in three categories:

1. **Direct corrections** — The user corrected your approach or output. Look for patterns like:
   - "no, don't…", "actually…", "I meant…", "instead do…", "let's not…"
   - Explicit corrections to generated code (user rewrites or asks for different approach)
   - Rejected tool calls or reverted changes

2. **Failure reports** — The user reported that your changes caused breakage:
   - "it didn't work", "it failed", "it's broken", "that broke…", "still not working"
   - The user describing unexpected behavior after your changes

3. **Failed verification** — Typecheck errors, lint failures, or test failures that occurred as a
   direct result of your changes (not pre-existing). Cases where you had to iterate to fix your own
   mistakes.

For each learnable moment, extract:

- **What went wrong**: the specific mistake or gap
- **The correct approach**: what should have been done instead
- **Why**: the reasoning behind the correct approach

Skip moments that are:

- Already captured in auto-memory (`~/.claude/projects/.../memory/`)
- Already documented in `docs/CONVENTIONS.md`
- Too specific to the current task to be reusable in future sessions
- One-off misunderstandings resolved by clarification (not a pattern)

### Step 2: Choose a destination for each rule

For each extracted rule, propose a destination:

- **Feedback memory** — For user-specific preferences and simple one-liner rules. These live in the
  user's auto-memory and are loaded into every conversation.
  - Example: "Always use full descriptive names in callbacks, not shortened variables"

- **CONVENTIONS.md** — For team-wide rules that should apply to all agents and team members. These
  are checked into the repo and shared.
  - Example: "Use `tryCatch` from `@repo/utils` instead of try/catch blocks for promise handling"

- **Skill** (`.claude/skills/`) — For structured, auto-triggered procedures. Propose a skill when:
  - A related feedback memory already exists but didn't prevent the mistake (escalation from memory)
  - The correct approach requires a multi-step checklist, not a one-liner
  - You went through 3+ iteration rounds to fix your own changes (significant struggle suggests the
    knowledge is complex enough to need structure)
  - The rule is context-specific — only applies in certain parts of the codebase or under certain
    conditions (skills have trigger descriptions in frontmatter that control when they activate)
  - Example: "When adding a new oRPC resource: 1) create procedure file, 2) register in router
    index, 3) add base procedure if scoped, 4) update types"

### Step 3: Present the plan

Present all findings as a numbered list. For each item include:

```
## Proposed learnings

| # | Rule | Source | Destination | Rationale |
|---|------|--------|-------------|-----------|
| 1 | <the extracted rule, concise> | <brief quote or reference to the conversation moment> | Memory / CONVENTIONS.md / Skill | <why this destination> |
| 2 | ... | ... | ... | ... |
```

If no learnable moments were found, say so and end.

### Step 4: Wait for approval

After presenting the plan, ask the user how they'd like to proceed:

- **Approve all** — write all proposed rules to their destinations
- **Approve selectively** — approve specific items by number (e.g., "1, 3, 5")
- **Propose changes** — free-form feedback to reword rules, change destinations, merge items, or
  anything else
- **Decline all** — discard everything

Do NOT write anything until the user approves. If the user proposes changes, incorporate them and
re-present the updated plan for another round of approval.

### Step 5: Write approved rules

Once approved, write each rule to its destination:

**For feedback memories:**

- Create a file in the user's auto-memory directory following the existing naming pattern
- Add frontmatter with name, description, and type: feedback
- Update MEMORY.md index

**For CONVENTIONS.md:**

- Add the rule to the appropriate section in `docs/CONVENTIONS.md`
- If no existing section fits, create a new one following the file's structure

**For skills:**

- Create a new skill directory under `.claude/skills/`
- Include a `SKILL.md` with proper frontmatter (name, description, trigger conditions)
- Add rule files as needed following the existing skill structure (see
  `.claude/skills/vercel-react-best-practices/` for reference)

After writing, confirm what was written and where.
