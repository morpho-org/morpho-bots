import { tryCatch } from '@repo/utils';

import type { Address, Client, Hex } from 'viem';
import { BaseError } from 'viem';
import { call } from 'viem/actions';

export type SimulateResult = {
  /**
   * `ok` — the full exec (seize → swap → repay → sweep) succeeds, safe to broadcast. `revert` —
   * reverted in the exec path (not liquidatable, swap slippage, repay shortfall), do not send.
   */
  status: 'ok' | 'revert';
  reason?: string;
};

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
export async function simulateLiquidationExec(
  client: Client,
  params: { executooor: Address; eoa: Address; data: Hex; value?: bigint }
): Promise<SimulateResult> {
  const { error } = await tryCatch(
    call(client, {
      account: params.eoa,
      to: params.executooor,
      data: params.data,
      // Match what gets broadcast byte-for-byte, value included. Liquidation execs are value-0, so
      // this is 0n in practice, but passing it explicitly keeps the sim and the send in lockstep.
      value: params.value ?? 0n
    })
  );
  if (!error) {
    return { status: 'ok' };
  }
  return {
    status: 'revert',
    reason: error instanceof BaseError ? error.shortMessage : error.message
  };
}
