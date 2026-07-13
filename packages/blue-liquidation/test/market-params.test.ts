import { parse, stringify } from '@repo/utils'
import { describe, expect, it } from 'bun:test'
import { getAddress, type Hex } from 'viem'

import type { MarketParams } from '../src/market'
import type { MarketParamsCache, MarketParamsResolver } from '../src/market-params'

import { createMarketParamsResolver } from '../src/market-params'

const ID_A: Hex = `0x${'aa'.repeat(32)}`
const ID_B: Hex = `0x${'bb'.repeat(32)}`

function params(loanToken: string): MarketParams {
  return {
    loanToken: getAddress(loanToken),
    collateralToken: getAddress('0x4200000000000000000000000000000000000006'),
    oracle: getAddress('0x1111111111111111111111111111111111111111'),
    irm: getAddress('0x46415998764C29aB2a25CbeA6254146D50D22687'),
    lltv: 860000000000000000n
  }
}
const PARAMS_A = params('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
const PARAMS_B = params('0x0000000000000000000000000000000000000001')

/** A fetcher that records every batch of ids it was asked to fetch. */
function recordingFetch(table: Record<Hex, MarketParams>) {
  const batches: Hex[][] = []
  const fetch: MarketParamsResolver = async ids => {
    batches.push([...ids])
    const out = new Map<Hex, MarketParams>()
    for (const id of ids) {
      const p = table[id]
      if (p) out.set(id, p)
    }
    return out
  }
  return { fetch, batches }
}

describe('createMarketParamsResolver', () => {
  it('fetches on a miss and returns the resolved params', async () => {
    const { fetch, batches } = recordingFetch({ [ID_A]: PARAMS_A })
    const resolve = createMarketParamsResolver(fetch)
    const out = await resolve([ID_A])
    expect(out.get(ID_A)).toEqual(PARAMS_A)
    expect(batches).toEqual([[ID_A]])
  })

  it('serves a cached id without re-fetching (params are immutable)', async () => {
    const { fetch, batches } = recordingFetch({ [ID_A]: PARAMS_A })
    const resolve = createMarketParamsResolver(fetch)
    await resolve([ID_A])
    const out = await resolve([ID_A])
    expect(out.get(ID_A)).toEqual(PARAMS_A)
    expect(batches).toEqual([[ID_A]]) // only the first call fetched
  })

  it('fetches only the uncached ids on a mixed batch, and dedupes the input', async () => {
    const { fetch, batches } = recordingFetch({ [ID_A]: PARAMS_A, [ID_B]: PARAMS_B })
    const resolve = createMarketParamsResolver(fetch)
    await resolve([ID_A, ID_A]) // dedupe: one A
    const out = await resolve([ID_A, ID_B, ID_B]) // A cached, B is the only miss (deduped)
    expect(out.get(ID_A)).toEqual(PARAMS_A)
    expect(out.get(ID_B)).toEqual(PARAMS_B)
    expect(batches).toEqual([[ID_A], [ID_B]])
  })

  it('returns only the requested ids and omits ids the fetcher could not resolve', async () => {
    const { fetch } = recordingFetch({ [ID_A]: PARAMS_A }) // ID_B unresolvable
    const resolve = createMarketParamsResolver(fetch)
    const out = await resolve([ID_A, ID_B])
    expect(out.has(ID_A)).toBe(true)
    expect(out.has(ID_B)).toBe(false)
    expect(out.size).toBe(1)
  })

  it('seeds from a dumped cache and skips the warm-up fetch for known markets', async () => {
    const first = recordingFetch({ [ID_A]: PARAMS_A })
    const a = createMarketParamsResolver(first.fetch)
    await a([ID_A])

    const state = parse<MarketParamsCache>(stringify(a.dump()), 'throw')
    expect(state).toEqual([[ID_A, PARAMS_A]]) // bigint lltv survives the JSON round trip

    const second = recordingFetch({ [ID_A]: PARAMS_A, [ID_B]: PARAMS_B })
    const b = createMarketParamsResolver(second.fetch, state)
    const out = await b([ID_A])
    expect(out.get(ID_A)).toEqual(PARAMS_A)
    expect(second.batches).toEqual([]) // params are immutable per id: no re-fetch, ever

    await b([ID_B]) // a genuinely new market still fetches
    expect(second.batches).toEqual([[ID_B]])
  })
})
