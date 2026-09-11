import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

import { QUOTER_BOT_ROOT_VALUE_OPTIONS } from '../../../src/infrastructure/cli/quoter-bot-entrypoint'

const CLI_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../src/infrastructure/cli/cli.ts'
)

describe('QUOTER_BOT_ROOT_VALUE_OPTIONS', () => {
  test('covers every value-taking option the CLI declares', () => {
    const declaredValueFlags = [
      ...readFileSync(CLI_SOURCE, 'utf8').matchAll(/\.option\(\s*'([^']+?)<[^']*'/g)
    ].flatMap(match =>
      match[1]!
        .split(',')
        .map(flag => flag.trim().split(' ')[0]!)
        .filter(flag => flag.startsWith('-'))
    )
    expect(declaredValueFlags.length).toBeGreaterThanOrEqual(5)
    for (const flag of declaredValueFlags) {
      expect(QUOTER_BOT_ROOT_VALUE_OPTIONS).toContain(flag)
    }
  })
})
