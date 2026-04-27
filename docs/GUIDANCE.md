# Documentation Guidance

This document explains when to write a TIB, how the TIB process works, and how TIBs relate to
Linear project specs and RFCs.

---

## When to Write a TIB

> **Write a TIB when the decision will outlive the ticket.**
>
> If someone will ask "why did we do it this way?" 6 months from now and the answer isn't obvious
> from the code, that's a TIB.

Concrete signals:

- **Choosing between approaches** — new library, new pattern, new architectural boundary
- **Changing or establishing a convention** — API design, error handling, caching strategy
- **Introducing or removing a significant dependency** — frameworks, infrastructure, third-party
  services
- **Deprecating or replacing something** — migrating away from an existing pattern
- **Cross-bot or cross-package implications** — the decision affects more than one bot or package
- **It generated debate** — if there was meaningful discussion, record the outcome

### When you don't need a TIB

- **Feature implementation using established patterns** — the TIB already exists; just reference it
  in the Linear ticket
- **Bug fixes or routine refactors** — the "why" is self-evident
- **Decisions scoped to a single module** with no wider system implications
- **Decisions already covered** by an existing TIB or established convention

### Examples

| Scenario                                                        | TIB?                                              | Linear? |
| --------------------------------------------------------------- | ------------------------------------------------- | ------- |
| Choosing a job scheduler for bots (cron vs. queue vs. Temporal) | Yes — TIB first, then Linear tickets              | Yes     |
| Adding a new bot that reuses the existing scheduler pattern     | No — pattern already decided in the scheduler TIB | Yes     |
| Migrating from library A to library B                           | Yes                                               | Yes     |
| Fixing a bug in a bot's reallocation logic                      | No                                                | Yes     |
| Changing how all bots handle RPC failover                       | Yes                                               | Yes     |

---

## TIB Process

Every TIB follows this lifecycle. The **author** (whoever opens the TIB PR) is responsible for
shepherding it through each step.

```
1. EXPLORATION
   │  Identify the decision to be made
   ↓
2. CONTEXT BUILDING
   │  Research, spikes, prototypes
   ↓
3. TIB DRAFT
   │  Open PR with status: Proposed
   ↓
4. ASYNC PRE-REVIEW
   │  Team reads and leaves written feedback
   ↓
5. TIB DISCUSSION CALL
   │  Dedicated meeting to resolve disagreements
   ↓
   ├─→ Major disagreements? Loop back to step 3
   ↓
6. INCORPORATE FEEDBACK
   │  Update draft from call outcomes
   ↓
7. PR REVIEW & APPROVAL
   │  Status → Accepted
   ↓
8. LINEAR PLANNING
   │  Specs and tickets flow from the accepted TIB
   ↓
9. COMPLETION CALL
   Demo the outcome to discussion-call stakeholders
```

### Step 1: Exploration

Recognise that a decision needs to be made. This often surfaces during feature planning, code
review, or when you find yourself debating approaches in Slack or a call.

**Output:** A clear problem statement — "we need to decide X because Y."

### Step 2: Context Building

Research the options. This might involve:

- Reading documentation for candidate libraries or patterns
- Building a quick spike or prototype to validate feasibility
- Reviewing how similar problems were solved elsewhere in the codebase
- Gathering constraints (performance requirements, compatibility, team expertise)

**Output:** Enough understanding to enumerate alternatives with meaningful pros/cons.

### Step 3: TIB Draft

Write the TIB using the [template](./templates/TIB.md) and open a PR with status `Proposed`.

At minimum, the draft should include:

- **Context** — the forces driving the decision; what made it necessary
- **Goals / Non-Goals** — what the TIB is trying to achieve and what it explicitly is not
- **Proposed Solution** — your recommended approach, stated clearly and concretely. If the
  solution has a meaningful order of operations, include an **Implementation Phases**
  sub-section outlining the high-level phases
- **Considered Alternatives** — at least 2 alternatives with a "why rejected" note
- **Assumptions & Constraints** — conditions the solution depends on

Additional optional sections — include only when they apply: **Current Solution**,
**Dependencies**, **Observability**, **Security**, **Future Considerations**, **Open Questions**,
**References**.

Don't aim for perfection — aim for "enough for the team to form opinions." The discussion call will
surface what's missing.

**Output:** An open PR in `docs/decisions/` (or the relevant bot/package `docs/decisions/`).

### Step 4: Async Pre-Review

Share the PR with the team and allow time for async review. Team members should:

- Read the full TIB
- Leave comments or questions on the PR
- Flag any missing alternatives or unconsidered consequences

This step ensures the discussion call is focused on resolving disagreements rather than reading the
TIB for the first time.

**Output:** PR comments and an informed team ready for the call.

### Step 5: TIB Discussion Call

