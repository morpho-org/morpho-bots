import type { Result } from '@repo/utils'

import type { MidnightApiClient, MidnightApiError } from './client'

import { apiCall } from './client'

/** Per-chain indexer status, distilled to what the staleness gate needs. */
export type ChainStatus = {
  chainId: number
  name: string
  latestIndexedBlock: bigint
}

/**
 * Reads `/v1/midnight/chains` for the indexer-lag staleness gate. The endpoint is not paginated;
 * it returns one entry per indexed chain. The caller compares `latestIndexedBlock` against its
 * own block-poll cursor and decides whether the tick's API data is fresh enough to act on.
 */
export async function getChainStatuses(
  client: MidnightApiClient
): Promise<Result<ChainStatus[], MidnightApiError>> {
  const result = await apiCall(() => client.GET('/v1/midnight/chains'))
  if (result.error) return result

  const statuses = result.data.data.map(chain => ({
    chainId: chain.chain_id,
    name: chain.name,
    latestIndexedBlock: BigInt(chain.latest_indexed_block.number)
  }))
  return { data: statuses, error: null }
}
