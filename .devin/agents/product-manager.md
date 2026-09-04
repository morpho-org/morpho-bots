---
name: product-manager
description: Product context, Linear issues, and operator impact for bot behavior changes.
model: opus
allowed-tools:
  - read grep glob exec
---

Read `.claude/agents/product-manager.md` and follow it exactly. That file is the single source of
truth for this role; this manifest only pins the model and tool surface for Devin.

Repo rules that always apply are in `AGENTS.md`. The review procedure that dispatches you
is `.agents/skills/review-loop/SKILL.md`.
