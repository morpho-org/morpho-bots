import type { Address, Hex } from 'viem'

/** Semantic position identity shared by discovery and liquidation stages. */
export type PositionRecord = {
  kind: 'position'
  chainId: number
  id: string
  marketId: Hex
  borrower: Address
  [field: string]: unknown
}

/** A freshly simulated transaction ready for the per-chain queue. */
export type TransactionRecord = {
  kind: 'transaction'
  chainId: number
  id: string
  to: Address
  data: Hex
  value: string
  simulatedAtBlock?: number
}

/**
 * Best-effort extraction of the correlation `id` from an unvalidated wire record — for logging a
 * skip whose record failed full validation but may still carry a usable id. Returns the `id` only
 * when it is a non-empty string; anything else yields `undefined` so the caller can omit the field
 * rather than log a junk value. Defined here, beside the record types, so both bot cores share one
 * extractor instead of duplicating it.
 */
export function rawRecordId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const id = (value as Record<string, unknown>).id
  return typeof id === 'string' && id.trim() !== '' ? id : undefined
}
