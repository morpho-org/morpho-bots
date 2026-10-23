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

/** First-send tip floor for callers that pass no explicit tip: 1 gwei priority. */
const DEFAULT_PRIORITY_WEI = 10n ** 9n

/**
 * First-send fees from the current base fee: `priorityFeePerGasWei` (default 1 gwei) and a
 * 2×-base-fee headroom max, both clamped to the operator's `maxFeePerGasWei` ceiling. A ceiling below
 * the headroom naturally underprices the first send, and because each bump adds only +12.5%,
 * `priorityFeePerGasWei` is effectively the whole bid and must be set to win rather than escalated
 * into. Note the ceiling also caps how many bumps run at all: {@link bumpFees} drops once either
 * required fee bump exceeds `maxFeePerGasWei`. Pure.
 */
export function initialFees(
  baseFee: bigint,
  maxFeePerGasWei: bigint,
  priorityFeePerGasWei: bigint = DEFAULT_PRIORITY_WEI
): Fees {
  const maxPriorityFeePerGas =
    priorityFeePerGasWei < maxFeePerGasWei ? priorityFeePerGasWei : maxFeePerGasWei
  const target = baseFee * 2n + maxPriorityFeePerGas
  const maxFeePerGas = target < maxFeePerGasWei ? target : maxFeePerGasWei
  return { maxFeePerGas, maxPriorityFeePerGas }
}
