# create-issue

Add a new ticket to the correct Linear backlog project based on scope, with an enforced 3-section description template.

## Instructions

You are helping the user triage a backlog item. This is a lightweight flow to create a well-structured Linear ticket. Do NOT try to create an implementation plan or branch — this is backlog triage only.

---

## Routing

Everything in this repo goes to the **Bots** team (`06143345-2d87-4485-9ff9-f0759f7b9a48`, `BOTS`).

**Do not set a project.** The Linear agent assigns projects; a project set here fights it. Labels
are how tickets are routed by surface, not projects.

The one exception: `@morpho-org/viem-dlc` issues go to the **Apps** team
(`cc8fe27e-f516-45e8-921e-69b0562c7792`) in the **Viem-dlc Backlog** project
(`6d884c18-7fcb-49c9-8809-0863e2d8607d`) — the only case where a project is set explicitly.

Other Morpho-owned dependencies have mixed Linear conventions across teams. Do not file those
automatically — surface them to the user and let them place the ticket.

See [`docs/GUIDANCE.md`](../../docs/GUIDANCE.md) for the canonical table.

## Labels

Apply the label(s) for the bot(s) or package(s) the work touches. Current surface labels:

`Blue Liquidation` · `Midnight Liquidation` · `Midnight Crossed Books` · `Midnight Quoter` ·
`Vault V1 Reallocation` · `Vault V2 Reallocation` · `Bot Kit` · `agent` (anything under `.claude/`)

Kind labels (`Bug`, `Feature`, `Improvement`, `Documentation`, `Monitoring`, `Alerting`,
`Integration`, `incident`) may be added alongside.

**Provenance.** A ticket that exists because a review surfaced something and it was explicitly
deferred gets `code-review` (the `Provenance` group), and its description links the originating PR
or TIB. Provenance is not priority — the status already says "not now"; this says where it came
from.

Several packages have no label yet — `@repo/swaps`, `observability`, `offers`, `logging`,
`contracts`, `utils`, and `services/quoter-signer` among them. If none fits the surface you are
filing against, **say so to the user** rather than filing unlabelled or inventing a label. Do not
create labels yourself.

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

### Step 2: Infer scope and pick labels

Team is **Bots** unless the ticket is about `@morpho-org/viem-dlc` (see Routing). From the
description, determine which bot(s) or package(s) the work touches and pick the matching label(s).
If no existing label fits, flag it rather than guessing.

### Step 3: Generate title + draft description

- **Title**: Follow the title convention
- **Description**: Full 3-section template (Context / References / Possible solution), AI-inferred from the user's description

### Step 4: Present for confirmation

Show the proposed ticket details and ask the user to confirm or edit:

```
Title:       <generated title>
Team:        <Bots or Apps>
Project:     omitted (unless this is `@morpho-org/viem-dlc`)
Assignee:    <current user name> (you)
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

**Assignee** (default: current user): Resolve the current user via `mcp__linear__get_user` with `query: "me"` and default the assignee to them. Show the resolved name in the confirmation, e.g. `Assignee: <name> (you)`. The user may reassign to someone else (resolve via `mcp__linear__list_users`) or explicitly clear it to leave the ticket unassigned.

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
- `team` (Bots — or Apps for `viem-dlc`)
- `labels` (label names as an array, e.g. `["Bot Kit", "Bug"]`) — surface label(s) plus optional kind
- `project` — **omit**, except for `viem-dlc` tickets, which take the Viem-dlc Backlog project ID
- `priority` (number 1–4)
- `estimate` (number: 1, 2, 3, or 5 — omit if not specified)
- `assignee` (defaults to the current user resolved in Step 4 via `mcp__linear__get_user` with `query: "me"`) — omit only if the user explicitly chose to leave it unassigned

### Step 6: Confirm

```
Created <IDENTIFIER> — <title>
<linear-url>
```

No branch creation — this is backlog triage only.

---

## Example Flows

**User**: `/create-issue add retry-with-backoff to kill-switch deallocate calls`

**Claude**: Routes to Bots (BOTS). Generates:

```
Title:    feat(kill-switch): add retry-with-backoff to deallocate calls
Project:  omitted
Assignee: <current user name> (you)

## Context
The kill-switch bot aborts the trigger loop on any transient RPC failure from the VaultV2
deallocate call. Operators then have to re-run manually.

## References
- bots/kill-switch/src/actions/deallocate.ts

## Possible solution
> ⚠️ AI-generated — treat as a starting point, not a prescription.

Wrap the deallocate call site in a retry-with-backoff helper (3 attempts, exponential backoff).
Distinguish "will revert" from "estimation failed" before retrying — don't retry on a genuine
revert.
```

Label? Priority?

---

**User**: `/create-issue add bigint helpers to @repo/utils`

**Claude**: Routes to Bots (BOTS).

---

**User**: `/create-issue align lint config with morpho-apps base rules`

**Claude**: Routes to Bots (BOTS) — it is work in this repo, whoever else shares the convention.
No surface label covers repo-wide tooling, so it says so instead of inventing one:

```
Title:    chore(tooling): align lint config with morpho-apps base rules
Team:     Bots (BOTS)
Project:  omitted
Labels:   none — no existing label covers repo-wide tooling. Add one, or file unlabelled?
```

---

**User**: `/create-issue blue-sdk misreports accrued interest at maturity`

**Claude**: Does not file. `@morpho-org/blue-sdk` is a Morpho-owned dependency, and those have
mixed Linear conventions across teams — surfaces it and asks where it belongs. (`viem-dlc` is the
one dependency with a settled answer: Apps, Viem-dlc Backlog.)

---

## Notes

- Omit `project` when calling `mcp__linear__create_issue`, except for `@morpho-org/viem-dlc`
- The description must include all 3 sections — omit References only if genuinely none exist
- Default priority for backlog items is Low (4)
- Default assignee is the current user (resolved via `mcp__linear__get_user` with `query: "me"`) — only leave unassigned if the user explicitly asks
- Do not create a git branch — this command is for triage only
