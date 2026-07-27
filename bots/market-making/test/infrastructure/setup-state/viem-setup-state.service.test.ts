import type { Address, Hex } from 'viem'

import { describe, expect, test } from 'bun:test'

import { ViemSetupStateService } from '../../../src/infrastructure/setup-state/viem-setup-state.service'

const maker: Address = '0x1111111111111111111111111111111111111111'
const midnight: Address = '0x2222222222222222222222222222222222222222'
const loanAsset: Address = '0x3333333333333333333333333333333333333333'
const ratifier: Address = '0xd6e70365C8E8DDa9a4ca662C07bbE663b017755E'
const marketId: Hex = `0x${'55'.repeat(32)}`
const knownGroup: Hex = `0x${'66'.repeat(32)}`
const unknownGroup: Hex = `0x${'77'.repeat(32)}`

function createState(responses: Record<string, unknown>) {
  const calls: string[] = []
  const chain = {
    getChainId: async () => 8453,
    getCode: async () => '0x1234' as Hex,
    getBalance: async () => 10n,
    getBlock: async () => ({ number: 100n, timestamp: 1_000n }),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'allowance') return 100n
      if (functionName === 'isAuthorized') return true
      if (functionName === 'toMarket') {
        return {
          chainId: 8453n,
          midnight,
          loanToken: loanAsset,
          collateralParams: [],
          maturity: 2_000n,
          rcfThreshold: 0n,
          enterGate: maker,
          liquidatorGate: maker
        }
      }
      if (functionName === 'tickSpacing') return 4
      throw new Error(`unexpected ${functionName}`)
    }
  }
  const reference = {
    getBlock: async ({ blockTag, blockNumber }: { blockTag?: string; blockNumber?: bigint }) => {
      calls.push(blockTag ?? String(blockNumber))
      return blockTag === 'latest'
        ? { number: 100n, timestamp: 1_000n }
        : { number: blockNumber ?? null, timestamp: 998n }
    }
  }
  const request = async (url: string) => {
    calls.push(url)
    const match = Object.entries(responses).find(([path]) => url.includes(path))
    if (!match) throw new Error(`unexpected URL ${url}`)
    return match[1]
  }
  return {
    calls,
    state: new ViemSetupStateService(chain, reference, request, {
      privateKey: `0x${'11'.repeat(32)}`,
      midnight,
      loanAsset,
      morphoApiBaseUrl: 'https://api.example',
      routerApiBaseUrl: 'https://router.example',
      marketIds: [marketId],
      v0OfferGroupIds: [knownGroup],
      referenceLookbackBlocks: 1n
    })
  }
}

describe('ViemSetupStateService', () => {
  test('reads a configured book from API allowlist and on-chain state concurrently', async () => {
    const { state } = createState({
      '/v0/midnight/markets': {
        data: [
          {
            market_id: marketId,
            listed: true,
            loan_token: loanAsset,
            maturity: 2_000,
            tick_granularity: 4
          }
        ]
      }
    })

    expect(await state.getBook(marketId)).toEqual({
      id: marketId,
      allowlisted: true,
      active: true,
      loanAsset,
      tickSpacing: 4,
      maturity: 2_000n
    })
  })

  test('checks official ratifier identity, deployed code, and authorization', async () => {
    const { state } = createState({})

    expect(await state.getRatifier(maker, ratifier)).toEqual({
      listed: true,
      supportsEcrecover: true,
      authorized: true
    })
  })

  test('proves the reference RPC serves latest and historical blocks', async () => {
    const { state, calls } = createState({})

    expect(await state.checkReference()).toEqual({
      referenceReadable: true,
      archiveReadable: true
    })
    expect(calls).toEqual(['latest', '99'])
  })

  test('reports unknown groups and inverted maker offers from every page', async () => {
    const firstOffer = {
      market_id: marketId,
      offer: { maker, group: knownGroup, buy: true, tick: 20 }
    }
    const secondOffer = {
      market_id: marketId,
      offer: { maker, group: unknownGroup, buy: false, tick: 10 }
    }
    const { state } = createState({
      'cursor=next': { cursor: null, data: [secondOffer] },
      '/v0/midnight/takeable-offers': { cursor: 'next', data: [firstOffer] }
    })

    expect(await state.inspectOffers(maker)).toEqual({
      unknownNamespaces: [unknownGroup],
      invertedMarketIds: [marketId]
    })
  })
})
