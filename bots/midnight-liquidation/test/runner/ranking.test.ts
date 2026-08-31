import { describe, expect, it } from 'vitest'

import { rankByNetUsdSurplus, scoreNetOfRouteCost } from '../../src/runner/ranking'

const at = (id: string, netUsd: bigint | null) => ({ id, netUsd })

// A scorable candidate: `label` is the position, so two entries sharing one are alternatives.
const scorable = (
  label: string,
  surplusUsd: bigint | null,
  routeCostUsd: bigint | null,
  id = label
) => ({ id, label, surplusUsd, routeCostUsd })

describe('rankByNetUsdSurplus', () => {
  it('orders priced candidates by descending net USD', () => {
    const ranked = rankByNetUsdSurplus([at('small', 50n), at('large', 200n), at('medium', 100n)])
    expect(ranked.map(c => c.id)).toEqual(['large', 'medium', 'small'])
  })

  it('orders unpriced candidates after every priced one, whatever their position', () => {
    const ranked = rankByNetUsdSurplus([
      at('unpriced-first', null),
      at('small', 50n),
      at('unpriced-last', null),
      at('large', 200n)
    ])
    expect(ranked.map(c => c.id)).toEqual(['large', 'small', 'unpriced-first', 'unpriced-last'])
  })

  it('preserves input order among unpriced candidates', () => {
    const ranked = rankByNetUsdSurplus([at('c', null), at('a', null), at('b', null)])
    expect(ranked.map(c => c.id)).toEqual(['c', 'a', 'b'])
  })

  it('preserves input order on ties', () => {
    const ranked = rankByNetUsdSurplus([at('c', 10n), at('a', 10n), at('b', 10n)])
    expect(ranked.map(c => c.id)).toEqual(['c', 'a', 'b'])
  })

  it('does not mutate its input', () => {
    const input = [at('small', 1n), at('large', 2n)]
    rankByNetUsdSurplus(input)
    expect(input.map(c => c.id)).toEqual(['small', 'large'])
  })

  it('returns an empty array unchanged', () => {
    expect(rankByNetUsdSurplus([])).toEqual([])
  })

  it('treats a zero score as priced, so it still outranks an unpriced candidate', () => {
    const ranked = rankByNetUsdSurplus([at('unpriced', null), at('zero', 0n)])
    expect(ranked.map(c => c.id)).toEqual(['zero', 'unpriced'])
  })

  it('orders correctly when the difference exceeds Number.MAX_SAFE_INTEGER', () => {
    // Regression guard for a `Number(b - a)` comparator: these differ by ~1e21, so coercing the
    // difference to a double loses the distinction entirely.
    const huge = 10n ** 30n
    const ranked = rankByNetUsdSurplus([at('lo', huge), at('hi', huge + 10n ** 21n)])
    expect(ranked.map(c => c.id)).toEqual(['hi', 'lo'])
  })
})

describe('scoreNetOfRouteCost', () => {
  it('charges each candidate its route cost', () => {
    const scored = scoreNetOfRouteCost([scorable('a', 200n, 120n), scorable('b', 100n, 0n)])
    expect(scored.map(c => c.netUsd)).toEqual([80n, 100n])
    expect(scored.every(c => c.costed)).toBe(true)
  })

  it('reorders a pair that gross surplus would have ranked the other way', () => {
    // The whole point: 200 gross paying 120 of route is worth less than 100 gross paying nothing.
    const ranked = rankByNetUsdSurplus(
      scoreNetOfRouteCost([scorable('rich-but-costly', 200n, 120n), scorable('cheap', 100n, 0n)])
    )
    expect(ranked.map(c => c.id)).toEqual(['cheap', 'rich-but-costly'])
  })

  it('keeps a whole POSITION on gross surplus when one of its candidates has no cost', () => {
    // Fail-open is per position: scoring the priced sibling net and the uncosted one gross would bias
    // exactly the comparison that decides which of the two is attempted.
    const scored = scoreNetOfRouteCost([
      scorable('p', 200n, 150n, 'costed-sibling'),
      scorable('p', 100n, null, 'uncosted-sibling')
    ])
    expect(scored.map(c => c.netUsd)).toEqual([200n, 100n])
    expect(scored.map(c => c.costed)).toEqual([false, false])
  })

  it('confines a cold curve to the position that has one', () => {
    const scored = scoreNetOfRouteCost([scorable('cold', 200n, null), scorable('warm', 100n, 40n)])
    expect(scored.map(c => c.netUsd)).toEqual([200n, 60n])
    expect(scored.map(c => c.costed)).toEqual([false, true])
  })

  it('scores an unpriced candidate as unrankable rather than as its cost', () => {
    const scored = scoreNetOfRouteCost([scorable('unpriced', null, null)])
    expect(scored[0]?.netUsd).toBeNull()
    expect(scored[0]?.costed).toBe(false)
  })

  it('charges a zero-cost candidate nothing', () => {
    const scored = scoreNetOfRouteCost([scorable('swap-free', 6n, 0n)])
    expect(scored[0]).toMatchObject({ netUsd: 6n, costed: true })
  })
})
