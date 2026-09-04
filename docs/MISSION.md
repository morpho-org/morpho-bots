# Mission — Escape Velocity

## North Star

> **A codebase where humans only ever decide _what_ to build and _whether_ it's good — and everything else, the _how_, the _upkeep_, and the _defense_, is handled autonomously.**

Every codebase decays. Dependencies drift, docs go stale, patterns fork, knowledge leaks
out of the repo and into people's heads, and security debt accrues silently until it's a
crisis. The default trajectory of all software is entropy.

Our mission is to escape that trajectory. With AI as a first-class part of the system — not
a bolt-on — we aim for the point where the repo's capacity to maintain, secure, and improve
itself **exceeds its rate of decay**. Past that line — _escape velocity_ — the monorepo
trends toward _more_ consistent, _better_ documented, _more_ secure, and _easier_ to work in
with every passing week, with less human toil, not more.

This is aspirational on purpose. We will probably never fully "arrive." But every decision
should bend toward it. The goal is not to remove humans from the loop — it's to remove
everything from the loop that **isn't** human judgment, so the people here spend their time
on taste, product, and the problems that are actually hard.

---

## Guiding Principles

These hold even as the tools and tactics change.

1. **Intent over mechanics.** A developer expresses _what_ they want and _why_. Wiring,
   boilerplate, config, and ceremony are the system's job, not theirs.
2. **Convergence over divergence.** Apps share and converge on the single best
   implementation of a pattern. Copy-paste-and-drift is a defect, not a shortcut.
3. **Context is a first-class artifact.** If a senior engineer knows it, the repo encodes
   it — machine-legible and human-legible. No load-bearing knowledge lives only in
   someone's head.
4. **Security is existential.** This is DeFi. User funds are sacred. Defense in depth is the
   floor, not the ceiling.
5. **Evidence over assertion.** Nothing is "done" until it's proven.
6. **Toil is a bug.** Any maintenance task a human does twice is a defect to be automated
   away.
7. **Engineer for negative entropy.** Every merge should leave the repo healthier than it
   found it.

---

## The Pillars — our high-level goals

### A. An AI-native codebase

The repo is designed to be understood and operated by agents as easily as by people.

- A **context system** so complete that any frontier model, dropped in cold, reaches
  senior-engineer fluency in minutes — conventions, data flow, domain glossary, ownership,
  and gotchas are _ambient_, never re-pasted.
- Every package and app is **agent-legible**: it can describe its own purpose, capabilities,
  chains, and correct usage.
- **Spec-driven development**: humans (and PMs) describe intent; agents implement; types,
  tests, and review gates enforce correctness. People review outcomes, not keystrokes.
- A coordinated **team of specialist agents** — triage, build, review, docs, protocol,
  security, release, on-call — that mirrors a full engineering org.

### B. A self-defending codebase

Security is automated, continuous, and existential.

- **No vulnerability survives a sleep cycle.** A CVE anywhere in the dependency tree is
  assessed, patched, tested, and PR'd automatically — respecting the release-age gate.
- **A change that could lose user funds cannot reach `main`.** Every on-chain interaction is
  checked against an attack-pattern catalog (reentrancy, oracle manipulation, unbounded
  approvals, slippage) and must prove its funds-at-risk path is safe.
- **Zero-trust supply chain**: dependencies are pinned, provenance-checked, and vetted.
  Secrets never touch git, and rotation is automatic if they are ever exposed.

### C. A self-healing codebase

The system observes itself and fixes itself, with humans approving — not authoring.

- **Production signals become pull requests.** A BetterStack alert or error spike triages
  itself from logs, error tracking, and recent diffs, and arrives as a PR with a fix and a
  regression test.
- **Bug reports are handled end-to-end by agents**: reproduce against a preview deploy, write
  a failing test, fix, open a PR. The human reviews intent and outcome.
- **Flakiness can't accumulate**: flaky tests are detected statistically, quarantined, and
  fixed.
- **Human-led maintenance trends toward zero**, freeing people for product and creative work.

### D. A self-improving codebase

Quality is a ratchet that only tightens.

- Trends toward **zero warnings, zero dead code (knip-clean), fully typed (no `any`), fully
  documented** — enforced by gates, assisted by background agents.
- **One blessed way to do each thing — and a standing challenge to better it.** The most
  advanced implementation is the reference; deviations are auto-flagged and pulled back into
  shared packages. But the blessed pattern is never sacred: it's continually challenged, and a
  demonstrably better approach becomes the new reference.
- **Production-grade by default**: every app is born with observability, error tracking,
  performance budgets (Core Web Vitals), accessibility, and security wired in.
