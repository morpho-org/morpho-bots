import type { Address, Client, Hex } from 'viem'

import { tryCatch } from '@repo/utils'
import { BaseError } from 'viem'
import { call } from 'viem/actions'

export type SimulateResult = {
  /**
   * `ok` — the call succeeds from this EOA, safe to broadcast. `revert` — do not send. Callers gate
   * on `ok` only; the domain meaning of a revert belongs at the call site.
   */
  status: 'ok' | 'revert'
  reason?: string
}

/**
 * Simulates one transaction as an `eth_call` from `eoa`, byte-for-byte what would be broadcast
 * (`value` included — defaulting to 0n keeps the sim and the send in lockstep). Any revert is
 * reported as `{ status: 'revert', reason }` rather than thrown; what a revert *means* is the
 * caller's domain knowledge. No signer; never sends.
 */
export const simulateCall = async (
  client: Client,
  params: { eoa: Address; to: Address; data: Hex; value?: bigint }
): Promise<SimulateResult> => {
  const { error } = await tryCatch(
    call(client, {
      account: params.eoa,
      to: params.to,
      data: params.data,
      value: params.value ?? 0n
    })
  )
  if (!error) return { status: 'ok' }
  return {
    status: 'revert',
    reason: error instanceof BaseError ? error.shortMessage : error.message
  }
}

/**
 * Simulates the real liquidation — `Executor.exec_606BaXt(...)` from the liquidator EOA,
 * byte-for-byte what gets broadcast. The Executor self-funds via the in-callback swap, so a success
 * means the seized collateral covered the repay (incl. `amountOutMinimum` slippage) and both tokens
 * swept clean. Any revert — not-liquidatable, swap slippage, repay shortfall — means do not
 * broadcast; the tick gates on `ok` only. No signer; never sends.
 *
 * The full-drain (zero-residual) invariant is enforced **structurally**: each bot's
 * `encodeLiquidationExec` always appends two skims that transfer the Executor's entire loan +
 * collateral balance to the EOA, so a successful exec ends at zero balance for standard ERC20s. The
 * literal post-tx zero-balance assertion lives in the bots' anvil fork suites — viem 2.47 has no
 * `eth_simulateV1` helper to read post-state balances inline.
 */
export const simulateLiquidationExec = (
  client: Client,
  params: { executooor: Address; eoa: Address; data: Hex; value?: bigint }
): Promise<SimulateResult> =>
  simulateCall(client, {
    eoa: params.eoa,
    to: params.executooor,
    data: params.data,
    value: params.value
  })
