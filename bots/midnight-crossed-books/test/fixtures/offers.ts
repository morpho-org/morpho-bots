import type { Address, Hex } from 'viem'

import type { TakeableOffer } from '../../src/domain/order-book'

export const MARKET_ID = `0x${'11'.repeat(32)}` as Hex
export const OTHER_MARKET_ID = `0x${'22'.repeat(32)}` as Hex

const ZERO_ADDRESS = `0x${'00'.repeat(20)}` as Address

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
        midnight: `0x${'33'.repeat(20)}`,
        loanToken: `0x${'44'.repeat(20)}`,
        collateralParams: [],
        maturity: 2_000_000_000n,
        rcfThreshold: 0n,
        enterGate: ZERO_ADDRESS,
        liquidatorGate: ZERO_ADDRESS
      },
      buy,
      maker: `0x${'55'.repeat(20)}`,
      start: 0n,
      expiry: 2_000_000_000n,
      tick,
      group: `0x${'66'.repeat(32)}`,
      callback: ZERO_ADDRESS,
      callbackData: '0x',
      receiverIfMakerIsSeller: buy ? ZERO_ADDRESS : `0x${'55'.repeat(20)}`,
      ratifier: `0x${'77'.repeat(20)}`,
      reduceOnly: false,
      maxUnits: units,
      maxAssets: 0n,
      continuousFeeCap: 1n
    },
    ...overrides
  }
}
