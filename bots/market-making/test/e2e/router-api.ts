import type { Server } from 'bun'
import type { Address, Hex } from 'viem'

import { EcrecoverRatifierUtils, midnightAbi, OfferUtils, Payload } from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { createPublicClient, getAddress, http, isAddressEqual } from 'viem'
import { base } from 'viem/chains'

import { ECRECOVER_RATIFIER, MARKET, MARKET_ID, MIDNIGHT } from './constants'

const BASE_FORK_BLOCK = 48_900_000n

const json = (body: unknown, status = 200) => Response.json(body, { status })

type IndexedOffer = {
  offer: Awaited<ReturnType<typeof Payload.decode>>[number]['offer']
  ratifierData: Hex
}

type RouterOffer = {
  maker: Address
  buy: boolean
  tick: bigint
  continuousFeeCap: bigint
  market: { maturity: bigint }
}

/**
 * Serializes an SDK offer into the Router offer-group response shape consumed by production readers.
 * @param offer - Decoded SDK offer struct.
 * @returns Router-compatible nested offer DTO.
 */
export const routerOfferDto = (offer: RouterOffer) => ({
  market_id: MARKET_ID,
  maker: offer.maker,
  buy: offer.buy,
  tick: Number(offer.tick),
  continuous_fee_cap: String(offer.continuousFeeCap),
  market: { maturity: Number(offer.market.maturity) }
})

/** Stateful HTTP fixture that indexes real mempool payload transactions from the Anvil fork. */
export type RouterApiHandle = {
  baseUrl: string
  server: Server<undefined>
  /** Reads active offers after indexing all newly mined fork blocks. @returns Current unconsumed offers. */
  activeOffers(): Promise<readonly IndexedOffer[]>
}

/**
 * Starts a Router/Morpho HTTP boundary backed by the real Anvil fork transaction and consumption state.
 * @param rpcUrl - Loopback Anvil JSON-RPC URL.
 * @returns Running HTTP fixture and an active-offer inspection boundary.
 * @remarks The fixture mocks only Router/API transport. Offer payloads must be published to the real
 * Base Midnight mempool contract and consumption is read from the real forked Midnight contract.
 */
