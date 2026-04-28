#!/bin/bash
set -euo pipefail

# PostToolUse hook for Bash — detects git push / gh pr create and outputs suggestions for Claude.
# Claude sees the stdout and uses its judgment about whether to relay suggestions to the user.

INPUT=$(cat)
CMD=$(echo "$INPUT" | grep -o '"command":[[:space:]]*"[^"]*"' | head -1 | sed 's/"command":[[:space:]]*"//;s/"$//' || true)

# Only trigger on git push or gh pr create commands
if ! [[ "$CMD" =~ (^[[:space:]]*|[;&|]+[[:space:]]*)(git[[:space:]]+push|gh[[:space:]]+pr[[:space:]]+create) ]]; then
  exit 0
fi

cat <<'SUGGESTIONS'
[post-push suggestions]
A push or PR creation just completed. Consider suggesting the following to the user if relevant (use your judgment based on the conversation context):

1. `/learn` — Suggest this if the conversation included any of:
   - User corrections ("no, don't…", "actually…", "instead do…")
   - Failure reports ("it didn't work", "it failed", "it's broken")
   - Verification failures caused by your changes (typecheck/lint/test errors you had to fix)
   If none of these occurred, skip this suggestion.

2. `/review <PR-number>` — Suggest this if:
   - `/review` has not been run in this conversation, OR
   - There have been substantial code changes since the last `/review`
   If a PR was just created, use the PR number from the command output.
   If the user already reviewed the changes (or this was a trivial push), skip this suggestion.

Present suggestions briefly (one line each) — do not auto-invoke either command.
[/post-push suggestions]
SUGGESTIONS
