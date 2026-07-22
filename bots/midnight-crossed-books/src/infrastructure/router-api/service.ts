import type { Address, Hex } from 'viem'

import { getAddress, isAddress, isHex } from 'viem'

import type { OrderBookService } from '../../application/crossed-books-bot.service'
import type {
  BookSide,
  MarketId,
  Offer,
  TakeableBook,
  TakeableOffer
} from '../../domain/order-book'
import type { RouterApiClient } from './client'
import type { components, paths } from './generated/router-api.types'

import { RouterApiError } from '../openapi/error'
import { unwrapOpenApiResult, withOpenApiErrorBoundary } from '../openapi/result'

const TAKEABLE_OFFERS_ENDPOINT =
  '/v0/midnight/books/{market-id}/{side}/takeable-offers' as const satisfies keyof paths

type WireTakeableOffer = components['schemas']['TakeableOfferResponse']
type WireOffer = components['schemas']['OfferDataResponse']

function toHex(value: string, bytes?: number): Hex {
  if (!isHex(value, { strict: true }) || (bytes !== undefined && value.length !== 2 + bytes * 2)) {
    throw new Error(`Invalid hex value: ${value}`)
  }
  return value
}

function toAddress(value: string): Address {
  if (!isAddress(value, { strict: false })) throw new Error(`Invalid address: ${value}`)
  return getAddress(value)
}

function toOffer(wire: WireOffer): Offer {
  return {
    market: {
      chainId: BigInt(wire.market.chain_id),
      midnight: toAddress(wire.market.midnight),
      loanToken: toAddress(wire.market.loan_token),
      collateralParams: wire.market.collaterals.map(collateral => ({
        token: toAddress(collateral.token),
        lltv: BigInt(collateral.lltv),
        liquidationCursor: BigInt(collateral.liquidation_cursor),
        oracle: toAddress(collateral.oracle)
      })),
      maturity: BigInt(wire.market.maturity),
      rcfThreshold: BigInt(wire.market.rcf_threshold),
      enterGate: toAddress(wire.market.enter_gate),
      liquidatorGate: toAddress(wire.market.liquidator_gate)
    },
    buy: wire.buy,
    maker: toAddress(wire.maker),
    start: BigInt(wire.start),
    expiry: BigInt(wire.expiry),
    tick: BigInt(wire.tick),
    group: toHex(wire.group, 32),
    callback: toAddress(wire.callback),
    callbackData: toHex(wire.callback_data),
    receiverIfMakerIsSeller: toAddress(wire.receiver_if_maker_is_seller),
    ratifier: toAddress(wire.ratifier),
    reduceOnly: wire.reduce_only,
    maxUnits: BigInt(wire.max_units),
    maxAssets: BigInt(wire.max_assets),
    continuousFeeCap: BigInt(wire.continuous_fee_cap)
  }
}

function toTakeableOffer(wire: WireTakeableOffer): TakeableOffer {
  return {
    marketId: toHex(wire.market_id, 32),
    units: BigInt(wire.units),
    offer: toOffer(wire.offer),
    ratifierData: toHex(wire.ratifier_data)
  }
}

export class RouterApiService implements OrderBookService {
  constructor(private readonly client: RouterApiClient) {}

  async getTakeableBook(marketId: MarketId): Promise<TakeableBook> {
    const [asks, bids] = await Promise.all([
      this._listSide(marketId, 'asks'),
      this._listSide(marketId, 'bids')
    ])

    return { asks, bids }
  }

  private _listSide(marketId: MarketId, side: BookSide): Promise<TakeableOffer[]> {
    return withOpenApiErrorBoundary(TAKEABLE_OFFERS_ENDPOINT, RouterApiError, async () => {
      const result = await this.client.GET(TAKEABLE_OFFERS_ENDPOINT, {
        params: { path: { 'market-id': marketId, side } }
      })
      const body = unwrapOpenApiResult(result, TAKEABLE_OFFERS_ENDPOINT, RouterApiError)

      return body.data
        .map(toTakeableOffer)
        .filter(
          offer => offer.units > 0n && offer.marketId.toLowerCase() === marketId.toLowerCase()
        )
    })
  }
}
