import type { Address, Hex } from 'viem'

import { isAddressEqual } from 'viem'

/** The only Executor entrypoint the signer authorizes: exec_606BaXt(bytes[]). */
export const EXECUTOR_SELECTOR = '0x00000001'

/** Default gas-limit ceiling (matches the daemon-era signer policy default). */
export const DEFAULT_MAX_GAS_LIMIT = 15_000_000n

/** Default calldata byte ceiling (matches the daemon-era signer policy default). */
export const DEFAULT_MAX_DATA_BYTES = 65_536

/**
 * Gas ceiling on a nonce fill, which every policy allows: a zero-value, empty-calldata send to the
 * signing account itself. Above the 21,000 intrinsic cost because Arbitrum-stack chains fold L1 data
 * cost into the estimate: https://docs.arbitrum.io/build-decentralized-apps/how-to-estimate-gas
 */
export const NONCE_FILL_MAX_GAS = 100_000n

/** One allowed operation on one contract, with limits specific to that operation. */
export type PolicyRule = {
  target: Address
  /** Required function selector, or omitted for a raw-calldata endpoint. */
  selector?: Hex
  maxGasLimit: bigint
  maxDataBytes: number
}

/** One signer authorizes one entrypoint on a fixed target set on one chain, under fixed fee/gas/size ceilings. */
export type Policy = {
  chainId: number
  /** Allowed target contracts; an empty list denies every transaction but a nonce fill. */
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
   * lower to make it bind.
   */
  maxSpendWei: bigint
  maxDataBytes: number
  /** Allowed outer selector; defaults to Executor.exec_606BaXt. */
  selector?: Hex
  /**
   * Allowed target and selector pairs with operation-specific gas and calldata limits. When set,
   * these rules replace `targets`, `selector`, `maxGasLimit`, and `maxDataBytes` for
   * authorization. The legacy fields remain required to preserve existing callers.
   */
  rules?: readonly PolicyRule[]
}

/** The prepared-transaction fields the pre-broadcast guard evaluates against a {@link Policy}. */
export type PolicyTx = {
  chainId: number
  /** The signing account; a send to it is authorized only as a nonce fill. */
  from: Address
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

export type PolicyDecision = { ok: true } | { ok: false; check: PolicyCheck; message: string }

/**
 * Default-deny authorization for a prepared transaction, with zero value and a caller-pinned selector
 * (`exec_606BaXt` by default) and the fee/gas/size ceilings taken from the
 * {@link Policy}. The one send outside the policy's targets is the nonce fill, bounded by
 * {@link NONCE_FILL_MAX_GAS}. Every field must satisfy its rule; the first failure decides.
 * In-process, this runs between prepare and broadcast — the cheap defense-in-depth against an
 * upstream encoding bug ever sending value, hitting the wrong contract, or exceeding a ceiling.
 *
 * OUTER-ENVELOPE guard: target, selector, zero value, and fee/gas/size ceilings are pinned. It does
 * not interpret calldata beyond the selector; the kernel's validators read the calldata itself, and
 * each bot simulates its exact request before submit regardless.
 */
// oxlint-disable-next-line complexity
export function evaluatePolicy(policy: Policy, tx: PolicyTx): PolicyDecision {
  const deny = (check: PolicyCheck, message: string): PolicyDecision => ({
    ok: false,
    check,
    message
  })
  if (tx.chainId !== policy.chainId) {
    return deny('chainId', `chainId ${tx.chainId} does not equal ${policy.chainId}`)
  }
  const fill = isAddressEqual(tx.to, tx.from)
  const txSelector = tx.data.slice(0, 10).toLowerCase()
  const targetRules = policy.rules?.filter(rule => isAddressEqual(tx.to, rule.target))
  const rule =
    targetRules?.find(candidate => candidate.selector?.toLowerCase() === txSelector) ??
    targetRules?.find(candidate => candidate.selector === undefined)
  if (fill) {
    if (tx.data !== '0x') return deny('maxDataBytes', 'a nonce fill carries no calldata')
  } else if (policy.rules) {
    if (targetRules?.length === 0) {
      return deny('target', `target ${tx.to} is not among the configured targets`)
    }
    if (!rule) return deny('selector', 'calldata does not match an allowed target operation')
  } else if (!policy.targets.some(target => isAddressEqual(tx.to, target))) {
    return deny('target', `target ${tx.to} is not among the configured targets`)
  }
  if (tx.value !== 0n) return deny('value', 'transaction value must be zero')
  if (tx.maxFeePerGas > policy.maxFeePerGasWei) {
    return deny('maxFeePerGas', `maxFeePerGas ${tx.maxFeePerGas} exceeds policy ceiling`)
  }
  const maxGasLimit = fill ? NONCE_FILL_MAX_GAS : (rule?.maxGasLimit ?? policy.maxGasLimit)
  if (tx.gas > maxGasLimit) {
    return deny('gas', `gas ${tx.gas} exceeds policy ceiling`)
  }
  const spendWei = tx.gas * tx.maxFeePerGas
  if (spendWei > policy.maxSpendWei) {
    return deny('spend', `gas x maxFeePerGas ${spendWei} exceeds policy spend ceiling`)
  }
  const dataBytes = (tx.data.length - 2) / 2
  const maxDataBytes = rule?.maxDataBytes ?? policy.maxDataBytes
  if (dataBytes > maxDataBytes) {
    return deny('maxDataBytes', `calldata size ${dataBytes} exceeds policy ceiling`)
  }
  if (fill) return { ok: true }
  const selector = rule
    ? rule.selector?.toLowerCase()
    : (policy.selector ?? EXECUTOR_SELECTOR).toLowerCase()
  if (selector !== undefined && txSelector !== selector) {
    return deny('selector', `calldata must call configured selector ${selector}`)
  }
  return { ok: true }
}
