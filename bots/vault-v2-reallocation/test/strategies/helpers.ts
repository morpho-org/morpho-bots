import type { InputMarketParams } from '@morpho-org/blue-sdk'
import type { Hex } from 'viem'

import { MathLib } from '@morpho-org/blue-sdk'
import { getAddress, maxUint256, parseUnits } from 'viem'

import type { CapState, VaultV2Data, VaultV2MarketData } from '../../src/vault-data'

export const VAULT = getAddress('0x0000000000000000000000000000000000000001')
export const ADAPTER = getAddress('0x0000000000000000000000000000000000000002')
const LOAN_TOKEN = getAddress('0x0000000000000000000000000000000000000010')
const COLLATERAL = getAddress('0x0000000000000000000000000000000000000020')
const ORACLE = getAddress('0x0000000000000000000000000000000000000030')
const IRM = getAddress('0x0000000000000000000000000000000000000040')

// ~3% APY at target utilization, per second.
export const RATE_AT_TARGET = parseUnits('0.03', 18) / (365n * 24n * 60n * 60n)

const UNLIMITED_CAP: CapState = {
  absolute: maxUint256 / 10n ** 18n, // large but buffer-multiplication-safe
  relative: 10n ** 18n, // 100%
  allocation: 0n
}

let marketCounter = 0

export const resetMarketCounter = () => {
  marketCounter = 0
}

export const makeMarketParams = (overrides?: Partial<InputMarketParams>): InputMarketParams => {
  marketCounter++
  return {
    loanToken: LOAN_TOKEN,
    collateralToken: COLLATERAL,
    oracle: ORACLE,
    irm: IRM,
    lltv: parseUnits('0.8', 18) + BigInt(marketCounter), // unique per market
    ...overrides
  }
}

const makeMarketId = (): Hex => `0x${(++marketCounter).toString(16).padStart(64, '0')}`

/** Builds a market whose state realizes the requested WAD utilization. */
export const makeMarket = (opts: {
  utilization: bigint
  vaultAssets: bigint
  cap?: Partial<CapState>
  rateAtTarget: bigint
  params?: InputMarketParams
  isAdaptiveCurve?: boolean
  supplyAssets?: bigint
}): VaultV2MarketData => {
  const totalSupplyAssets = opts.supplyAssets ?? parseUnits('100000', 6)
  const totalBorrowAssets = MathLib.wMulDown(totalSupplyAssets, opts.utilization)
  return {
    id: makeMarketId(),
    capId: makeMarketId(),
    params: opts.params ?? makeMarketParams(),
    state: {
      totalSupplyAssets,
      totalSupplyShares: totalSupplyAssets * 1_000_000n, // 1:1 ratio simplified
      totalBorrowAssets,
      totalBorrowShares: totalBorrowAssets * 1_000_000n
    },
    // Default the enforced allocation to the accrued position value — tests that exercise the
    // divergence override `cap.allocation` explicitly.
    cap: { ...UNLIMITED_CAP, allocation: opts.vaultAssets, ...opts.cap },
    vaultAssets: opts.vaultAssets,
    rateAtTarget: opts.rateAtTarget,
    isAdaptiveCurve: opts.isAdaptiveCurve ?? true
  }
}

export const makeVaultData = (
  markets: VaultV2MarketData[],
  overrides: Partial<Omit<VaultV2Data, 'marketsData'>> = {}
): VaultV2Data => ({
  vaultAddress: VAULT,
  adapterAddress: ADAPTER,
  totalAssets: markets.reduce((acc, m) => acc + m.vaultAssets, 0n) + (overrides.idleAssets ?? 0n),
  idleAssets: 0n,
  adapterCap: UNLIMITED_CAP,
  collateralCaps: Object.fromEntries(
    markets.map(m => [getAddress(m.params.collateralToken), UNLIMITED_CAP])
  ),
  marketsData: markets,
  ...overrides
})
