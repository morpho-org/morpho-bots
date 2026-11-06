import { base, mainnet, optimism } from 'viem/chains'
import { describe, expect, it } from 'vitest'

import { blocksFor, blockTimeMs } from '../src/block-time'
import { MissingBlockTimeError } from '../src/errors'

const robinhood = { id: 4663 }

describe('blocksFor', () => {
  it("converts a time to whole blocks of kit's block time, not viem's", () => {
    expect(base.blockTime).toBe(2_000)
    expect(blocksFor(8_000, base)).toBe(40)
    expect(blocksFor(8_000, mainnet)).toBe(1)
    expect(blocksFor(8_000, robinhood)).toBe(80)
  })

  it('keeps a converted window at its floor on a chain whose blocks span more of the time', () => {
    expect(blocksFor(6_000, mainnet, 3)).toBe(3)
    expect(blocksFor(6_000, base, 3)).toBe(30)
  })

  it('refuses a chain kit has no block time for, whatever viem declares', () => {
    expect(optimism.blockTime).toBeGreaterThan(0)
    expect(() => blocksFor(8_000, optimism)).toThrow(MissingBlockTimeError)
    expect(() => blockTimeMs(optimism.id)).toThrow(MissingBlockTimeError)
  })
})
