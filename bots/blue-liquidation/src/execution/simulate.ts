import type { Address, Client, Hex } from 'viem'

import { tryCatch } from '@repo/utils'
import { BaseError } from 'viem'
import { call } from 'viem/actions'

export type SimulateStatus =
  /** The full `exec_606BaXt` (seize → swap → repay → sweep) succeeds — safe to broadcast. */
  | 'ok'
  /** Reverted in the exec path (not liquidatable, swap slippage, repay shortfall) — do not send. */
  | 'revert'

export type SimulateResult = { status: SimulateStatus; reason?: string }

/**
 * Simulates the real liquidation — `Executor.exec_606BaXt(...)` from the liquidator EOA, byte-for-byte
 * what gets broadcast. The Executor self-funds via the in-callback swap, so a success means the seized
 * collateral covered the repay, including the swap's encoded min-out. Any revert means do not
 * broadcast; the tick gates on `ok` only. No signer; never sends.
 */
export async function simulateLiquidationExec(
  client: Client,
  params: { executooor: Address; eoa: Address; data: Hex }
): Promise<SimulateResult> {
  const { error } = await tryCatch(
    call(client, { account: params.eoa, to: params.executooor, data: params.data })
  )
  if (!error) return { status: 'ok' }
  return {
    status: 'revert',
    reason: error instanceof BaseError ? error.shortMessage : error.message
  }
}
