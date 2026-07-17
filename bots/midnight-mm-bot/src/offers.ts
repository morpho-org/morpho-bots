import type { IMarket } from '@morpho-org/midnight-sdk'
import type { Address } from 'viem'

import { Group, Offer, Tree } from '@morpho-org/midnight-sdk'

import type { MarketQuoteConfig } from './config'

import { buildLadderTicks } from './ladder'
export function buildOfferTree({
  market,
  config,
  maker,
  ratifier,
  start,
  expiry
}: {
  market: IMarket
  config: MarketQuoteConfig
  maker: Address
  ratifier: Address
  start: bigint
  expiry: bigint
}) {
  const { bids, asks } = buildLadderTicks(config, market.tickSpacing)
  const common = {
    market,
    maker,
    start,
    expiry,
    ratifier,
    maxUnits: config.maxUnits,
    continuousFeeCap: BigInt(market.continuousFee)
  }
  const bidGroup = Group.create(bids.map(tick => Offer.create({ ...common, buy: true, tick })))
  const askGroup = Group.create(asks.map(tick => Offer.create({ ...common, buy: false, tick })))
  return { tree: Tree.create([bidGroup, askGroup]), bidGroup, askGroup }
}
