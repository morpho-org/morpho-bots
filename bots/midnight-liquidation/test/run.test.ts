import { GraphDefinitionError } from '@repo/engine'
import { describe, expect, it, vi } from 'vitest'

import { startBot } from './scenario/bot'

describe('startLiquidator', () => {
  it('finalizes the journal unclean when the graph cannot be declared', async () => {
    const finalize = vi.fn(async () => {})
    const journal = { sink: { append: async () => {}, finalize }, capacityBytes: 1_000_000 }
    await expect(startBot({ worldValidMs: 0, journal })).rejects.toBeInstanceOf(
      GraphDefinitionError
    )
    expect(finalize).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), { clean: false })
  })
})
