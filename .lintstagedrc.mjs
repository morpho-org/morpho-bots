export default {
  '*.{ts,tsx,js,jsx,json,md,yaml,yml}': 'oxfmt --no-error-on-unmatched-pattern',
  '*.{ts,tsx,js,jsx}': 'oxlint --fix --no-error-on-unmatched-pattern'
}
