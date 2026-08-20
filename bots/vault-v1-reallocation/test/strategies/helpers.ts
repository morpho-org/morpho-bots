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

const makeMarketParams = (overrides?: Partial<InputMarketParams>): InputMarketParams => {
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
  /** Defaults to {@link RATE_AT_TARGET}; only the AdaptiveCurveIRM strategies read it. */
  rateAtTarget?: bigint
  id?: Hex
  params?: InputMarketParams
  /** Defaults to true; set false to model a market on an IRM other than the AdaptiveCurveIRM. */
  isAdaptiveCurve?: boolean
}): VaultMarketData => {
  const totalSupplyAssets = parseUnits('100000', 6)
  const totalBorrowAssets = MathLib.wMulDown(totalSupplyAssets, opts.utilization)
  return {
    id: opts.id ?? makeMarketId(),
    params: opts.params ?? makeMarketParams(),
    state: {
      totalSupplyAssets,
      totalBorrowAssets
    },
    cap: opts.cap,
    vaultAssets: opts.vaultAssets,
    rateAtTarget: opts.rateAtTarget ?? RATE_AT_TARGET,
    isAdaptiveCurve: opts.isAdaptiveCurve ?? true,
    isIdle: false
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
    totalBorrowAssets: 0n
  },
  cap: cap ?? maxUint256,
  vaultAssets,
  rateAtTarget: 0n,
  isAdaptiveCurve: false,
  isIdle: true
})

export const VAULT_OWNER = getAddress('0x0000000000000000000000000000000000000002')
export const VAULT_CURATOR = getAddress('0x0000000000000000000000000000000000000003')

export const makeVaultData = (markets: VaultMarketData[], vault: Address = VAULT): VaultData => ({
  vaultAddress: vault,
  owner: VAULT_OWNER,
  curator: VAULT_CURATOR,
  isAllocator: true,
  marketsData: markets,
  nonAdaptiveCurveMarketIds: markets
    .filter(market => !market.isAdaptiveCurve && !market.isIdle)
    .map(market => market.id)
})
