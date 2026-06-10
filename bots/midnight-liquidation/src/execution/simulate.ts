import type { Address, Client, Hex } from 'viem'

import { MidnightAbi } from '@repo/abis/v2'
import { tryCatch } from '@repo/utils'
import { BaseError, ContractFunctionRevertedError } from 'viem'
import { simulateContract } from 'viem/actions'

import type { LiquidationPlan } from '../sizing/plan'
import type { Obligation } from './encode-call'

// Solady `SafeTransferLib.TransferFromFailed()` — the revert the loan-token pull throws when the
// caller (the Executor, impersonated here) holds no funds. In Phase 2 this is the EXPECTED outcome
// for a genuinely-liquidatable position: everything upstream (gate, liquidatable check, the
// seized↔repaid derivation, the recovery-close-factor guard) must have passed to reach the pull.
const TRANSFER_FROM_FAILED_SELECTOR = '0x7939f424'

export type SimulateStatus =
  /** Simulation succeeded outright (rare in Phase 2 — the Executor is unfunded). */
  | 'ok'
  /** Reverted on the loan-token pull only — the plan is structurally valid, just unfunded. */
  | 'unfunded'
  /** Reverted for some other reason — a Midnight string revert here signals a sizing bug. */
  | 'revert'

export type SimulateResult = { status: SimulateStatus; reason?: string }

/**
 * Read-only Phase-2 sink: simulates `Midnight.liquidate(...)` for one plan with `data = '0x'` (no
 * callback, so it does not depend on the not-yet-built Executor handler) impersonating the Executor
 * as `msg.sender` (the gate is `canLiquidate(msg.sender)`, and the loan-token pull is from
 * `msg.sender`). The result discriminates "plan valid but unfunded" (the expected outcome) from a
 * genuine rejection — see {@link SimulateStatus}. No signer; never broadcasts.
 */
export async function simulateLiquidate(
  client: Client,
  params: {
    midnight: Address
    executooor: Address
    obligation: Obligation
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
        params.obligation,
        BigInt(params.plan.collateralIndex),
        params.plan.seizedAssets,
        params.plan.repaidUnits,
        params.borrower,
        '0x'
      ],
      account: params.executooor
    })
  )
  return error ? classifyRevert(error) : { status: 'ok' }
}

/** Maps a viem simulate error to a {@link SimulateResult}, isolating the unfunded sentinel. */
export function classifyRevert(error: Error): SimulateResult {
  const revert =
    error instanceof BaseError
      ? error.walk(cause => cause instanceof ContractFunctionRevertedError)
      : null
  if (!(revert instanceof ContractFunctionRevertedError)) {
    return { status: 'revert', reason: error.message }
  }
  const selector = (revert.raw?.slice(0, 10) ?? revert.signature) as Hex | undefined
  if (selector === TRANSFER_FROM_FAILED_SELECTOR) return { status: 'unfunded' }
  return { status: 'revert', reason: revert.reason ?? revert.signature ?? revert.shortMessage }
}
