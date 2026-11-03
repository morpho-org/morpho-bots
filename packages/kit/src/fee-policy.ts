import type { Chain } from 'viem'

import { bigintMin, mulDivUp } from '@repo/utils'

import { MissingBlockTimeError } from './errors'
import { NONCE_FILL_MAX_GAS } from './policy'

// EIP-1559 mandates a ≥12.5% bump on both fees to replace a pending tx. We bump by 12.5% (1125/1000)
// with a +1 wei floor so tiny fees still clear the replacement threshold.
const BUMP_NUMERATOR = 1125n
const BUMP_DENOMINATOR = 1000n

type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }

type BumpResult = { kind: 'bump'; fees: Fees } | { kind: 'drop' }

function bumped(previous: bigint): bigint {
  const scaled = (previous * BUMP_NUMERATOR) / BUMP_DENOMINATOR
  return scaled > previous + 1n ? scaled : previous + 1n
}

/**
 * Computes the replacement fees for a stuck tx, or signals `drop` when either required fee bump
 * would exceed the operator's `maxFeePerGasWei` ceiling. Base-fee headroom is capped at the ceiling
 * rather than treated as a required bump. Pure.
 *
 * - new priority = max(prev × 1.125, prev + 1)
 * - new max = max(max(prev × 1.125, prev + 1), min(ceiling, baseFee × 2 + new priority))
 */
export function bumpFees({
  maxFeePerGas,
  maxPriorityFeePerGas,
  baseFee,
  maxFeePerGasWei
}: {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  baseFee: bigint
  maxFeePerGasWei: bigint
}): BumpResult {
  const newPriority = bumped(maxPriorityFeePerGas)
  const bumpedMax = bumped(maxFeePerGas)
  const targetMax = baseFee * 2n + newPriority
  const cappedTarget = targetMax < maxFeePerGasWei ? targetMax : maxFeePerGasWei
  const newMax = bumpedMax > cappedTarget ? bumpedMax : cappedTarget

  if (bumpedMax > maxFeePerGasWei || newPriority > maxFeePerGasWei) return { kind: 'drop' }
  return { kind: 'bump', fees: { maxFeePerGas: newMax, maxPriorityFeePerGas: newPriority } }
}

/**
 * Whether a first send at `priorityFeePerGasWei` leaves room for at least one replacement bump
 * under `maxFeePerGasWei`. Ignores the base-fee component, which is only known at send time. Pure.
 */
export const hasBumpHeadroom = (priorityFeePerGasWei: bigint, maxFeePerGasWei: bigint): boolean =>
  bumped(priorityFeePerGasWei) <= maxFeePerGasWei

/** The most a first send tips per gas. */
const MAX_FIRST_TIP_WEI = 10n ** 9n
/** A first tip of a quarter of the cap leaves about ten 12.5% bumps under it (1.125^11 < 4). */
const FIRST_TIP_DIVISOR = 4n

/**
 * First-send fees from the current base fee under the cap `maxFeePerGasWei`: a tip of a quarter of
 * the cap rounded up, at most 1 gwei and at most `marketTip` (at least 1 wei), so a stuck send can
 * re-bid, and a 2×-base-fee headroom max within the cap. {@link bumpFees} drops once either required
 * fee bump would exceed the cap. Pure.
 */
export function initialFees(baseFee: bigint, maxFeePerGasWei: bigint, marketTip?: bigint): Fees {
  const quarterTip = bigintMin(MAX_FIRST_TIP_WEI, mulDivUp(maxFeePerGasWei, 1n, FIRST_TIP_DIVISOR))
  const maxPriorityFeePerGas =
    marketTip === undefined ? quarterTip : bigintMin(quarterTip, marketTip === 0n ? 1n : marketTip)
  const maxFeePerGas = bigintMin(baseFee * 2n + maxPriorityFeePerGas, maxFeePerGasWei)
  return { maxFeePerGas, maxPriorityFeePerGas }
}

/**
 * The per-gas ceiling every kernel bid stays under: what the recovery spend bound funds for a nonce
 * fill's {@link NONCE_FILL_MAX_GAS}, within the policy's `maxFeePerGasWei`.
 */
export const feeCeiling = (maxFeePerGasWei: bigint, recoveryFee: bigint): bigint => {
  const fundable = recoveryFee / NONCE_FILL_MAX_GAS
  return fundable < maxFeePerGasWei ? fundable : maxFeePerGasWei
}

/**
 * The highest per-gas fee a step may bid under `ceiling`: one bump below it, so a fill can always
 * outbid the step. Negative when `ceiling` leaves no room for a step at all.
 */
export const stepCap = (ceiling: bigint): bigint => {
  const scaledFits = ((ceiling + 1n) * BUMP_DENOMINATOR - 1n) / BUMP_NUMERATOR
  return scaledFits < ceiling - 1n ? scaledFits : ceiling - 1n
}

/** How many of `chain`'s blocks span `ms`, and at least `atLeast`, so a time bound holds on every chain. */
export const blocksFor = (
  ms: number,
  chain: Pick<Chain, 'id' | 'blockTime'>,
  atLeast = 1
): number => {
  if (!chain.blockTime) throw new MissingBlockTimeError(chain.id)
  return Math.max(atLeast, Math.ceil(ms / chain.blockTime))
}
