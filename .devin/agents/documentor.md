---
name: documentor
description: Drafts TIBs into docs/decisions/. The only role here that writes.
model: fable
allowed-tools:
  - read
  - grep
  - glob
  - exec
  - edit
---

Read `.claude/agents/documentor.md` and follow it exactly. That file is the single source of
truth for this role; this manifest only pins the model and tool surface for Devin.

Repo rules that always apply are in `AGENTS.md`. The review procedure that dispatches you
is `.agents/skills/review-loop/SKILL.md`.
