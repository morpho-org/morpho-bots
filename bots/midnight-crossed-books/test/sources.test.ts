import type { KernelHead } from '@repo/kernel'
import type { Hex } from 'viem'

import { CrossedBooksResolver } from '@repo/contracts'
import {
  BaseError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  RpcRequestError
} from 'viem'
import { describe, expect, it, vi } from 'vitest'

import type { TakeableBook } from '../src/domain/order-book'
import type { ScanDeps } from '../src/sources'

import { scanBooks } from '../src/sources'
import { MARKET_ID, makeOffer, OTHER_MARKET_ID } from './fixtures/offers'

const HEAD: KernelHead = { number: 42, hash: `0x${'ab'.repeat(32)}` }
const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const crossed: TakeableBook = {
  asks: [makeOffer('ask', 10n, 3n)],
  bids: [makeOffer('bid', 12n, 5n)]
}
const uncrossed: TakeableBook = {
  asks: [makeOffer('ask', 12n, 3n)],
  bids: [makeOffer('bid', 10n, 5n)]
}

const profitOf = (profit: bigint) => encodeAbiParameters([{ type: 'uint256' }], [profit])

const revert = () =>
  new RpcRequestError({
    body: {},
    url: 'http://rpc.example',
    error: {
      code: 3,
      message: 'execution reverted',
      data: encodeErrorResult({
        abi: CrossedBooksResolver.abi,
        errorName: 'InsufficientProfit',
        args: [0n, 1n]
      })
    }
  })

const depsWith = (overrides: Partial<ScanDeps> = {}): ScanDeps => ({
  listMarkets: async () => [{ marketId: MARKET_ID }, { marketId: OTHER_MARKET_ID }],
  getBook: async marketId => (marketId === MARKET_ID ? crossed : uncrossed),
  simulate: async () => profitOf(7n),
  maxMatches: 10,
  minimumProfit: 5n,
  logger: silent,
  ...overrides
})

describe('scanBooks', () => {
  it('reads every listed market at the head, vouching for the ones that do not cross', async () => {
    const simulate = vi.fn(async (_data: Hex, _at: KernelHead) => profitOf(7n))

    const write = await scanBooks(HEAD, depsWith({ simulate }))

    expect(write).toStrictEqual({
      coverage: 'complete',
      entries: { [MARKET_ID]: { data: simulate.mock.calls[0]![0], units: 3n, profit: 7n } },
      basis: { block: 42, blockHash: HEAD.hash }
    })
    expect(simulate).toHaveBeenCalledExactlyOnceWith(expect.any(String), HEAD)
  })

  it('simulates exactly the matched takes, with the configured profit floor', async () => {
    const simulate = vi.fn(async (_data: Hex, _at: KernelHead) => profitOf(7n))

    await scanBooks(HEAD, depsWith({ simulate }))

    const { args } = decodeFunctionData({
      abi: CrossedBooksResolver.abi,
      data: simulate.mock.calls[0]![0]
    })
    expect(args).toStrictEqual([
      [{ offer: crossed.asks[0]!.offer, ratifierData: '0x', units: 3n }],
      [{ offer: crossed.bids[0]!.offer, ratifierData: '0x', units: 3n }],
      5n
    ])
  })

  it('reads a market whose resolution reverts as not crossed', async () => {
    const write = await scanBooks(
      HEAD,
      depsWith({
        simulate: async () => {
          throw revert()
        }
      })
    )

    expect(write).toStrictEqual({
      coverage: 'complete',
      entries: {},
      basis: { block: 42, blockHash: HEAD.hash },
      empty: true
    })
  })

  it('fails a market whose simulation fails without a revert, and carries the rest', async () => {
    const write = await scanBooks(
      HEAD,
      depsWith({
        simulate: async () => {
          throw new BaseError('the node is down')
        }
      })
    )

    expect(write).toStrictEqual({
      coverage: 'carried',
      entries: {},
      absent: [OTHER_MARKET_ID],
      failed: [MARKET_ID],
      basis: { block: 42, blockHash: HEAD.hash }
    })
  })

  it('fails a market whose book cannot be read, and carries the rest', async () => {
    const write = await scanBooks(
      HEAD,
      depsWith({
        getBook: async marketId => {
          if (marketId === OTHER_MARKET_ID) throw new Error('the router is down')
          return crossed
        }
      })
    )

    expect(write).toMatchObject({
      coverage: 'carried',
      absent: [],
      failed: [OTHER_MARKET_ID]
    })
    expect(Object.keys(write.coverage === 'carried' ? write.entries : {})).toStrictEqual([
      MARKET_ID
    ])
  })

  it('changes nothing when the market list cannot be read', async () => {
    const getBook = vi.fn()

    const write = await scanBooks(
      HEAD,
      depsWith({
        listMarkets: async () => {
          throw new Error('the API is down')
        },
        getBook
      })
    )

    expect(write).toStrictEqual({ coverage: 'failed', reason: 'markets' })
    expect(getBook).not.toHaveBeenCalled()
  })
})
