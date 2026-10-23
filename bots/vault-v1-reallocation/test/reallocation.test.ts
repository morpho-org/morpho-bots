import { MarketUtils } from '@morpho-org/blue-sdk'
import { MetaMorphoAction } from '@morpho-org/blue-sdk-viem'
import { wholePercentToWAD } from '@repo/utils'
import { vaultV1ReallocationValidator } from '@repo/validators'
import { getAddress, maxUint256, parseUnits } from 'viem'
import { describe, expect, it } from 'vitest'

import { decide, witnessOf, legsOf } from '../src/reallocation'
import { createApyRangeStrategy } from '../src/strategies/apy-range'
import { makeIdleMarket, makeMarket, makeVaultData, VAULT } from './strategies/helpers'

const EOA = getAddress('0x00000000000000000000000000000000000000e0')
const CAP = parseUnits('1000000', 6)

const strategy = createApyRangeStrategy({
  allowIdleReallocation: true,
  capBufferWad: wholePercentToWAD(99.99),
  apyRange: () => ({ min: wholePercentToWAD(2), max: wholePercentToWAD(8) }),
  minApyDeltaBips: () => 0
})

/** One market far above its APY range, one far below, and an idle market. */
const unbalanced = () =>
  makeVaultData([
    makeMarket({
      utilization: parseUnits('0.99', 18),
      vaultAssets: parseUnits('10000', 6),
      cap: CAP
    }),
    makeMarket({
      utilization: parseUnits('0.1', 18),
      vaultAssets: parseUnits('50000', 6),
      cap: CAP
    }),
    makeIdleMarket(parseUnits('1000', 6))
  ])

describe('a Vault V1 reallocation decision', () => {
  it('needs the allocator role, through the allocator set, the curator or the owner', () => {
    const vault = unbalanced()
    const unroled = { ...vault, isAllocator: false }
    expect(decide(unroled, strategy, EOA)).toStrictEqual({ reason: 'missing_role' })
    expect(decide({ ...unroled, curator: EOA }, strategy, EOA).allocations).toBeDefined()
    expect(decide({ ...unroled, owner: EOA }, strategy, EOA).allocations).toBeDefined()
  })

  it('is balanced when its strategy finds nothing to move', () => {
    const balanced = makeVaultData([
      makeMarket({ utilization: parseUnits('0.9', 18), vaultAssets: 1n, cap: CAP })
    ])
    expect(decide(balanced, strategy, EOA)).toStrictEqual({ reason: 'balanced' })
  })

  it('rests on the markets it moves and their directions, not their amounts', () => {
    const vault = unbalanced()
    const { allocations } = decide(vault, strategy, EOA)
    const legs = legsOf(vault, allocations!)
    const [hot, cold] = vault.marketsData
    expect(legs).toContainEqual({ market: MarketUtils.getMarketId(cold!.params), side: 'withdraw' })
    expect(legs).toContainEqual({ market: MarketUtils.getMarketId(hot!.params), side: 'deposit' })
    const accrued = {
      ...vault,
      marketsData: vault.marketsData.map(market => ({
        ...market,
        state: { ...market.state, totalSupplyAssets: market.state.totalSupplyAssets + 7n }
      }))
    }
    expect(legsOf(accrued, decide(accrued, strategy, EOA).allocations!)).toStrictEqual(legs)
  })

  it('refuses to describe a leg in a market the read does not list', () => {
    const vault = unbalanced()
    const stray = makeMarket({ utilization: 0n, vaultAssets: 0n, cap: CAP })
    expect(() => legsOf(vault, [{ marketParams: stray.params, assets: maxUint256 }])).toThrow(
      /unlisted market/
    )
  })

  it('encodes what the validator reads as neutral against the read it was decided on', () => {
    const vault = unbalanced()
    const { allocations } = decide(vault, strategy, EOA)
    const reading = vaultV1ReallocationValidator({ vaults: [VAULT] }).read(
      { kind: 'tx', to: VAULT, data: MetaMorphoAction.reallocate([...allocations!]), value: 0n },
      witnessOf(vault),
      { account: EOA, chainId: 1 }
    )
    expect(reading).toMatchObject({ ok: true, creates: [], consumes: {} })
  })
})
