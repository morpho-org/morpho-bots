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
