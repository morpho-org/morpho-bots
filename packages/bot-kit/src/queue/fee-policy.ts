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
 * Computes the replacement fees for a stuck tx, or signals `drop` when the bumped `maxFeePerGas`
 * would exceed the operator's `maxFeeWei` ceiling — we drop rather than chase a gas spike. Pure.
 *
 * - new priority = max(prev × 1.125, prev + 1)
 * - new max = max(prev × 1.125, baseFee × 2 + new priority)
 */
export function bumpFees({
  maxFeePerGas,
  maxPriorityFeePerGas,
  baseFee,
  maxFeeWei
}: {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  baseFee: bigint
  maxFeeWei: bigint
}): BumpResult {
  const newPriority = bumped(maxPriorityFeePerGas)
  const bumpedMax = bumped(maxFeePerGas)
  const targetMax = baseFee * 2n + newPriority
  const newMax = bumpedMax > targetMax ? bumpedMax : targetMax

  if (newMax > maxFeeWei) return { kind: 'drop' }
  return { kind: 'bump', fees: { maxFeePerGas: newMax, maxPriorityFeePerGas: newPriority } }
}

/**
 * Whether a first send at `priorityFeeWei` leaves room for at least one replacement bump under
 * `maxFeeWei`. A tip too close to the ceiling makes `bumpFees` return `drop` on the first stuck
 * check, which latches a nonce hole and blocks every later send, so config should reject it up
 * front. Ignores the base-fee component, which is only known at send time. Pure.
 */
export const hasBumpHeadroom = (priorityFeeWei: bigint, maxFeeWei: bigint): boolean =>
  bumped(priorityFeeWei) <= maxFeeWei

/** First-send tip floor for callers that pass no explicit tip: 1 gwei priority. */
const DEFAULT_PRIORITY_WEI = 10n ** 9n

/**
 * First-send fees from the current base fee: `priorityFeeWei` (default 1 gwei) and a 2×-base-fee
 * headroom max, both clamped to the operator's `maxFeeWei` ceiling. A ceiling below the headroom
 * naturally underprices the first send, but the bump path tops out at 3 attempts of +12.5%, so
 * `priorityFeeWei` is effectively the whole bid and must be set to win, not escalated into. Pure.
 */
export function initialFees(
  baseFee: bigint,
  maxFeeWei: bigint,
  priorityFeeWei: bigint = DEFAULT_PRIORITY_WEI
): Fees {
  const maxPriorityFeePerGas = priorityFeeWei < maxFeeWei ? priorityFeeWei : maxFeeWei
  const target = baseFee * 2n + maxPriorityFeePerGas
  const maxFeePerGas = target < maxFeeWei ? target : maxFeeWei
  return { maxFeePerGas, maxPriorityFeePerGas }
}
