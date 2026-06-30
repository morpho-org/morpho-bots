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
 * collateral covered the repay (incl. `amountOutMinimum` slippage) and both tokens swept clean. Any
 * revert — not-liquidatable, swap slippage, repay shortfall — means do not broadcast; the tick gates
 * on `ok` only (TIB Amendment §10). No signer; never sends.
 *
 * The full-drain (zero-residual) invariant is enforced **structurally**: `encodeLiquidationExec`
 * always appends two `skim`s that transfer the Executor's entire loan + collateral balance to the EOA
 * (unit-tested in encode-call.test.ts), so a successful exec ends at zero balance for standard ERC20s.
 * The literal post-tx zero-balance assertion lives in the anvil fork suite — viem 2.47 has
 * no `eth_simulateV1` helper to read post-state balances inline.
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
