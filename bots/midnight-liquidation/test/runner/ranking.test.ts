import { describe, expect, it } from 'vitest'

import { rankByUsdSurplus } from '../../src/runner/ranking'

const at = (id: string, surplusUsd: bigint | null) => ({ id, surplusUsd })

describe('rankByUsdSurplus', () => {
  it('orders priced candidates by descending USD surplus', () => {
    const ranked = rankByUsdSurplus([at('small', 50n), at('large', 200n), at('medium', 100n)])
    expect(ranked.map(c => c.id)).toEqual(['large', 'medium', 'small'])
  })

  it('orders unpriced candidates after every priced one, whatever their position', () => {
    const ranked = rankByUsdSurplus([
      at('unpriced-first', null),
      at('small', 50n),
      at('unpriced-last', null),
      at('large', 200n)
    ])
    expect(ranked.map(c => c.id)).toEqual(['large', 'small', 'unpriced-first', 'unpriced-last'])
  })

  it('preserves input order among unpriced candidates', () => {
    const ranked = rankByUsdSurplus([at('c', null), at('a', null), at('b', null)])
    expect(ranked.map(c => c.id)).toEqual(['c', 'a', 'b'])
  })

  it('preserves input order on ties', () => {
    const ranked = rankByUsdSurplus([at('c', 10n), at('a', 10n), at('b', 10n)])
    expect(ranked.map(c => c.id)).toEqual(['c', 'a', 'b'])
  })

  it('does not mutate its input', () => {
    const input = [at('small', 1n), at('large', 2n)]
    rankByUsdSurplus(input)
    expect(input.map(c => c.id)).toEqual(['small', 'large'])
  })

  it('returns an empty array unchanged', () => {
    expect(rankByUsdSurplus([])).toEqual([])
  })

  it('treats a zero surplus as priced, so it still outranks an unpriced candidate', () => {
    const ranked = rankByUsdSurplus([at('unpriced', null), at('zero', 0n)])
    expect(ranked.map(c => c.id)).toEqual(['zero', 'unpriced'])
  })

  it('orders correctly when the difference exceeds Number.MAX_SAFE_INTEGER', () => {
    // Regression guard for a `Number(b - a)` comparator: these differ by ~1e21, so coercing the
    // difference to a double loses the distinction entirely.
    const huge = 10n ** 30n
    const ranked = rankByUsdSurplus([at('lo', huge), at('hi', huge + 10n ** 21n)])
    expect(ranked.map(c => c.id)).toEqual(['hi', 'lo'])
  })
})