- **Framework currency is automatic**: Next.js, React, wagmi, and viem upgrades sweep every
  app to the same pinned version with codemods and green CI. No app is left behind.

### E. A frictionless codebase

The path from "I want to build X" to a running, deployed thing is nearly instantaneous.

- **Clone → one command (or one conversation) → everything running**: env pulled, all apps
  and tests up and interactable, green across the board.
- **A new app in minutes**, complete with web3, the design system, and observability, plus a
  passing test — the developer writes only the feature.
- **Onboarding by conversation**: an agent that notices a developer isn't set up and just
  does it for them.

---

## "It Just Works" — success criteria

Concrete scenarios. Each is an implicit acceptance test: when these are routinely true,
we're near the line.

**Onboarding & setup**

1. A new hire clones and says _"set me up"_ — env pulled, every app and test running green —
   with **zero "where do I get this env var?" messages**.
2. Someone who has never opened the repo asks the agent for a change; it notices they aren't
   set up, does it, then guides the work — **productive in one conversation**.

**Building**

3. _"Create a new app for X"_ yields a Next.js app on the reference version, wired with
   `@repo/web3` (right chains and ABIs), `@repo/ui`, and observability, plus a passing test —
   **the developer writes only the feature**.
4. A developer describes a new on-chain flow; the protocol agent produces the canonical
   ActionFlow with simulation, approvals, and security checks applied — **safe by
   construction**.

**Anyone can contribute**

5. A non-engineer — a PM or a designer — describes a change to an existing app, or a whole
   new one, in plain language and ships it through the agent, **without ever touching the
   underlying implementation**.
6. An engineer reviewing that work finds the same patterns, tooling, and structure they'd
   expect from a teammate — **it's no harder to review than another engineer's PR**.

**Consistency**

7. Asking for the _best_ version of a pattern returns the single blessed implementation,
   reused or promoted to a shared package — **never copy-paste-drift**.
8. A Next.js major release sweeps every app to one pin with codemods and green CI — **no app
   left behind**.

**Context**

9. _"How does VVRM data flow from chain to UI?"_ gets an accurate, current answer from the
   repo itself — **nobody pings the original author**.
10. An agent picking up any task already has the conventions, data flow, and gotchas it needs
    — **without the human re-pasting a word of context**.

**Continuous QA**

11. Every change to every app is exercised on staging by an AI QA pass that drives the real
    UI: it catches regressions, opens a PR with the fix, and extends the end-to-end suite to
    cover them — **regressions are caught before a human ever clicks through**.

**Self-defense**

12. A 2am CVE is assessed, patched, tested, and PR'd within minutes — **no vulnerability
    survives a sleep cycle**.
13. A risky contract call is blocked until its funds-at-risk path is proven safe — **a change
    that could lose user funds can't reach `main`**.
14. A pasted secret is caught before it lands and rotation is triggered — **secrets never
    live in git**.

**Self-healing**

15. A BetterStack alert arrives as a PR with a fix and a regression test — **often the only
    human step is approval**.
16. A bug report is reproduced, tested, and fixed by an agent — **the human reviews intent,
    not mechanics**.
17. Flaky tests are detected, quarantined, and fixed — **flakiness never accumulates**.

**Health**

18. Dead code, unused deps, doc drift, and convention violations are continuously swept — the
    repo is **measurably healthier this month than last**.

---

## Horizons — the ladder to the North Star

Like reusable rockets before Mars, the impossible is reached in stages of increasing
autonomy.

| Horizon                             | Human role                                  | The system's role                                                                        |
| ----------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Today**                           | Author + operator; agents assist on request | Agents, skills, conventions, observability, CI auto-release exist in seed form           |
| **Horizon 1 — Assisted**            | Author; agents handle well-scoped tasks     | One-command setup; scaffolding; agent-authored PRs reviewed by humans                    |
| **Horizon 2 — Supervised autonomy** | Reviewer + director                         | Security patches, bug fixes, dep/framework upgrades arrive as PRs; humans approve        |
| **Horizon 3 — Escape velocity**     | Taste + product judgment                    | The codebase maintains, defends, and improves itself; humans decide _what_ and _whether_ |

---

## We'll know we've arrived when…

- A single developer operates with the leverage of a platform team many times their size.
- The scariest part of a dependency CVE is how _boring_ the fix PR is by the time anyone
  reads it.
- "Tribal knowledge" is a phrase no one in the repo uses anymore.
- The honest answer to _"how do I set up / add an app / do this safely?"_ is **"just ask the
  repo."**
- The codebase is the kind of thing other teams want to fork as the reference for how to
  build AI-native web3 software.
