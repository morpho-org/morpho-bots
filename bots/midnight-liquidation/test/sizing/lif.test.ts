import { describe, expect, it } from 'bun:test';

import { lifAt } from '../../src/sizing/lif';

// maxLif for lltv=0.86e18 at cursor LOW (0.25e18), per the contract's maxLif derivation (:997).
const MAX_LIF = 1036269430051813471n;

describe('lifAt', () => {
  it('returns the full maxLif in normal mode regardless of time', () => {
    expect(lifAt({ now: 0n, maturity: 0n, maxLif: MAX_LIF, postMaturityMode: false })).toBe(
      MAX_LIF
    );
    expect(lifAt({ now: 9999n, maturity: 1n, maxLif: MAX_LIF, postMaturityMode: false })).toBe(
      MAX_LIF
    );
  });

  it('ramps linearly from just above WAD at maturity+1s', () => {
    expect(lifAt({ now: 1001n, maturity: 1000n, maxLif: MAX_LIF, postMaturityMode: true })).toBe(
      1000010074841681059n
    );
  });

  it('reaches the midpoint of the ramp at maturity+1800s', () => {
    expect(lifAt({ now: 2800n, maturity: 1000n, maxLif: MAX_LIF, postMaturityMode: true })).toBe(
      1018134715025906735n
    );
  });

  it('equals maxLif exactly at the end of the ramp (maturity+3600s)', () => {
    expect(lifAt({ now: 4600n, maturity: 1000n, maxLif: MAX_LIF, postMaturityMode: true })).toBe(
      MAX_LIF
    );
  });

  it('clamps to maxLif past the ramp window', () => {
    expect(lifAt({ now: 6000n, maturity: 1000n, maxLif: MAX_LIF, postMaturityMode: true })).toBe(
      MAX_LIF
    );
  });
});
