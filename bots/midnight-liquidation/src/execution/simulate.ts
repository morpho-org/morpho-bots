import type { Address, Client } from 'viem'

import { MidnightAbi } from '@repo/abis/v2'
import { tryCatch } from '@repo/utils'
import { BaseError, ContractFunctionRevertedError, zeroAddress } from 'viem'
import { simulateContract } from 'viem/actions'

import type { LiquidationPlan } from '../sizing/plan'
import type { Market } from './encode-call'

export type SimulateStatus =
  /** Simulation succeeded outright (rare in Phase 2 — the Executor is unfunded). */
  | 'ok'
  /** Reverted on the loan-token pull only — the plan is structurally valid, just unfunded. */
  | 'unfunded'
  /** Reverted with a Midnight error (or Panic) — the plan was rejected; surface as a bug. */
  | 'revert'

export type SimulateResult = { status: SimulateStatus; reason?: string }

/**
 * Read-only Phase-2 sink: simulates the deployed 9-arg `Midnight.liquidate(...)` for one plan with
 * `callback = address(0)` + `data = '0x'` (so it skips `onLiquidate` and does not depend on the
 * not-yet-built Executor handler), impersonating the Executor as `msg.sender` (the gate is
 * `canLiquidate(msg.sender)`, and the loan-token pull is from `msg.sender`). The result discriminates
 * "plan valid but unfunded" (the expected outcome) from a genuine rejection — see
 * {@link SimulateStatus}. No signer; never broadcasts.
 */
export async function simulateLiquidate(
  client: Client,
  params: {
    midnight: Address
    executooor: Address
    market: Market
    borrower: Address
    plan: LiquidationPlan
  }
): Promise<SimulateResult> {
  const { error } = await tryCatch(
    simulateContract(client, {
      address: params.midnight,
      abi: MidnightAbi,
      functionName: 'liquidate',
      args: [
        params.market,
        BigInt(params.plan.collateralIndex),
        params.plan.seizedAssets,
        params.plan.repaidUnits,
        params.borrower,
        params.plan.postMaturityMode,
        params.executooor, // receiver — seized collateral lands on the Executor pre-callback
        zeroAddress, // callback — none in Phase 2, so onLiquidate is skipped
        '0x' // data — unused without a callback
      ],
      account: params.executooor
    })
  )
  return error ? classifyRevert(error) : { status: 'ok' }
}

/**
 * Maps a viem simulate error to a {@link SimulateResult}. A revert that decodes against `MidnightAbi`
 * to a custom error — or a `Panic` (e.g. an over-seize underflow) — means the plan was rejected
 * on-chain (not liquidatable / bad sizing / RCF cap): surface it loudly. `Error(string)` and
 * selectors absent from `IMidnight` come from the final loan-token pull failing (the token's own
 * revert / Midnight `SafeTransferLib.TransferFromReturnedFalse`, which is not an `IMidnight` error) →
 * the plan is structurally valid, just unfunded.
 */
export function classifyRevert(error: Error): SimulateResult {
  const revert =
    error instanceof BaseError
      ? error.walk(cause => cause instanceof ContractFunctionRevertedError)
      : null
  if (!(revert instanceof ContractFunctionRevertedError)) {
    return { status: 'revert', reason: error.message }
  }
  const errorName = revert.data?.errorName
  if (errorName !== undefined && errorName !== 'Error') {
    return { status: 'revert', reason: errorName }
  }
  return {
    status: 'unfunded',
    reason: revert.reason ?? revert.signature ?? revert.raw?.slice(0, 10)
  }
}
