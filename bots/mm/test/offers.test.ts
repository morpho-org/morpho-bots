import { Group, Offer } from '@morpho-org/midnight-sdk'
import { describe, expect, it } from 'bun:test'
import { zeroAddress, zeroHash } from 'viem'

import { buildOfferGroups } from '../src/offers'

const market = {
  chainId: 8453n,
  midnight: '0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A',
  loanToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  collateralParams: [
    {
      token: '0x4200000000000000000000000000000000000006',
      lltv: 860000000000000000n,
      liquidationCursor: 250000000000000000n,
      oracle: '0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4'
    }
  ],
  maturity: 1_800_000_000n,
  rcfThreshold: 0n,
  enterGate: zeroAddress,
  liquidatorGate: zeroAddress
} as const

describe('buildOfferGroups', () => {
  it('uses separate SDK-derived groups and caps each offer correctly', () => {
    const groups = buildOfferGroups({
      market,
      maker: '0x1111111111111111111111111111111111111111',
      ratifier: '0xd6e70365C8E8DDa9a4ca662C07bbE663b017755E',
      buyTick: 4_000n,
      sellTick: 5_000n,
      expiry: 1_799_999_000n,
      buyAssets: 900n,
      sellAssets: 700n,
      continuousFeeCap: 123n,
      tickSpacing: 1
    })

    expect(groups.buy).toBeInstanceOf(Group)
    expect(groups.sell).toBeInstanceOf(Group)
    expect(groups.buy.id).not.toBe(zeroHash)
    expect(groups.sell.id).not.toBe(zeroHash)
    expect(groups.buy.id).not.toBe(groups.sell.id)
    expect(groups.buy.offers[0]).toBeInstanceOf(Offer)
    expect(groups.buy.offers[0]?.buy).toBe(true)
    expect(groups.buy.offers[0]?.maxAssets).toBe(900n)
    expect(groups.buy.offers[0]?.reduceOnly).toBe(false)
    expect(groups.sell.offers[0]?.buy).toBe(false)
    expect(groups.sell.offers[0]?.maxAssets).toBe(700n)
    expect(groups.sell.offers[0]?.reduceOnly).toBe(true)
  })
})
