import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readLadderGroups } from '../../../src/infrastructure/ladder/ladder-groups.utils'

describe('readLadderGroups', () => {
  test('keeps the bounded Router reader available for the fork harness', async () => {
    expect(typeof readLadderGroups).toBe('function')
    const temporary = await mkdtemp(join(tmpdir(), 'ladder-reader-'))
    try {
      await writeFile(join(temporary, 'marker'), '')
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  })
})
