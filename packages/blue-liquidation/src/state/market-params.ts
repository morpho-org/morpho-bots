import type { Address, Client, Hex } from 'viem'

import { MorphoAbi } from '@repo/contracts'
import { isNonZeroAddress } from '@repo/utils'
import { multicall } from 'viem/actions'

import type { MarketParams } from '../market'

// Canonical Multicall3, deployed at the same address on Base and every other chain. Passed
// explicitly so the fetcher doesn't depend on viem inferring it from the (chain-erased) client type.
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const

/** Resolves a batch of market ids to their immutable {@link MarketParams}. Ids that don't resolve
 * (e.g. a non-existent market) are simply absent from the returned map. */
export type MarketParamsResolver = (ids: readonly Hex[]) => Promise<Map<Hex, MarketParams>>

/**
 * On-chain fetcher: reads `idToMarketParams(id)` from the Morpho singleton for a batch of ids in one
 * Multicall3 `aggregate3`. Blue stores every market's immutable params keyed by id, so this recovers
 * `(loanToken, collateralToken, oracle, irm, lltv)` authoritatively — no `CreateMarket` index needed
 * (and no-code rindexer can't decode that event's `MarketParams` struct anyway). `allowFailure` keeps
 * one bad id from sinking the batch; a zero `loanToken` (unknown id) is treated as unresolved.
 */
export function multicallIdToMarketParams(client: Client, morpho: Address): MarketParamsResolver {
  return async ids => {
    const out = new Map<Hex, MarketParams>()
    if (ids.length === 0) return out
    const results = await multicall(client, {
      multicallAddress: MULTICALL3,
      allowFailure: true,
      contracts: ids.map(
        id =>
          ({
            address: morpho,
            abi: MorphoAbi,
            functionName: 'idToMarketParams',
            args: [id]
          }) as const
      )
    })
    ids.forEach((id, i) => {
      const r = results[i]
      if (!r || r.status !== 'success') return
      const p = r.result
      if (!isNonZeroAddress(p.loanToken)) return // unknown id → zeroed params; skip
      out.set(id, {
        loanToken: p.loanToken,
        collateralToken: p.collateralToken,
        oracle: p.oracle,
        irm: p.irm,
        lltv: p.lltv
      })
    })
    return out
  }
}

/** Restorable resolver cache: what `dump()` emits and `initialEntries` accepts. */
export type MarketParamsCache = [id: Hex, params: MarketParams][]

/**
 * Wraps a {@link MarketParamsResolver} with an unbounded in-memory cache. `MarketParams` are immutable
 * per id (the id IS `keccak256(abi.encode(params))`), so a resolved entry is valid forever — after the
 * first sight of a market, its params never need re-fetching. Each call fetches only the ids not yet
 * cached (deduped), so steady-state discovery makes zero on-chain calls once every market is known and
 * only pays for genuinely new markets. Returns a map limited to the requested ids. `initialEntries`
 * seeds the cache (safe to trust indefinitely — params are immutable per id) and `dump()` exports it,
 * so one-shot processes skip the warm-up multicall for every already-seen market.
 */
export function createMarketParamsResolver(
  fetch: MarketParamsResolver,
  initialEntries?: MarketParamsCache
): MarketParamsResolver & { dump(): MarketParamsCache } {
  const cache = new Map<Hex, MarketParams>(initialEntries ?? [])
  const resolve: MarketParamsResolver = async ids => {
    const unique = [...new Set(ids)]
    // Only cache HITS are stored, so an id that never resolves (e.g. a non-market) is a miss every
    // tick — harmless (one `allowFailure` multicall slot), never memoized as a false negative.
    const misses = unique.filter(id => !cache.has(id))
    if (misses.length > 0) {
      const fetched = await fetch(misses)
      for (const [id, params] of fetched) cache.set(id, params)
    }
    const out = new Map<Hex, MarketParams>()
    for (const id of unique) {
      const params = cache.get(id)
      if (params) out.set(id, params)
    }
    return out
  }
  return Object.assign(resolve, { dump: (): MarketParamsCache => [...cache.entries()] })
}
