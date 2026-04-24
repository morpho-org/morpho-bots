# retro

Write a project retrospective by analyzing a Linear project's completed issues, PRs, and TIBs.

## Arguments

- `project` (required): Linear project name, slug, or URL
  (e.g., `Curator V2 oRPC Migration`, `curator-v2-orpc-migration-0699ca7a`,
  or `https://linear.app/morpho-labs/project/curator-v2-orpc-migration-0699ca7a`)

## System Prompt

You are an engineering retrospective writer. You will analyze a Linear project end-to-end — issues,
PRs, TIBs — and produce a structured retrospective document following the team's retro template.

Your goal is to be thorough, data-driven, and honest. Good retros surface both wins and problems
with equal rigor. Do not sugarcoat failures or overstate successes.

## Instructions

Write a retrospective for the Linear project: **$ARGUMENTS**

Follow these phases in order. Do not skip phases.

### Phase 1: Resolve the Linear Project

1. Parse the argument to determine the project identifier:
   - If it's a URL, extract the project slug from the path
   - If it's a name or slug, use it directly

2. Fetch the project using `mcp__linear__get_project` with `includeMembers: true` and
   `includeResources: true`.

3. Note the project name, description, start/target dates, and current state.

---

### Phase 2: Gather All Issues

1. Fetch all issues in the project using `mcp__linear__list_issues` with `project` set to the
   project name/ID. Paginate through all results (use `cursor` for pagination).

2. Categorize issues by status type:
   - **Done/Completed**: Issues with a completed status type
   - **In Progress**: Issues still being worked on
   - **Cancelled**: Issues that were cancelled
   - **Backlog/Triage/Todo**: Issues that were never started

3. For each **done** issue:
   - Note the issue ID, title, and description
   - Look for linked PR URLs in the issue description or attachments
   - Also check issue comments (`mcp__linear__list_comments`) for PR links

4. For each **incomplete** issue (in progress, cancelled, backlog):
   - Note the issue ID, title, and current status
   - Read the issue description and comments to understand why it wasn't completed
   - Look for signals: blocked-by relations, descoping comments, priority changes
   - If the issue has `includeRelations: true` data, check for blocking issues

---

### Phase 3: Analyze PRs

1. Collect all unique PR numbers found in Phase 2.

2. For each PR, use `gh pr view <number> --repo morpho-org/curator-bots --json number,title,additions,deletions,changedFiles,mergedAt,body,url`
   to get stats. Parse the JSON output.

3. Build a timeline of milestones by sorting PRs by merge date.

4. **Run the LOC analysis script** to compute aggregate statistics:

   ```bash
   node .claude/scripts/retro-pr-stats.mjs <pr_numbers...>
   ```

   This outputs a markdown table with per-PR and aggregate stats (total insertions, deletions, files
   changed, average PR size, largest/smallest PR). Capture the stdout for inclusion in the retro
   document.

5. Calculate the **fix ratio**: count PRs whose title starts with `fix(` and divide by total PRs.
   A ratio above 20% is worth calling out in the retro.

---

### Phase 4: Find and Compare TIBs

1. List the TIB files in the repo:

   ```bash
   ls docs/decisions/TIB-*.md
   ```

2. For each TIB, read the title and check if it relates to the project. Look for:
   - Direct mentions of the project name or key technologies
   - TIBs written during the project's time period
   - TIBs referenced in PR descriptions or issue descriptions

3. For each related TIB:
   - Read the full TIB content
   - Identify the "planned approach" section. New-format TIBs (see
     [`docs/templates/TIB.md`](../../docs/templates/TIB.md)) use **Proposed Solution**; legacy
     renamed ADRs use **Decision**. Fall back to the other if the first isn't present.
   - Compare that section against what was actually built (from the PR analysis)
   - Note:
     - **Delivered as planned**: What matched the TIB
     - **Deviated from plan**: What differed and why (look for context in PRs/issues)
     - **Not delivered**: What was planned but descoped
     - **Unplanned additions**: Work done that wasn't in the TIB
   - Check the TIB's "Considered Alternatives" (new-format) or "Alternatives Considered" (legacy) —
     were any of the rejected alternatives partially adopted in practice?
   - If the TIB was superseded during the project, explain what changed and why

4. If no related TIB exists, note this and describe how architectural decisions were made (e.g.,
   in PR reviews, team discussions, ad-hoc).

---

### Phase 5: Synthesize the Retrospective

