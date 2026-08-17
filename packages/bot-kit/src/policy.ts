import type { Address, Hex } from 'viem'

import { tryCatch } from '@repo/utils'
import { decodeAbiParameters, isAddress, isAddressEqual } from 'viem'

/** The only Executor entrypoint the signer authorizes: exec_606BaXt(bytes[]). */
export const EXECUTOR_SELECTOR = '0x00000001'

/** Default gas-limit ceiling (matches the daemon-era signer policy default). */
export const DEFAULT_MAX_GAS_LIMIT = 15_000_000n

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
  maxFeePerGasWei: bigint
  maxGasLimit: bigint
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
  const dataBytes = (tx.data.length - 2) / 2
  if (dataBytes > policy.maxDataBytes) {
    return deny('maxDataBytes', `calldata size ${dataBytes} exceeds policy ceiling`)
  }
  const selector = (policy.selector ?? EXECUTOR_SELECTOR).toLowerCase()
  if (tx.data.slice(0, 10).toLowerCase() !== selector) {
    return deny('selector', `calldata must call configured selector ${selector}`)
  }
  if (policy.multicall) {
    // A throw out of the deep check must never escape the PolicyDecision contract — default-deny.
    const { data: reason, error } = tryCatch(() => checkMulticall(policy.multicall!, tx))
    if (error) return deny('data', 'multicall authorization threw; denying')
    if (reason !== undefined) return deny('data', reason)
  }
  return { ok: true }
}

// One inner call must span at least selector (4 bytes) + one 32-byte argument word.
const MIN_INNER_CALL_HEX_LENGTH = 2 + 8 + 64

const decodeMulticallData = (data: Hex): readonly Hex[] | undefined => {
  try {
    const [calls] = decodeAbiParameters([{ type: 'bytes[]' }] as const, `0x${data.slice(10)}`)
    return calls
  } catch {
    return undefined
  }
}

const checkMulticall = (spec: MulticallPolicy, tx: PolicyTx): string | undefined => {
  const calls = decodeMulticallData(tx.data)
  if (calls === undefined) return 'calldata does not decode as multicall(bytes[])'
  if (calls.length === 0) return 'multicall bundle must not be empty'
  const allowedTargets = Object.entries(spec.innerTargetsByOuter).find(([outer]) =>
    isAddressEqual(tx.to, outer as Address)
  )?.[1]
  if (allowedTargets === undefined || allowedTargets.length === 0) {
    return `no inner targets configured for outer target ${tx.to}`
  }
  const selectors = spec.innerSelectors.map(s => s.toLowerCase())
  for (const call of calls) {
    if (call.length < MIN_INNER_CALL_HEX_LENGTH) {
      return `inner call ${call} is too short to carry a selector and an address argument`
    }
    const innerSelector = call.slice(0, 10).toLowerCase()
    if (!selectors.includes(innerSelector)) {
      return `inner selector ${innerSelector} is not allowed`
    }
    const word = call.slice(10, 74)
    const firstArg = `0x${word.slice(24)}`
    if (!/^0{24}$/.test(word.slice(0, 24)) || !isAddress(firstArg, { strict: false })) {
      return 'inner call first argument is not an address'
    }
    if (!allowedTargets.some(target => isAddressEqual(firstArg, target))) {
      return `inner call targets unregistered address ${firstArg}`
    }
  }
  return undefined
}
