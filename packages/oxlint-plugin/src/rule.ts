import type { RuleTester } from 'oxlint/plugins-dev'

export type Rule = Extract<Parameters<RuleTester['run']>[1], { create: unknown }>
