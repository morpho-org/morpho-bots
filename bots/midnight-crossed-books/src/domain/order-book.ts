import type { Address, Hex } from 'viem'

export type MarketId = Hex
export type BookSide = 'asks' | 'bids'

export interface ListedMarket {
  marketId: MarketId
}

export interface CollateralParameters {
  token: Address
  lltv: bigint
  liquidationCursor: bigint
  oracle: Address
}

export interface MarketParameters {
  chainId: bigint
  midnight: Address
  loanToken: Address
  collateralParams: CollateralParameters[]
  maturity: bigint
  rcfThreshold: bigint
  enterGate: Address
  liquidatorGate: Address
}

export interface Offer {
  market: MarketParameters
  buy: boolean
  maker: Address
  start: bigint
  expiry: bigint
  tick: bigint
  group: Hex
  callback: Address
  callbackData: Hex
  receiverIfMakerIsSeller: Address
  ratifier: Address
  reduceOnly: boolean
  maxUnits: bigint
  maxAssets: bigint
  continuousFeeCap: bigint
}

export interface TakeableOffer {
  marketId: MarketId
  units: bigint
  offer: Offer
  ratifierData: Hex
}

export interface TakeableBook {
  asks: TakeableOffer[]
  bids: TakeableOffer[]
}

export interface CrossedMatch {
  ask: TakeableOffer
  bid: TakeableOffer
  units: bigint
}

export interface PreparedResolution {
  marketId: MarketId
  data: Hex
  profit: bigint
}

export type SimulationResult =
  | { status: 'ok'; prepared: PreparedResolution }
  | { status: 'revert'; reason: string }
