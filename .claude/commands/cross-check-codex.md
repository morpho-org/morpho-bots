# cross-check-codex

Cross-check a plan by invoking a different AI provider for adversarial review. Catches blind spots,
challenges assumptions, and surfaces alternatives that the planning agent might miss.

## Usage

```
/cross-check-codex [plan text, Linear ticket ID, or omit to use the most recent plan from conversation]
```

## Instructions

### Step 1: CLI Availability Check

Check if the Codex CLI is installed:

```bash
which codex && codex --version
```

If `codex` is not found, inform the user that the Codex CLI is not installed or not in PATH, and
abort the command. Do not suggest installation steps — the user knows how to install it.

### Step 2: Gather the Plan

Check if a plan was provided as an argument: `$ARGUMENTS`

- **If a Linear ticket ID** (e.g., `APPS-123`, `CRTR-45`): fetch the issue via
  `mcp__linear__get_issue` and extract the implementation plan from its description. Also store the
  full ticket description and scope — you'll include it as context for Codex.
- **If plan text was provided**: use it directly. Check the conversation context for a related
  Linear ticket — if one exists, fetch it via `mcp__linear__get_issue` and store the ticket
  description and scope as additional context.
- **If empty**: look at the conversation context for the most recent plan (from plan mode or a
  previous planning discussion). If no plan is found, ask the user to provide one. Same as above,
  check for a related Linear ticket.

Store the plan text — and if a Linear ticket was found, store its description and scope separately.

### Step 3: Build the Cross-Check Prompt

Write the following prompt to a temporary file at `/tmp/cross-check-codex-prompt-$(date +%s).md` using
Bash. The prompt tells Codex what to evaluate and how to report findings.

The prompt must include:

1. **Role**: "You are an adversarial plan reviewer. Your job is to find weaknesses, blind spots,
   and risks in the following implementation plan. Be constructive but thorough — challenge
   assumptions, surface missing edge cases, and propose alternatives where the plan is weak."

2. **The plan text**: the full plan gathered in Step 2.

3. **Linear ticket context** (if available): include the ticket description and scope so Codex can
   validate the plan against the original requirements and intended scope.

4. **Evaluation categories** — instruct Codex to evaluate the plan across these categories:
   - **Architecture alignment** — does the plan respect established patterns (TIBs, module
     boundaries, package tiers)?
   - **Web3 safety** — transaction flows, approvals, chain verification, error handling
   - **Missing edge cases** — multi-chain, wallet states, loading/error states, race conditions
   - **Scope assessment** — over/under-engineering, duplication of existing utilities
   - **Documentation impact** — DATA-FLOW.md staleness, TIB candidates

5. **Output format**: instruct Codex to respond with this structure:

   ```
   ## Cross-Check Findings

   ### [Category Name]

   **Finding**: [What the concern is]
   **Risk**: [Why it matters — what could go wrong]
   **Suggestion**: [Alternative approach or mitigation]

   ---

   ### Summary

   **Overall assessment**: [1-2 sentence verdict]
   **Confidence**: [How confident the reviewer is in these findings: High / Medium / Low]
   **Recommendation**: [Proceed as-is / Adjust before implementing / Rethink approach]
   ```

6. **Important instructions for Codex**:
   - Read relevant files in the repository to validate your findings. Do not guess — check the
     actual code.
   - Reference specific files, TIBs, or existing code when flagging issues.
   - Do not flag things that are already addressed in the plan.
   - Focus on substantive concerns, not style or formatting.
   - If the plan looks solid, say so. Do not manufacture concerns.

### Step 4: Invoke Codex

Determine the repository root:

```bash
git rev-parse --show-toplevel
```

Generate a unique output file path:

```bash
echo "/tmp/cross-check-codex-output-$(date +%s).md"
```

Invoke Codex in non-interactive mode with read-only sandbox access:

```bash
codex exec \
  --sandbox read-only \
  -C <repo-root> \
  -o <output-file> \
  "$(cat <prompt-file>)"
```

Run this in the **foreground**. Do NOT use `run_in_background` — you need to wait for the output
before proceeding. Let the user know it's running and may take a few minutes.

If Codex fails, read the error output carefully:

- **Authentication errors** (e.g., "not logged in", "unauthorized"): tell the user they need to
  authenticate Codex first and abort.
- **Timeouts or other failures**: inform the user what went wrong and offer to retry or skip.

### Step 5: Present Findings

Read the output file and store its full content. Then delete the temporary prompt and output files
(Step 6) **before** presenting findings.

**Critical**: The findings MUST appear as inline text in your **final text message** — the one with
no tool calls after it. In environments like Conductor, only the last message is visible by default;
intermediate messages and tool call results are collapsed. If you do not reproduce the findings
verbatim in your final message, the user will never see them without manually expanding collapsed
steps. Never say "see above" or "findings were presented earlier" — always include the full output.

Present the findings to the user:

1. Show each finding with its category, risk, and suggestion
2. After all findings, show the summary and recommendation
3. Ask the user:

   > "Based on these findings, would you like to:"
   >
   > 1. **Adjust the plan** — re-enter plan mode with these findings as additional context
   > 2. **Proceed as-is** — continue with the original plan
   > 3. **Discuss a specific finding** — dig deeper into one of the concerns

If the user chooses to adjust, re-enter plan mode and incorporate the cross-check findings as
constraints/requirements for the revised plan.

### Step 6: Cleanup

Remove the temporary prompt and output files:

```bash
rm -f <prompt-file> <output-file>
```

## Notes

- This command requires the Codex CLI (`codex`) to be installed, in PATH, and authenticated
- Codex runs with `--sandbox read-only` — it can read the codebase but cannot modify files
- The cross-check is adversarial by design: its value comes from challenging the plan, not agreeing
  with it
- If Codex surfaces a concern that's already addressed in the plan, it's safe to ignore
- Do not pass `-m` — let Codex use its default model so it stays current without manual updates
