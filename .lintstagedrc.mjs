export default {
  '*.{ts,tsx,js,jsx,json,md,yaml,yml}': 'oxfmt --no-error-on-unmatched-pattern',
  '*.{ts,tsx,js,jsx}': 'oxlint --fix --no-error-on-unmatched-pattern',
  // The Bash-tool hook scripts fire on every agent Bash call, so a regression
  // breaks every session in the repo. Run their pipe-test suite whenever any
  // of them changes. Function form: the suite tests fixed paths, so lint-staged
  // must not append the staged filenames.
  '.claude/scripts/*.sh': () => 'bash .claude/scripts/hook-tests.sh'
}
