import type { Address, Hex } from 'viem'

import { tryCatch } from '@repo/utils'
import { isAddressEqual } from 'viem'

import { checkMulticall } from './policy-multicall.utils'

/** The only Executor entrypoint the signer authorizes: exec_606BaXt(bytes[]). */
export const EXECUTOR_SELECTOR = '0x00000001'

/** Default gas-limit ceiling (matches the daemon-era signer policy default). */
export const DEFAULT_MAX_GAS_LIMIT = 15_000_000n

/**
 * Default ceiling on `gas * maxFeePerGas` for one transaction, in wei (0.5 ETH). Generous by intent:
 * it is meant to bound a runaway, not to price a transaction, and sits well above any plausible
 * liquidation or reallocation exec at either chain's real fee level. Calibrate down from production
 * `tx.confirmed` data. See {@link Policy.maxSpendWei}.
 */
export const DEFAULT_MAX_SPEND_WEI = 5n * 10n ** 17n

/** Default calldata byte ceiling (matches the daemon-era signer policy default). */
export const DEFAULT_MAX_DATA_BYTES = 65_536

/**
 * Deep authorization for a `multicall(bytes[])` envelope, evaluated declaratively by
 * {@link evaluatePolicy}: the calldata must decode as a single non-empty `bytes[]`, every inner
 * call's selector must be listed, and every inner call's FIRST argument (which must be an
 * address — this rule only suits inner functions shaped like VaultV2's
 * `allocate/deallocate(address, …)`) must be registered for the transaction's outer target.
 */
export type MulticallPolicy = {
  /** Allowed inner selectors (e.g. allocate/deallocate). */
  innerSelectors: readonly Hex[]
  /** Allowed first-argument addresses per outer target (e.g. vault → its adapters). */
  innerTargetsByOuter: Readonly<Record<Address, readonly Address[]>>
}

/** One signer authorizes one entrypoint on a fixed target set on one chain, under fixed fee/gas/size ceilings. */
export type Policy = {
  chainId: number
  /** Allowed target contracts; an empty list denies every transaction. */
  targets: readonly Address[]
  /**
   * Ceiling on a single gas unit's price. This is the bump ladder's headroom, NOT a bound on spend:
   * what a transaction can cost is `gas * maxFeePerGas`, which {@link Policy.maxSpendWei} bounds.
   * Lowering this to limit spend shortens the ladder instead — see {@link bumpFees}.
   */
  maxFeePerGasWei: bigint
  /** Ceiling on a signed tx's gas limit. Bounds spend only together with {@link Policy.maxSpendWei}. */
  maxGasLimit: bigint
  /**
   * THE bound on what one transaction can cost, in wei: `gas * maxFeePerGas` evaluated against the
   * gas the node actually estimated, not the ceiling. Neither {@link Policy.maxGasLimit} nor
   * {@link Policy.maxFeePerGasWei} bounds spend alone — their product is what an operator pays in
   * the worst case, so it is asserted directly rather than left implied.
   *
   * Set it to `maxGasLimit * maxFeePerGasWei` to assert exactly what those two already imply; set it
   * lower to make it bind. A queue built with the same value keeps the bump ladder inside it (see
   * `createPendingQueue`), so a budget that binds truncates the ladder cleanly instead of surfacing
   * here — a denial on a replacement would otherwise burn every bump attempt on the same verdict.
   */
  maxSpendWei: bigint
  maxDataBytes: number
  /** Allowed outer selector; defaults to Executor.exec_606BaXt. */
  selector?: Hex
  /** When set, calldata must also satisfy the {@link MulticallPolicy} envelope rules. */
  multicall?: MulticallPolicy
}

/** The prepared-transaction fields the pre-broadcast guard evaluates against a {@link Policy}. */
export type PolicyTx = {
  chainId: number
  to: Address
  data: Hex
  value: bigint
  gas: bigint
  maxFeePerGas: bigint
}

export type PolicyCheck =
  | 'chainId'
  | 'target'
  | 'value'
  | 'maxFeePerGas'
  | 'gas'
  | 'spend'
  | 'maxDataBytes'
  | 'selector'
  | 'data'

export type PolicyDecision = { ok: true } | { ok: false; check: PolicyCheck; message: string }

/** Raised when a prepared transaction fails the default-deny policy — an upstream bug, never sent. */
export class PolicyViolationError extends Error {
  readonly code = 'policy_violation'

  constructor(
    message: string,
    readonly check: PolicyCheck
  ) {
    super(message)
    this.name = 'PolicyViolationError'
  }
}

/**
 * Default-deny authorization for a prepared transaction, with zero value and a caller-pinned selector
 * (`exec_606BaXt` by default) and the fee/gas/size ceilings taken from the
 * {@link Policy}. Every field must satisfy its rule; the first failure decides. In-process, this
 * runs between prepare and broadcast — the cheap defense-in-depth against an upstream encoding bug
 * ever sending value, hitting the wrong contract, or exceeding a ceiling.
 *
 * OUTER-ENVELOPE guard: target, selector, zero value, and fee/gas/size ceilings are pinned. It does
 * not interpret calldata beyond the selector — unless a {@link MulticallPolicy} is configured, in
 * which case the envelope also authorizes each inner call declaratively (still no bot-supplied
 * code). Each bot simulates its exact request before submit regardless.
 */
export function evaluatePolicy(policy: Policy, tx: PolicyTx): PolicyDecision {
  const deny = (check: PolicyCheck, message: string): PolicyDecision => ({
    ok: false,
    check,
    message
  })
  if (tx.chainId !== policy.chainId) {
    return deny('chainId', `chainId ${tx.chainId} does not equal ${policy.chainId}`)
  }
  if (!policy.targets.some(target => isAddressEqual(tx.to, target))) {
    return deny('target', `target ${tx.to} is not among the configured targets`)
  }
  if (tx.value !== 0n) return deny('value', 'transaction value must be zero')
  if (tx.maxFeePerGas > policy.maxFeePerGasWei) {
    return deny('maxFeePerGas', `maxFeePerGas ${tx.maxFeePerGas} exceeds policy ceiling`)
  }
  if (tx.gas > policy.maxGasLimit) {
    return deny('gas', `gas ${tx.gas} exceeds policy ceiling`)
  }
  const spendWei = tx.gas * tx.maxFeePerGas
  if (spendWei > policy.maxSpendWei) {
    return deny('spend', `gas x maxFeePerGas ${spendWei} exceeds policy spend ceiling`)
  }
  const dataBytes = (tx.data.length - 2) / 2
  if (dataBytes > policy.maxDataBytes) {
    return deny('maxDataBytes', `calldata size ${dataBytes} exceeds policy ceiling`)
  }
  const selector = (policy.selector ?? EXECUTOR_SELECTOR).toLowerCase()
  if (tx.data.slice(0, 10).toLowerCase() !== selector) {
    return deny('selector', `calldata must call configured selector ${selector}`)
  }
  const { multicall } = policy
  if (multicall) {
    // A throw out of the deep check must never escape the PolicyDecision contract — default-deny.
    const { data: reason, error } = tryCatch(() => checkMulticall(multicall, tx))
    if (error) return deny('data', 'multicall authorization threw; denying')
    if (reason !== undefined) return deny('data', reason)
  }
  return { ok: true }
}
