import type { IMarket, IMarketParams } from '@morpho-org/midnight-sdk'
import type { Address } from 'viem'

import { Group, Offer } from '@morpho-org/midnight-sdk'
import { zeroAddress } from 'viem'

export function buildOfferGroups({
  market,
  maker,
  ratifier,
  buyTick,
  sellTick,
  expiry,
  buyAssets,
  sellAssets,
  continuousFeeCap,
  tickSpacing
}: {
  market: IMarketParams | IMarket
  maker: Address
  ratifier: Address
  buyTick: bigint
  sellTick: bigint
  expiry: bigint
  buyAssets: bigint
  sellAssets: bigint
  continuousFeeCap: bigint
  tickSpacing: number
}) {
  if (buyAssets <= 0n) throw new Error('Buy capacity is zero after balance and allowance caps')
  if (sellAssets <= 0n) throw new Error('Sell capacity is zero after accrued-credit cap')

  const common = { market, maker, expiry, ratifier, continuousFeeCap, tickSpacing }
  const buy = Offer.create({ ...common, buy: true, tick: buyTick, maxAssets: buyAssets })
  const sell = Offer.create({
    ...common,
    buy: false,
    tick: sellTick,
    maxAssets: sellAssets,
    reduceOnly: true,
    receiverIfMakerIsSeller: zeroAddress
  })

  return { buy: Group.create([buy]), sell: Group.create([sell]) }
}
