# create-issue

Add a new ticket to the correct Linear backlog project based on scope, with an enforced 3-section description template.

## Instructions

You are helping the user triage a backlog item. This is a lightweight flow to create a well-structured Linear ticket. Do NOT try to create an implementation plan or branch — this is backlog triage only.

---

## Project Routing Table

Use this table to determine the correct team and project based on scope:

| Scope                                              | Project               | Project ID                             | Team    | Team ID                                |
| -------------------------------------------------- | --------------------- | -------------------------------------- | ------- | -------------------------------------- |
| `bots/*`, `packages/*`, `@repo/*`, repo-wide infra | Curator Backlog       | `d2b6d657-c059-4d9b-8f55-aa98390ab81f` | Curator | `c07ff95f-03b7-4bee-aa17-c7e04fda8845` |
| Cross-repo infra shared with `morpho-apps`         | Apps Monorepo Backlog | `1127eedb-8ef7-49e8-b8c7-9f9e2e47f9c8` | Apps    | `cc8fe27e-f516-45e8-921e-69b0562c7792` |

---

## Enforced Description Template

Every ticket created by this command MUST use exactly this structure:

```markdown
## Context
[Direct description of the problem or feature — what's wrong or what's needed]

## References
- [file paths with line numbers when known, related issue IDs — omit entire section if none]

## Possible solution
> ⚠️ AI-generated — treat as a starting point, not a prescription.

[Brief suggestion]
```

Rules:

- **Context**: 1–3 sentences, declarative prose. No sub-headers.
- **References**: Bullet list of file paths (with line numbers when known) and related issue IDs. Omit the entire section if there are genuinely none.
- **Possible solution**: Short, non-prescriptive. Always prefixed with the AI warning blockquote.

---

### Step 1: Get description

Check `$ARGUMENTS`:

- If provided, use as the basis for the ticket
- If empty, ask: _"What should go in the backlog? (brief description)"_

### Step 2: Infer scope and route to project

From the description, determine the target using the routing table above:

- Mentions `apps/curator-*` → **Curator Backlog** (CRTR)
- Mentions `apps/markets-v2-app` → **Markets v2 App** (MKT)
- Mentions `@repo/*`, infra, tooling, or cross-cutting concerns → **Apps Monorepo Backlog** (APPS)
- If ambiguous, ask the user to pick from the three options above

### Step 3: Generate title + draft description

- **Title**: Follow the title convention
- **Description**: Full 3-section template (Context / References / Possible solution), AI-inferred from the user's description

### Step 4: Present for confirmation

Show the proposed ticket details and ask the user to confirm or edit:

```
Title:       <generated title>
Project:     <inferred project name> (<team identifier>)
Description:
---
## Context
...

## References
...

## Possible solution
> ⚠️ AI-generated — treat as a starting point, not a prescription.
...
---
```

Then ask:

**Label**: `Bug`, `Feature`, `Improvement`, or `Documentation`

**Priority** (default: Low / 4):

- 1 = Urgent
- 2 = High
- 3 = Normal
- 4 = Low (default for backlog)

**Estimate** (optional, in points):

- 1 = Small (straightforward change, well-understood)
- 2 = Medium (some complexity or unknowns)
- 3 = Large (significant work or cross-cutting)
- 5 = XL (major effort, consider breaking down)

Allow the user to edit any field before proceeding.

### Step 5: Create ticket

Use `mcp__linear__create_issue` with:

- `title`
- `description` (3-section template, formatted as markdown)
- `team` (team ID from routing table)
- `project` (project ID from routing table)
- `labels` (label names as an array, e.g. `["Feature"]`)
- `priority` (number 1–4)
- `estimate` (number: 1, 2, 3, or 5 — omit if not specified)
- Leave `assignee` unassigned by default — only set if the user explicitly specifies one

### Step 6: Confirm

```
Created <IDENTIFIER> — <title>
<linear-url>
```

No branch creation — this is backlog triage only.

---

## Example Flows

**User**: `/create-issue fix flicker in curator sidebar`

**Claude**: Routes to Curator Backlog (CRTR). Generates:

```
Title:   fix(cv2): resolve sidebar flicker on mount
Project: Curator Backlog (CRTR)

## Context
The curator app sidebar flickers on initial mount, causing a jarring visual artifact for users.

## References
- apps/curator-v2-app/components/Sidebar.tsx

## Possible solution
> ⚠️ AI-generated — treat as a starting point, not a prescription.

Investigate whether a CSS transition or a layout shift during hydration is the cause. Adding a visibility guard or deferring the animation until after mount may resolve the flicker.
```

Label? Priority?

---

**User**: `/create-issue add chart to markets v2 app`

**Claude**: Routes to Markets v2 App (MKT).

---

**User**: `/create-issue improve @repo/ui table performance`

**Claude**: Routes to Apps Monorepo Backlog (APPS).

---

## Notes

- Always use the project ID (not just the name) when calling `mcp__linear__create_issue`
- The description must include all 3 sections — omit References only if genuinely none exist
- Default priority for backlog items is Low (4)
- Do not create a git branch — this command is for triage only
