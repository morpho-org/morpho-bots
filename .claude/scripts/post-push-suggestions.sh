#!/bin/bash
set -euo pipefail

# PostToolUse hook for Bash — detects git push / gh pr create and injects suggestions
# into Claude's context via the hook JSON envelope (hookSpecificOutput.additionalContext;
# plain stdout is NOT shown to the model). Claude uses its judgment about whether to act
# on them / relay them to the user.
#
# Heredocs live in functions, not inside $(...): macOS ships bash 3.2, whose $() parser
# chokes on heredoc bodies containing apostrophes.

suggestions_text() {
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
}

INPUT=$(cat)
# Extract the command from the hook's JSON stdin (no jq dependency). The ERE tolerates
# escaped quotes inside the command, e.g. git commit -m "msg" && git push.
CMD=$(echo "$INPUT" | grep -oE '"command"[[:space:]]*:[[:space:]]*"(\\.|[^"\\])*"' | head -1 | sed -E 's/^"command"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)

# Only trigger on git push or gh pr create commands
if ! [[ "$CMD" =~ (^[[:space:]]*|[;&|]+[[:space:]]*)(git[[:space:]]+push|gh[[:space:]]+pr[[:space:]]+create) ]]; then
  exit 0
fi

CONTEXT=$(suggestions_text)

# JSON-encode the context by hand (still no jq dependency): escape backslashes and
# quotes, then fold newlines into \n so the envelope stays a single line.
ESCAPED=$(printf '%s' "$CONTEXT" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk 'NR>1{printf "%s","\\n"}{printf "%s",$0}')
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' "$ESCAPED"
