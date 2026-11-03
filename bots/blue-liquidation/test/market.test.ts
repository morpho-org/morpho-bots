import { describe, expect, it } from 'vitest'

import type { MarketParams } from '../src/market'

import { marketId } from '../src/market'

const PARAMS: MarketParams = {
  loanToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC (Base)
  collateralToken: '0x4200000000000000000000000000000000000006', // WETH (Base)
  oracle: '0x1111111111111111111111111111111111111111',
  irm: '0x46415998764C29aB2a25CbeA6254146D50D22687', // AdaptiveCurveIRM (Base)
  lltv: 860000000000000000n
}

describe('marketId', () => {
  it('matches a golden keccak256(abi.encode(marketParams))', () => {
    expect(marketId(PARAMS)).toBe(
      '0xd64291e23e436138f447ae181e5c8c1a78b7426250901ffcd8898fe01da24bf0'
    )
  })
})