Schedule a **dedicated meeting** for the TIB. The author facilitates. Record the call in Granola
and add the Granola link to the TIB's **References** section so context is easy to find later.

The agenda:

1. Author summarises the decision and recommendation (5 min max — everyone has already read it)
2. Walk through open PR comments and unresolved questions
3. Discuss disagreements on the recommended approach
4. Reach a decision or identify what's needed to reach one

**Possible outcomes:**

- **Consensus reached** → proceed to step 6 with clear action items
- **Minor feedback** → proceed to step 6, incorporate notes
- **Fundamental disagreement** → author revises the draft (back to step 3), schedules another async
  review and call

### Step 6: Incorporate Feedback

Update the TIB draft based on the call outcomes:

- Refine the decision statement if the recommendation changed
- Add alternatives or consequences that surfaced during discussion
- Resolve all open PR comments

### Step 7: PR Review & Approval

Request final PR approval. Once approved:

- Update the TIB status from `Proposed` to `Accepted`
- Merge the PR
- Add the TIB to `docs/INDEX.md` (create this file if it does not yet exist)

The TIB is now the permanent record of this decision. It must not be substantively edited after
acceptance — if the decision needs to change, write a new TIB that supersedes it.

### Step 8: Linear Planning

With the architectural decision settled, create Linear tickets that reference the TIB:

- The parent issue or project spec should link to the TIB and summarise the decided approach
- Sub-issues should contain implementation details that flow from the TIB's decision
- If the TIB defined specific patterns or interfaces, ticket acceptance criteria should reference
  them

### Step 9: Completion Call

Not every TIB needs a completion call — this is at the IC's discretion. A reasonable rule of thumb:
if the TIB required a kick-off discussion call (step 5), it should have a completion call too.

When applicable, schedule a **completion call** with the stakeholders from the original discussion
call (step 5). The author demos the outcome of the work — what was built, how the decision played
out in practice, and any deviations from the original plan.

**Why this matters:** Not every stakeholder can follow project progress in Linear or GitHub. This call
lets them catch up their mental model of what changed, ask questions, and flag any concerns before
the work is considered fully closed.

**Agenda:**

1. Brief recap of the original decision (1–2 min)
2. Demo the implemented outcome — show it working
3. Call out any deviations from the accepted TIB and why they were necessary
4. Open floor for questions and feedback
5. Decide whether a retrospective is warranted — if so, schedule it with enough lead time
   (typically 2–4 weeks after launch) for quantitative data on the work's impact to accumulate

**Output:** Stakeholders have an up-to-date understanding of what shipped and why, with a retro
scheduled if needed.

---

## How TIBs Relate to Other Docs

### TIBs and Linear Specs

TIBs and Linear specs are **complementary**, not mutually exclusive. They answer different questions:

|                             | TIB                                     | Linear Spec                          |
| --------------------------- | --------------------------------------- | ------------------------------------ |
| **Answers**                 | "Why this approach?"                    | "What are we building and when?"     |
| **Audience**                | Future developers (including AI agents) | Current team planning the work       |
| **Lifespan**                | Permanent, immutable record in the repo | Active during project, then archived |
| **Triggers implementation** | No — it records a decision              | Yes — tickets flow from it           |

**The relationship:** TIB first, Linear specs follow. The TIB settles the architectural approach,
then Linear breaks the accepted decision into deliverable work. Linear ticket descriptions,
acceptance criteria, and implementation plans should reference and stem from the TIB.

### TIBs and RFCs

A TIB frames a **decision** — the context, the options considered, and the consequences of the
choice made. An RFC explores a **problem** — surfacing a question and gathering input before options
can even be framed.

In most cases within this repo, **an RFC is unnecessary**. A well-written TIB with an Alternatives
Considered section provides the same trade-off analysis, and the PR review process provides the same
feedback loop.

**Only write a separate RFC when:**

- The decision meaningfully affects teams or systems outside this repo, who need to weigh in before
  options can even be framed
- The problem space is genuinely unclear and exploration is needed before you can enumerate
  alternatives
- Stakeholders require a longer comment period than a PR naturally affords

If an RFC produces a decision, it should be distilled into a TIB at close.

### Summary

|                    | TIB                               | Linear Spec                   | RFC                                |
| ------------------ | --------------------------------- | ----------------------------- | ---------------------------------- |
| **Purpose**        | Record an architectural decision  | Plan and track implementation | Explore a problem and gather input |
| **When written**   | Before decision is finalised      | After decision is settled     | Before options are even clear      |
| **Scope**          | This repo / system                | This repo / system            | Cross-team or cross-system         |
| **Lives in**       | Repo (`docs/decisions/`)          | Linear                        | Notion                             |
| **Default choice** | Yes — for architectural decisions | Yes — for all planned work    | Only when TIB alone isn't enough   |

When in doubt, write a TIB. A Proposed TIB reviewed via PR is almost always sufficient.
