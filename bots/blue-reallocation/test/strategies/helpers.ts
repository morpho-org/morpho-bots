import type { InputMarketParams } from '@morpho-org/blue-sdk'
import type { Address, Hex } from 'viem'

import { MathLib } from '@morpho-org/blue-sdk'
import { getAddress, maxUint256, parseUnits, zeroAddress } from 'viem'

import type { VaultData, VaultMarketData } from '../../src/vault-data'

export const VAULT = getAddress('0x0000000000000000000000000000000000000001')
const LOAN_TOKEN = getAddress('0x0000000000000000000000000000000000000010')
const COLLATERAL = getAddress('0x0000000000000000000000000000000000000020')
const ORACLE = getAddress('0x0000000000000000000000000000000000000030')
const IRM = getAddress('0x0000000000000000000000000000000000000040')

// ~3% APY at target utilization, per second.
export const RATE_AT_TARGET = parseUnits('0.03', 18) / (365n * 24n * 60n * 60n)

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
  cap: bigint
  rateAtTarget: bigint
  id?: Hex
  params?: InputMarketParams
}): VaultMarketData => {
  const totalSupplyAssets = parseUnits('100000', 6)
  const totalBorrowAssets = MathLib.wMulDown(totalSupplyAssets, opts.utilization)
  return {
    id: opts.id ?? makeMarketId(),
    params: opts.params ?? makeMarketParams(),
    state: {
      totalSupplyAssets,
      totalSupplyShares: totalSupplyAssets * 1_000_000n, // 1:1 ratio simplified
      totalBorrowAssets,
      totalBorrowShares: totalBorrowAssets * 1_000_000n
    },
    cap: opts.cap,
    vaultAssets: opts.vaultAssets,
    rateAtTarget: opts.rateAtTarget
  }
}

export const makeIdleMarket = (vaultAssets: bigint, cap?: bigint): VaultMarketData => ({
  id: makeMarketId(),
  params: makeMarketParams({
    collateralToken: zeroAddress,
    oracle: zeroAddress,
    irm: zeroAddress,
    lltv: 0n
  }),
  state: {
    totalSupplyAssets: vaultAssets,
    totalSupplyShares: vaultAssets * 1_000_000n,
    totalBorrowAssets: 0n,
    totalBorrowShares: 0n
  },
  cap: cap ?? maxUint256,
  vaultAssets,
  rateAtTarget: 0n
})

export const makeVaultData = (markets: VaultMarketData[], vault: Address = VAULT): VaultData => ({
  vaultAddress: vault,
  marketsData: markets
})
