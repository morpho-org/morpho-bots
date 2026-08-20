import type { Address } from 'viem'

import { getChainAddresses } from '@morpho-org/blue-sdk'
import { getAddress, parseUnits } from 'viem'
import { describe, expect, it } from 'vitest'

import type { LensVaultOut } from '../src/state/lens.sol'

import { InvalidVaultError } from '../src/invalid-vault.error'
import { toVaultV2Data } from '../src/vault-data'

const CHAIN_ID = 8453
const VAULT = getAddress(`0x${'aa'.repeat(20)}`)
const ADAPTER = getAddress(`0x${'bb'.repeat(20)}`)
const COLLATERAL = getAddress(`0x${'cc'.repeat(20)}`)
const ADAPTIVE_CURVE_IRM = getChainAddresses(CHAIN_ID).adaptiveCurveIrm

const caps = (base: bigint) => ({
  absoluteCap: base,
  relativeCap: base + 1n,
  allocation: base + 2n
})

let marketCounter = 0
const makeLensMarket = (
  overrides: Partial<LensVaultOut['markets'][number]> = {}
): LensVaultOut['markets'][number] => {
  marketCounter++
  return {
    id: `0x${marketCounter.toString(16).padStart(64, '0')}`,
    capId: `0x${(1000 + marketCounter).toString(16).padStart(64, '0')}`,
    params: {
      loanToken: getAddress(`0x${'10'.repeat(20)}`),
      collateralToken: COLLATERAL,
      oracle: getAddress(`0x${'30'.repeat(20)}`),
      irm: ADAPTIVE_CURVE_IRM,
      lltv: parseUnits('0.8', 18)
    },
    totalSupplyAssets: parseUnits('100000', 6),
    totalBorrowAssets: parseUnits('50000', 6),
    cap: caps(100n),
    collateralCap: caps(200n),
    vaultAssets: parseUnits('10000', 6),
    rateAtTarget: parseUnits('0.03', 18) / (365n * 24n * 60n * 60n),
    ...overrides
  }
}

const makeRow = (overrides: Partial<LensVaultOut> = {}): LensVaultOut => ({
  isVaultV2: true,
  isAllocator: true,
  totalAssets: parseUnits('100000', 6),
  idleAssets: parseUnits('5000', 6),
  adapters: [{ adapter: ADAPTER, kind: 2 }],
  adapterCap: caps(300n),
  markets: [makeLensMarket()],
  ...overrides
})

describe('toVaultV2Data', () => {
  it('rejects an address the factory does not recognize', () => {
    expect(() => toVaultV2Data(VAULT, makeRow({ isVaultV2: false }), CHAIN_ID)).toThrow(
      InvalidVaultError
    )
  })

  it('rejects any adapter shape other than exactly one market adapter', () => {
    const other: Address = getAddress(`0x${'dd'.repeat(20)}`)
    // Two adapters, even if one qualifies.
    expect(() =>
      toVaultV2Data(
        VAULT,
        makeRow({
          adapters: [
            { adapter: ADAPTER, kind: 2 },
            { adapter: other, kind: 0 }
          ]
        }),
        CHAIN_ID
      )
    ).toThrow(InvalidVaultError)
    // One adapter of an unrecognized generation (e.g. a MorphoVaultV1Adapter).
    expect(() =>
      toVaultV2Data(VAULT, makeRow({ adapters: [{ adapter: other, kind: 0 }] }), CHAIN_ID)
    ).toThrow(InvalidVaultError)
  })

  it('shapes a lens row, renaming cap triples and checksumming addresses', () => {
    const market = makeLensMarket()
    const data = toVaultV2Data(VAULT, makeRow({ markets: [market] }), CHAIN_ID)
    expect(data.vaultAddress).toBe(VAULT)
    expect(data.adapterAddress).toBe(ADAPTER)
    expect(data.isAllocator).toBe(true)
    expect(data.adapterCap).toEqual({ absolute: 300n, relative: 301n, allocation: 302n })
    const shaped = data.marketsData[0]!
    expect(shaped.id).toBe(market.id)
    expect(shaped.capId).toBe(market.capId)
    expect(shaped.cap).toEqual({ absolute: 100n, relative: 101n, allocation: 102n })
    expect(shaped.state).toEqual({
      totalSupplyAssets: market.totalSupplyAssets,
      totalBorrowAssets: market.totalBorrowAssets
    })
    expect(shaped.isAdaptiveCurve).toBe(true)
    expect(shaped.isIdle).toBe(false)
    expect(data.collateralCaps).toEqual({
      [COLLATERAL]: { absolute: 200n, relative: 201n, allocation: 202n }
    })
  })

  it('collapses per-market collateral cap duplicates to one entry per token', () => {
    const shared = caps(500n)
    const data = toVaultV2Data(
      VAULT,
      makeRow({
        markets: [
          makeLensMarket({ collateralCap: shared }),
          makeLensMarket({ collateralCap: shared })
        ]
      }),
      CHAIN_ID
    )
    expect(Object.keys(data.collateralCaps)).toEqual([COLLATERAL])
  })

  it('excludes foreign-IRM and zero-rate markets from the adaptive set, and idle from the report', () => {
    const foreignIrm = makeLensMarket({
      params: { ...makeLensMarket().params, irm: getAddress(`0x${'40'.repeat(20)}`) }
    })
    const zeroRate = makeLensMarket({ rateAtTarget: 0n })
    const idle = makeLensMarket({
      params: {
        ...makeLensMarket().params,
        collateralToken: '0x0000000000000000000000000000000000000000'
      },
      rateAtTarget: 0n
    })
    const data = toVaultV2Data(
      VAULT,
      makeRow({ markets: [makeLensMarket(), foreignIrm, zeroRate, idle] }),
      CHAIN_ID
    )
    expect(data.marketsData.map(m => m.isAdaptiveCurve)).toEqual([true, false, false, false])
    expect(data.marketsData[3]!.isIdle).toBe(true)
    expect(data.nonAdaptiveCurveMarketIds).toEqual([foreignIrm.id, zeroRate.id])
  })
})
