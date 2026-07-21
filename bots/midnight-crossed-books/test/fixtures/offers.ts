import type { Address, Hex } from 'viem'

import type { TakeableOffer } from '../../src/domain/order-book'

export const MARKET_ID =
  '0x1111111111111111111111111111111111111111111111111111111111111111' satisfies Hex
export const OTHER_MARKET_ID =
  '0x2222222222222222222222222222222222222222222222222222222222222222' satisfies Hex

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' satisfies Address

export function makeOffer(
  side: 'ask' | 'bid',
  tick: bigint,
  units: bigint,
  overrides: Partial<TakeableOffer> = {}
): TakeableOffer {
  const buy = side === 'bid'

  return {
    marketId: MARKET_ID,
    units,
    ratifierData: '0x',
    offer: {
      market: {
        chainId: 8453n,
        midnight: '0x3333333333333333333333333333333333333333',
        loanToken: '0x4444444444444444444444444444444444444444',
        collateralParams: [],
        maturity: 2_000_000_000n,
        rcfThreshold: 0n,
        enterGate: ZERO_ADDRESS,
        liquidatorGate: ZERO_ADDRESS
      },
      buy,
      maker: '0x5555555555555555555555555555555555555555',
      start: 0n,
      expiry: 2_000_000_000n,
      tick,
      group: '0x6666666666666666666666666666666666666666666666666666666666666666',
      callback: ZERO_ADDRESS,
      callbackData: '0x',
      receiverIfMakerIsSeller: buy ? ZERO_ADDRESS : '0x5555555555555555555555555555555555555555',
      ratifier: '0x7777777777777777777777777777777777777777',
      reduceOnly: false,
      maxUnits: units,
      maxAssets: 0n,
      continuousFeeCap: 1n
    },
    ...overrides
  }
}