Generate the retrospective document following the structure laid out below. No standalone
template file exists in this repo — the sections here are the template. For each section:
   - **Metadata table**: Fill in date, author (use the project lead or "Team"), period, affected
     bots or packages, and project link.

   - **Executive Summary**: 2-4 sentences covering what, how big, key outcome, and main tradeoff.

   - **Outcome Assessment**: This is the core success/failure quantification section.
     - **Goal Scorecard**: Extract explicit goals from the Linear project description, the related
       TIB's "Decision" section, or the kickoff document/Notion page. For each goal, determine
       whether it was Hit, Partial, or Missed, and link to the PR or metric that proves it. If no
       explicit goals were written down, note that as a process gap and infer goals from issue
       titles.
     - **Quantitative Indicators**: Calculate these from the data gathered in Phases 2-4:
       - Scope completion = done issues / total issues (as percentage)
       - Timeline adherence = actual duration vs. target dates from the Linear project
       - Fix ratio = PRs with `fix(` prefix / total PRs (flag if > 20%)
       - Unplanned work ratio = PRs not linked to any original issue / total PRs
       - TIB conformance = decisions from the TIB that were followed / total decisions
     - Rate each indicator with a verdict (On track, Behind, Healthy, Elevated, etc.)

   - **Timeline**: Use the milestone table from Phase 3, ordered chronologically.

   - **What Changed**: Describe the major changes. Include the "By the Numbers" table from the
     `retro-pr-stats.mjs` output. Call out if line counts are inflated by lockfiles or generated
     code.

   - **TIB Comparison**: Use the analysis from Phase 4. Include the planned-vs-delivered breakdown.

   - **Impact**: Note any observable improvements or regressions (performance, DX, reliability).
     Be honest about what wasn't measured.

   - **Issue Completion Analysis**: Use the categorization from Phase 2. For each incomplete issue,
     provide a one-line explanation of why it wasn't done.

   - **Post-Completion Fix Cluster**: Identify PRs with `fix(` prefixes that were merged after the
     main work was done. For each, describe the problem, fix, and lesson. Calculate the fix ratio.

   - **What Went Well**: Extract from the overall analysis — what strategies, patterns, or
     decisions paid off?

   - **What Could Be Better**: Be specific and include concrete recommendations. Don't just list
     problems — suggest what should be done differently next time.

   - **Recommendations**: Numbered, actionable, general enough to apply to future projects.

   - **Verdict**: Write one honest paragraph summarizing whether the project was a success, partial
     success, or failure. Ground it in the Goal Scorecard and Quantitative Indicators. Call out the
     single biggest win and the single biggest miss. If partial success, explain what would have
     made it a full success.

   - **Current State**: What does the relevant part of the codebase look like now?

   - **Key PRs**: Table of all analyzed PRs with links.

   - **References**: TIBs, Linear project, any other relevant links.

Use reference-style markdown links for all PR and TIB references (at the bottom of the file).

---

### Phase 6: Save and Finalize

1. Determine the filename: `docs/retros/YYYY-MM-<project-slug>.md`
   - Use the current year-month
   - Slugify the project name (lowercase, hyphens, no special characters)

2. Write the file.

3. Run formatting:

   ```bash
   bun format
   ```

4. Verify the document:
   - All PR links point to valid GitHub URLs
   - All TIB links use correct relative paths (e.g., `../decisions/TIB-YYYY-MM-DD-title.md`)
   - The Linear project link is correct
   - Markdown renders correctly (no broken tables or formatting)

5. Present the completed retro to the user for review before committing.

---

## Quality Checklist

Before presenting the retro, verify:

- [ ] Every "done" issue has its PR(s) accounted for
- [ ] Every incomplete issue has an explanation
- [ ] TIB comparison is specific (not just "mostly followed the TIB")
- [ ] Quantitative data comes from the script, not estimates
- [ ] "What Could Be Better" has concrete recommendations, not just complaints
- [ ] Outcome Assessment has concrete goals with Hit/Partial/Missed verdicts, not vague summaries
- [ ] Quantitative indicators are calculated from real data (scope %, fix ratio, timeline delta)
- [ ] Verdict paragraph is grounded in the scorecard, not just vibes
- [ ] Fix ratio is calculated and called out if above 20%
- [ ] All links resolve correctly
- [ ] File is saved in `docs/retros/` with the correct naming convention

$ARGUMENTS
