import type { Result } from '@repo/utils'

import type { MidnightApiClient, MidnightApiError } from './client'
import type { components } from './generated'

import { apiCall } from './client'
import { paginate } from './pagination'

// The API's max page size for /positions (the v0 TIB's 200 exceeds it).
const PAGE_SIZE = 100

/** A single borrow position row as returned by `/v1/midnight/positions`. */
export type BorrowPosition = components['schemas']['PositionsResponseDto']['data'][number]

/**
 * Lists a single borrower's open borrow positions on one chain (debt ≥ `debtGte`, default 1).
 *
 * NOTE: `/v1/midnight/positions` requires a `user`, so this is per-borrower — the API has no
 * global position listing the v0 TIB assumed. The orchestrator composes the borrower set from
 * other endpoints (markets + activities). Rows carry `market_id`, `maturity`, `debt`, and the
 * activated `collaterals`, but not the full on-chain `Market` params; those are read from
 * `/markets` and re-validated by the on-chain lens (Phase 2).
 */
export async function listBorrowPositions(
  client: MidnightApiClient,
  params: { user: string; chainId: number; debtGte?: bigint }
): Promise<Result<BorrowPosition[], MidnightApiError>> {
  const debtGte = params.debtGte ?? 1n
  const rows: BorrowPosition[] = []
  let failure: MidnightApiError | null = null

  const pages = paginate<BorrowPosition>(async cursor => {
    const result = await apiCall(() =>
      client.GET('/v1/midnight/positions', {
        params: {
          query: {
            user: params.user,
            chain_ids: [params.chainId],
            types: ['borrow'],
            debt_gte: debtGte.toString(),
            limit: PAGE_SIZE,
            cursor
          }
        }
      })
    )
    if (result.error) {
      // Surface the typed error after the loop; returning a terminal page stops pagination cleanly.
      failure = result.error
      return { cursor: null, data: [] }
    }
    return { cursor: result.data.cursor, data: result.data.data }
  })

  for await (const row of pages) rows.push(row)
  return failure ? { data: null, error: failure } : { data: rows, error: null }
}