export const startRouterApi = (rpcUrl: string): RouterApiHandle => {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) })
  const mempool = getAddress(getChainAddress(base.id, 'midnightMempool'))
  const indexed = new Map<string, IndexedOffer & { blockNumber: bigint }>()
  let scannedThrough = BASE_FORK_BLOCK
  let scannedHash: Hex | undefined

  const scan = async () => {
    const latest = await client.getBlockNumber({ cacheTime: 0 })
    let reset = latest < scannedThrough
    if (!reset && scannedHash && scannedThrough > BASE_FORK_BLOCK) {
      const canonical = await client.getBlock({ blockNumber: scannedThrough })
      reset = canonical.hash !== scannedHash
    }
    if (reset) {
      indexed.clear()
      scannedThrough = BASE_FORK_BLOCK
      scannedHash = undefined
    }
    for (let blockNumber = scannedThrough + 1n; blockNumber <= latest; blockNumber += 1n) {
      const block = await client.getBlock({ blockNumber, includeTransactions: true })
      for (const transaction of block.transactions) {
        if (!transaction.to || !isAddressEqual(transaction.to, mempool)) continue
        const items = await Payload.decode(transaction.input)
        for (const item of items) {
          const offer = OfferUtils.toStruct({ offer: item.offer })
          indexed.set(`${offer.group}:${OfferUtils.hashStruct(offer)}`, {
            offer: item.offer,
            ratifierData: item.ratifierData,
            blockNumber
          })
        }
      }
    }
    scannedThrough = latest
    scannedHash =
      latest > BASE_FORK_BLOCK ? (await client.getBlock({ blockNumber: latest })).hash : undefined
  }

  const activeOffers = async () => {
    await scan()
    const active: IndexedOffer[] = []
    for (const item of indexed.values()) {
      const offer = OfferUtils.toStruct({ offer: item.offer })
      const consumed = await client.readContract({
        address: MIDNIGHT,
        abi: midnightAbi,
        functionName: 'consumed',
        args: [offer.maker, offer.group]
      })
      const maximum = offer.maxAssets === 0n ? offer.maxUnits : offer.maxAssets
      if (consumed < maximum) active.push(item)
    }
    return active
  }

  const route = async (request: Request) => {
    const { pathname } = new URL(request.url)

    if (request.method === 'POST' && pathname === '/v0/midnight/mempool/validate') {
      const body = (await request.json()) as { chain_id?: unknown; payload?: unknown }
      if (body.chain_id !== base.id || typeof body.payload !== 'string') {
        return json({ message: 'invalid validation request' }, 400)
      }
      const items = await Payload.decode(body.payload as Hex)
      for (const item of items) {
        const offer = OfferUtils.toStruct({ offer: item.offer })
        if (!isAddressEqual(offer.ratifier, ECRECOVER_RATIFIER)) {
          throw new TypeError('Unsupported ratifier')
        }
        if (item.ratifierData !== '0x') {
          const verified = await EcrecoverRatifierUtils.verifyRatifierData({
            chainId: base.id,
            offer: item.offer,
            ratifierData: item.ratifierData
          })
          if (!isAddressEqual(verified.signer, offer.maker)) {
            throw new TypeError('Ratifier signer does not match maker')
          }
        }
      }
      return json({ data: { issues: [] } })
    }

    const takeableMatch = pathname.match(
      /^\/v0\/midnight\/books\/(0x[0-9a-fA-F]{64})\/(asks|bids)\/takeable-offers$/
    )
    if (takeableMatch) {
      const [, requestedMarketId, side] = takeableMatch
      const data = (await activeOffers()).flatMap(item => {
        const offer = OfferUtils.toStruct({ offer: item.offer })
        if (requestedMarketId !== MARKET_ID || offer.buy !== (side === 'bids')) return []
        return [
          {
            market_id: MARKET_ID,
            units: String(offer.maxUnits || offer.maxAssets),
            offer: { group: offer.group, buy: offer.buy, tick: Number(offer.tick) }
          }
        ]
      })
      return json({ data })
    }

    if (pathname === '/v0/midnight/books') {
      return json({
        cursor: null,
        data: [
          {
            market_id: MARKET_ID,
            id: MARKET_ID,
            chain_id: MARKET.chainId,
            midnight: MARKET.midnight,
            loan_token: MARKET.loanToken,
            collaterals: MARKET.collaterals,
            maturity: MARKET.maturity,
            rcf_threshold: MARKET.rcfThreshold,
            enter_gate: MARKET.enterGate,
            liquidator_gate: MARKET.liquidatorGate,
            asks: [],
            bids: []
          }
        ]
      })
    }

    if (pathname === '/v0/midnight/markets') {
      return json({
        cursor: null,
        data: [{ chain_id: MARKET.chainId, market_id: MARKET_ID, listed: true }]
      })
    }

    if (pathname.startsWith('/v0/midnight/users/') && pathname.endsWith('/offer-groups')) {
      const maker = getAddress(pathname.split('/').at(-2) as Address)
      const offers = (await activeOffers()).filter(item =>
        isAddressEqual(OfferUtils.toStruct({ offer: item.offer }).maker, maker)
      )
      const groups = new Map<Hex, IndexedOffer[]>()
      for (const item of offers) {
        const group = OfferUtils.toStruct({ offer: item.offer }).group
        groups.set(group, [...(groups.get(group) ?? []), item])
      }
      const data = await Promise.all(
        [...groups].map(async ([id, items]) => {
          const structs = items.map(item => OfferUtils.toStruct({ offer: item.offer }))
          const consumed = await client.readContract({
            address: MIDNIGHT,
            abi: midnightAbi,
            functionName: 'consumed',
            args: [maker, id]
          })
          return {
            id,
            chain_id: base.id,
            consumed: String(consumed),
            max_assets: String(
              structs.reduce(
                (maximum, offer) => (offer.maxAssets > maximum ? offer.maxAssets : maximum),
                0n
              )
            ),
            max_units: String(
              structs.reduce(
                (maximum, offer) => (offer.maxUnits > maximum ? offer.maxUnits : maximum),
                0n
              )
            ),
            offers: items.map(item => routerOfferDto(OfferUtils.toStruct({ offer: item.offer })))
          }
        })
      )
      return json({ cursor: null, data })
    }

    if (pathname === '/v0/config/contracts') {
      return json({
        cursor: null,
        data: [
          {
            chain_id: MARKET.chainId,
            address: ECRECOVER_RATIFIER,
            name: 'ecrecoverRatifier'
          }
        ]
      })
    }

    return json({ message: 'unsupported e2e fixture route' }, 404)
  }

  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: route })
  return { baseUrl: server.url.origin, server, activeOffers }
}

/** Stops the stateful Router API fixture. @param handle - Running fixture handle. @returns Completion after connections close. */
export const stopRouterApi = async (handle: RouterApiHandle | undefined) => {
  if (handle) await handle.server.stop(true)
}
