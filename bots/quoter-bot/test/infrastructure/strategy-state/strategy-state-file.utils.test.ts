import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

import {
  assertCurrentStrategyStates,
  STRATEGY_STATE_VERSION
} from '../../../src/infrastructure/strategy-state/strategy-state-file.utils'
import { StrategyStateVersionError } from '../../../src/infrastructure/strategy-state/strategy-state-version.error'

const stateName = (byte: string) => `0x${byte.repeat(32)}.json`

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

describe('assertCurrentStrategyStates', () => {
  test('accepts a missing directory and current state beside unrelated files', async () => {
    await expect(
      assertCurrentStrategyStates(join(tmpdir(), 'missing-strategy-state'))
    ).resolves.toBeUndefined()
    await withDirectory(
      {
        [stateName('aa')]: JSON.stringify({ version: STRATEGY_STATE_VERSION }),
        'notes.json': JSON.stringify({ version: 1 })
      },
      async directory => {
        await expect(assertCurrentStrategyStates(directory)).resolves.toBeUndefined()
      }
    )
  })

  test('fails loud on earlier state under any key, including one no longer derived', async () => {
    await withDirectory(
      {
        [stateName('aa')]: JSON.stringify({ version: STRATEGY_STATE_VERSION }),
        [stateName('bb')]: JSON.stringify({ version: 6, offers: [{ capKind: 'assets' }] })
      },
      async directory => {
        await expect(assertCurrentStrategyStates(directory)).rejects.toBeInstanceOf(
          StrategyStateVersionError
        )
      }
    )
  })

  test('fails closed on a truncated state file rather than skipping it', async () => {
    await withDirectory({ [stateName('cc')]: '{"version": 6, "offers": [' }, async directory => {
      await expect(assertCurrentStrategyStates(directory)).rejects.toBeInstanceOf(
        StrategyStateVersionError
      )
    })
  })
})
