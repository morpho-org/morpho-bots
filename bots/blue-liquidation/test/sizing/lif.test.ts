import { describe, expect, it } from 'bun:test';

import { LIQUIDATION_CURSOR, MAX_LIQUIDATION_INCENTIVE_FACTOR, WAD } from '../../src/constants';
import { lifFromLltv } from '../../src/sizing/lif';
import { wDivDown, wMulDown } from '../../src/sizing/math';

// Independent reference: 1 / (1 - cursor·(1 - lltv)), uncapped.
function uncappedLif(lltv: bigint): bigint {
  return wDivDown(WAD, WAD - wMulDown(LIQUIDATION_CURSOR, WAD - lltv));
}

describe('lifFromLltv', () => {
  it('is WAD at lltv = WAD (no discount when there is no shortfall room)', () => {
    expect(lifFromLltv(WAD)).toBe(WAD);
  });

  it('matches the uncapped formula in the normal range', () => {
    for (const lltv of [
      86n * 10n ** 16n, // 0.86
      90n * 10n ** 16n, // 0.90
      945n * 10n ** 15n // 0.945
    ]) {
      const expected = uncappedLif(lltv);
      // These LLTVs stay below the cap.
      expect(expected).toBeLessThan(MAX_LIQUIDATION_INCENTIVE_FACTOR);
      expect(lifFromLltv(lltv)).toBe(expected);
    }
  });

  it('caps at MAX_LIQUIDATION_INCENTIVE_FACTOR for low lltv', () => {
    // lltv = 0: uncapped = 1/(1 - 0.3) = 1.428e18 > 1.15e18 cap.
    expect(uncappedLif(0n)).toBeGreaterThan(MAX_LIQUIDATION_INCENTIVE_FACTOR);
    expect(lifFromLltv(0n)).toBe(MAX_LIQUIDATION_INCENTIVE_FACTOR);
    // A low-but-nonzero lltv still clips to the cap.
    expect(lifFromLltv(50n * 10n ** 16n)).toBe(MAX_LIQUIDATION_INCENTIVE_FACTOR); // 0.5
  });

  it('increases monotonically as lltv falls (more shortfall → bigger incentive), until the cap', () => {
    const lifs = [98n, 95n, 90n, 86n].map(p => lifFromLltv(p * 10n ** 16n));
    for (let i = 1; i < lifs.length; i++) {
      expect(lifs[i]).toBeGreaterThanOrEqual(lifs[i - 1]!);
    }
  });
});
