import { describe, expect, it } from 'bun:test';

import { getAddress } from 'viem';

import { loadForkFixtureFromEnv } from './harness';

describe('loadForkFixtureFromEnv', () => {
  it('returns null when no fork fixture is configured', () => {
    expect(loadForkFixtureFromEnv({})).toBeNull();
  });

  it('parses a JSON fork fixture from the environment', () => {
    const fixture = loadForkFixtureFromEnv({
      BLUE_LIQUIDATION_FORK_FIXTURE: JSON.stringify({
        forkBlock: '29100000',
        marketParams: {
          loanToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
          collateralToken: '0x4200000000000000000000000000000000000006',
          oracle: '0x1111111111111111111111111111111111111111',
          irm: '0x46415998764C29aB2a25CbeA6254146D50D22687',
          lltv: '860000000000000000'
        },
        borrower: '0x000000000000000000000000000000000000b011',
        poolFee: '500',
        warpBySeconds: '3600'
      })
    });

    expect(fixture).toEqual({
      forkBlock: 29100000n,
      marketParams: {
        loanToken: getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
        collateralToken: getAddress('0x4200000000000000000000000000000000000006'),
        oracle: getAddress('0x1111111111111111111111111111111111111111'),
        irm: getAddress('0x46415998764C29aB2a25CbeA6254146D50D22687'),
        lltv: 860000000000000000n
      },
      borrower: getAddress('0x000000000000000000000000000000000000b011'),
      poolFee: 500,
      warpBySeconds: 3600n
    });
  });

  it('throws a field-specific error for malformed fixtures', () => {
    expect(() =>
      loadForkFixtureFromEnv({
        BLUE_LIQUIDATION_FORK_FIXTURE: JSON.stringify({
          forkBlock: '29100000',
          marketParams: {},
          borrower: 'not-an-address',
          poolFee: '500'
        })
      })
    ).toThrow(/marketParams\.loanToken/);
  });
});
