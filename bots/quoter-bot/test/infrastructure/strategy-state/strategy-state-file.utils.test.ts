import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import { StrategyStateVersionError } from '../../../src/errors'
import { assertNoLegacyStrategyState } from '../../../src/infrastructure/strategy-state/strategy-state-file.utils'

const withDirectory = async (
  files: Record<string, string>,
  run: (path: string) => Promise<void>
) => {
  const directory = await mkdtemp(join(tmpdir(), 'strategy-state-'))
  try {
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(directory, name), contents, { mode: 0o600 })
    }
    await run(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('assertNoLegacyStrategyState', () => {
  test('accepts a missing directory, and kernel ledgers beside unrelated files', async () => {
    await expect(
      assertNoLegacyStrategyState(join(tmpdir(), 'missing-strategy-state'))
    ).resolves.toBeUndefined()
    await withDirectory(
      { [`kernel-8453-0x${'11'.repeat(20)}.json`]: '{}', 'notes.json': '{}' },
      async directory => {
        await expect(assertNoLegacyStrategyState(directory)).resolves.toBeUndefined()
      }
    )
  })

  test('refuses to start beside ownership a pre-kernel version wrote, whose groups no kernel owns', async () => {
    await withDirectory({ [`0x${'aa'.repeat(32)}.json`]: '{"version":7}' }, async directory => {
      await expect(assertNoLegacyStrategyState(directory)).rejects.toBeInstanceOf(
        StrategyStateVersionError
      )
    })
  })
})
