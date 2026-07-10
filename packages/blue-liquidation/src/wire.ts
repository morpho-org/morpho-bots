import type { Address, Hex } from 'viem'

import { getAddress, isAddress, isHex } from 'viem'

/**
 * The domain namespace this core owns on the wire. The envelope's `domain`/`op`/`chainId` fields —
 * not the opaque `id` string — are authoritative for routing (see the pipeline TIB), so generic
 * transport code never parses an id; only this core does, via {@link parseOpportunityId}.
 */
export const DOMAIN = 'blue'

/**
 * The source op this domain's ids belong to. It is the SECOND, generic segment of every id
 * (`<domain>:<op>:…`) and stays stable through the pipe: `liquidate` re-emits the records it
 * consumes under this same `op`, so the queue's outcomes trace back to the source that found them.
 */
export const OP = 'unhealthy-positions'

const MARKET_ID_HEX_LENGTH = 66 // '0x' + 32 bytes

/**
 * The wire id for a liquidation opportunity: `blue:unhealthy-positions:<chainId>:<marketId>:<borrower>`
 * with both hex values lowercased. Self-describing, pasteable into `liquidate` bare, and the opaque
 * dedupe label the queue keys `Pending.label` on.
 */
export function formatOpportunityId(chainId: number, marketId: Hex, borrower: Address): string {
  return `${DOMAIN}:${OP}:${chainId}:${marketId.toLowerCase()}:${borrower.toLowerCase()}`
}

export type ParsedOpportunityId = { chainId: number; marketId: Hex; borrower: Address }

/**
 * Parses a wire id back into its routing components, or `null` when it is malformed or not this
 * domain/op. `act` re-derives everything from these fields, so a rejected id becomes a `bad_id`
 * outcome rather than a thrown error.
 */
export function parseOpportunityId(id: string): ParsedOpportunityId | null {
  const parts = id.split(':')
  if (parts.length !== 5) return null
  const [domain, op, chainIdRaw, marketId, borrower] = parts
  if (domain !== DOMAIN || op !== OP) return null
  if (chainIdRaw === undefined || !/^\d+$/.test(chainIdRaw)) return null
  if (marketId === undefined || !isHex(marketId) || marketId.length !== MARKET_ID_HEX_LENGTH) {
    return null
  }
  if (borrower === undefined || !isAddress(borrower, { strict: false })) return null
  return {
    chainId: Number(chainIdRaw),
    marketId: marketId.toLowerCase() as Hex,
    borrower: getAddress(borrower)
  }
}
