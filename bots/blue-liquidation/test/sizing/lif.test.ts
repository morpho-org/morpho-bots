import { describe, expect, it } from 'vitest'

import { lifFromLltv } from '../../src/sizing/lif'

// Blue's `1 / (1 - 0.3·(1 - lltv))` capped at 1.15, evaluated by hand in WAD with Blue's rounding,
// so a drift in LIQUIDATION_CURSOR or MAX_LIQUIDATION_INCENTIVE_FACTOR fails here.
describe('lifFromLltv', () => {
  it.each([
    [1_000000000000000000n, 1_000000000000000000n],
    [945000000000000000n, 1_016776817488561260n],
    [915000000000000000n, 1_026167265264238070n],
    [860000000000000000n, 1_043841336116910229n],
    [500000000000000000n, 1_150000000000000000n],
    [0n, 1_150000000000000000n]
  ])('gives lltv %d the incentive Blue derives', (lltv, lif) => {
    expect(lifFromLltv(lltv)).toBe(lif)
  })
})
