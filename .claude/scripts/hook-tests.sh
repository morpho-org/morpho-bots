#!/bin/bash
# Fixtures below contain quoted JSON on purpose — it must reach the hooks unexpanded.
# shellcheck disable=SC2016
#
# Self-contained test suite for the Bash-tool hook scripts in this directory:
#   - post-push-suggestions.sh (PostToolUse: suggests /learn + /review after pushes)
#
# Run directly:  bash .claude/scripts/hook-tests.sh
# Runs automatically via lint-staged (.lintstagedrc.mjs) whenever a
# .claude/scripts/*.sh file is staged.
#
# Overrides, mainly for comparing against old versions from git:
#   BASH_BIN=...  interpreter for the hooks (default /bin/bash — macOS bash 3.2,
#                 which is what the settings.json wiring uses)
#   POSTPUSH=...  alternate script path
#
# These hooks fire on every Bash tool call, so a regression here breaks every
# agent session in the repo. Keep this suite green and extend it whenever the
# hook logic changes.

DIR=$(cd "$(dirname "$0")" && pwd)
P="${POSTPUSH:-$DIR/post-push-suggestions.sh}"
BASH_BIN="${BASH_BIN:-/bin/bash}"
pass=0
fail=0

echo "=== syntax and static analysis ==="
if "$BASH_BIN" -n "$P"; then
  pass=$((pass + 1))
  printf 'PASS bash -n %s\n' "$(basename "$P")"
else
  fail=$((fail + 1))
  printf 'FAIL bash -n %s\n' "$(basename "$P")"
fi
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck "$P"; then
    pass=$((pass + 1))
    echo "PASS shellcheck"
  else
    fail=$((fail + 1))
    echo "FAIL shellcheck"
  fi
else
  echo "SKIP shellcheck (not installed)"
fi

t() { # t <script> <expected-rc> <json> <desc> [must-contain]
  local script="$1" exp="$2" json="$3" desc="$4" want="${5:-}"
  local out rc ok
  out=$(printf '%s' "$json" | "$BASH_BIN" "$script" 2>&1)
  rc=$?
  ok=1
  [ "$rc" -eq "$exp" ] || ok=0
  if [ -n "$want" ]; then
    case "$out" in *"$want"*) : ;; *) ok=0 ;; esac
  fi
  if [ "$ok" -eq 1 ]; then
    pass=$((pass + 1))
    printf 'PASS rc=%s  %s\n' "$rc" "$desc"
  else
    fail=$((fail + 1))
    printf 'FAIL rc=%s (want %s, want-substr=%s)  %s\n  out: %s\n' "$rc" "$exp" "$want" "$desc" "$out"
  fi
}

echo "=== post-push suggestions hook ==="
t "$P" 0 '{"tool_input":{"command":"git push origin main"}}' 'git push triggers suggestions' '[post-push suggestions]'
t "$P" 0 '{"tool_input":{"command":"git commit -m \"msg\" && git push"}}' 'quoted msg + push triggers' '[post-push suggestions]'
t "$P" 0 '{"tool_input":{"command":"gh pr create --draft"}}' 'gh pr create triggers' '[post-push suggestions]'
t "$P" 0 '{"tool_input": {"command": "git push origin main"}}' 'formatted JSON push triggers' '[post-push suggestions]'
t "$P" 0 '{"tool_input":{"command":"git push"}}' 'suggestions delivered via additionalContext envelope' '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"'

# The hand-rolled escaping in the hook is the riskiest part — a future edit adding a tab,
# control character, or unbalanced escape to the suggestions text would emit invalid JSON
# while the substring assertions above still pass. Parse the envelope to catch that.
if command -v python3 >/dev/null 2>&1; then
  if printf '%s' '{"tool_input":{"command":"git push"}}' | "$BASH_BIN" "$P" |
    python3 -c 'import json,sys; json.load(sys.stdin)' 2>/dev/null; then
    pass=$((pass + 1))
    echo 'PASS envelope is valid JSON'
  else
    fail=$((fail + 1))
    echo 'FAIL envelope is valid JSON'
  fi
else
  echo 'SKIP envelope is valid JSON (python3 not installed)'
fi

silent() { # silent <script> <json> <desc> — expect rc=0 and no output
  local script="$1" json="$2" desc="$3" out rc
  out=$(printf '%s' "$json" | "$BASH_BIN" "$script" 2>&1)
  rc=$?
  if [ "$rc" -eq 0 ] && [ -z "$out" ]; then
    pass=$((pass + 1))
    printf 'PASS rc=0 silent  %s\n' "$desc"
  else
    fail=$((fail + 1))
    printf 'FAIL rc=%s  %s\n  out: %s\n' "$rc" "$desc" "$out"
  fi
}
silent "$P" '{"tool_input":{"command":"ls -la"}}' 'non-push stays silent'
silent "$P" '{"tool_input":{"description":"hi"}}' 'no command field stays silent'

echo
echo "RESULT: $pass passed, $fail failed (bash: $BASH_BIN)"
[ "$fail" -eq 0 ]
