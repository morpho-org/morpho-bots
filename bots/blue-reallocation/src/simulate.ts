import type { Address, Client, Hex } from 'viem'

import { tryCatch } from '@repo/utils'
import { BaseError } from 'viem'
import { call } from 'viem/actions'

export type SimulateResult = {
  /** `ok` — the reallocate succeeds from this EOA, safe to broadcast. `revert` — do not send. */
  status: 'ok' | 'revert'
  reason?: string
}

/**
 * Simulates the real reallocation — `vault.reallocate(allocations)` from the allocator EOA,
 * byte-for-byte what gets broadcast. Any revert (role revoked, cap exceeded, inconsistent
 * withdrawals/deposits, market removed from the queue) means do not broadcast; the tick gates on
 * `ok` only. No signer; never sends.
 */
export const simulateReallocate = async (
  client: Client,
  params: { vault: Address; eoa: Address; data: Hex }
): Promise<SimulateResult> => {
  const { error } = await tryCatch(
    call(client, { account: params.eoa, to: params.vault, data: params.data, value: 0n })
  )
  if (!error) return { status: 'ok' }
  return {
    status: 'revert',
    reason: error instanceof BaseError ? error.shortMessage : error.message
  }
}
