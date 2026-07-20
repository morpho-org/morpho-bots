import { describe, expect, it } from 'bun:test';

import type { Address } from 'viem';
import { zeroAddress } from 'viem';

import { assertFunding } from '../src/publisher';

const maker = '0x1111111111111111111111111111111111111111' as Address;
const midnight = '0x2222222222222222222222222222222222222222' as Address;
const loanToken = '0x3333333333333333333333333333333333333333' as Address;
const marketId = `0x${'44'.repeat(32)}` as const;
const market = {
  params: {
    chainId: 8453n,
    midnight,
    loanToken,
    collateralParams: [
      {
        token: '0x5555555555555555555555555555555555555555' as Address,
        lltv: 770000000000000000n,
        liquidationCursor: 250000000000000000n,
        oracle: '0x6666666666666666666666666666666666666666' as Address
      }
    ],
    maturity: 2_000_000_000n,
    rcfThreshold: 0n,
    enterGate: zeroAddress,
    liquidatorGate: zeroAddress
  },
  totalUnits: 1_000n,
  lossFactor: 0n,
  withdrawable: 1_000n,
  continuousFeeCredit: 0n,
  settlementFeeCbps: [0, 0, 0, 0, 0, 0, 0] as const,
  continuousFee: 0,
  tickSpacing: 4
};

function fundingContext({ balance = 100n, allowance = 100n, credit = 100n } = {}) {
  const calls: string[] = [];
  const publicClient = {
    readContract: async ({ functionName }: { functionName: string }) => {
      calls.push(functionName);
      if (functionName === 'balanceOf') return balance;
      if (functionName === 'allowance') return allowance;
      if (functionName === 'position') return [credit, 0n, 0n, 1_000n, 0n, 0n] as const;
      throw new Error(`unexpected read: ${functionName}`);
    }
  };

  return {
    context: { publicClient, maker, midnight },
    calls
  };
}

describe('assertFunding', () => {
  it('reads the maker position and accepts enough loan tokens and credit', async () => {
    const { context, calls } = fundingContext();

    await assertFunding(context as never, market, marketId, 100n, 2_000n);

    expect(calls).toEqual(['balanceOf', 'allowance', 'position']);
  });

  it('rejects a sell ladder larger than the maker credit', async () => {
    const { context } = fundingContext({ credit: 99n });

    await expect(assertFunding(context as never, market, marketId, 100n, 2_000n)).rejects.toThrow(
      'maker accrued credit 99 is below maxUnits 100'
    );
  });
});
