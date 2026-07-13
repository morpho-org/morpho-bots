import type { Address } from 'viem'

import { getAddress, isAddress, isAddressEqual } from 'viem'

import type { WireTx } from './protocol'

/** The only Executor entrypoint this signer authorizes: exec_606BaXt(bytes[]). */
export const EXECUTOR_SELECTOR = '0x00000001'

/** One signer process authorizes one Executor on one chain. */
export type Policy = {
  chainId: number
  executor: Address
  maxFeePerGasWei: bigint
  maxGasLimit: bigint
  maxDataBytes: number
}

type PolicyCheck =
  | 'chainId'
  | 'executor'
  | 'value'
  | 'maxFeePerGas'
  | 'gas'
  | 'maxDataBytes'
  | 'selector'

type PolicyDecision = { ok: true } | { ok: false; check: PolicyCheck; message: string }

export class PolicyConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PolicyConfigError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decimal(raw: unknown, name: string, allowZero = false): bigint {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw new PolicyConfigError(`${name} must be a decimal string`)
  }
  const value = BigInt(raw)
  if (!allowZero && value === 0n) throw new PolicyConfigError(`${name} must be greater than zero`)
  return value
}

/** Parses the deliberately flat, strict policy object used by one signer process. */
export function parsePolicy(raw: unknown): Policy {
  if (!isRecord(raw)) throw new PolicyConfigError('policy must be a JSON object')
  const expected = new Set([
    'chainId',
    'executor',
    'maxFeePerGasWei',
    'maxGasLimit',
    'maxDataBytes'
  ])
  const unknown = Object.keys(raw).filter(key => !expected.has(key))
  if (unknown.length > 0) {
    throw new PolicyConfigError(`unknown policy field(s): ${unknown.join(', ')}`)
  }
  if (typeof raw.chainId !== 'number' || !Number.isInteger(raw.chainId) || raw.chainId <= 0) {
    throw new PolicyConfigError('chainId must be a positive integer')
  }
  if (typeof raw.executor !== 'string' || !isAddress(raw.executor, { strict: false })) {
    throw new PolicyConfigError('executor must be a valid address')
  }
  if (
    typeof raw.maxDataBytes !== 'number' ||
    !Number.isInteger(raw.maxDataBytes) ||
    raw.maxDataBytes < 0
  ) {
    throw new PolicyConfigError('maxDataBytes must be a non-negative integer')
  }
  return {
    chainId: raw.chainId,
    executor: getAddress(raw.executor),
    maxFeePerGasWei: decimal(raw.maxFeePerGasWei, 'maxFeePerGasWei'),
    maxGasLimit: decimal(raw.maxGasLimit, 'maxGasLimit'),
    maxDataBytes: raw.maxDataBytes
  }
}

/** Default-deny authorization with value and Executor selector fixed as non-configurable invariants. */
export function evaluatePolicy(policy: Policy, tx: WireTx): PolicyDecision {
  const deny = (check: PolicyCheck, message: string): PolicyDecision => ({
    ok: false,
    check,
    message
  })
  if (tx.chainId !== policy.chainId) {
    return deny('chainId', `chainId ${tx.chainId} does not equal ${policy.chainId}`)
  }
  if (!isAddressEqual(tx.to, policy.executor)) {
    return deny('executor', `target ${tx.to} is not the configured Executor`)
  }
  if (BigInt(tx.value) !== 0n) return deny('value', 'transaction value must be zero')
  if (BigInt(tx.maxFeePerGas) > policy.maxFeePerGasWei) {
    return deny('maxFeePerGas', `maxFeePerGas ${tx.maxFeePerGas} exceeds policy ceiling`)
  }
  if (BigInt(tx.gas) > policy.maxGasLimit) {
    return deny('gas', `gas ${tx.gas} exceeds policy ceiling`)
  }
  const dataBytes = (tx.data.length - 2) / 2
  if (dataBytes > policy.maxDataBytes) {
    return deny('maxDataBytes', `calldata size ${dataBytes} exceeds policy ceiling`)
  }
  if (tx.data.slice(0, 10).toLowerCase() !== EXECUTOR_SELECTOR) {
    return deny('selector', `calldata must call Executor selector ${EXECUTOR_SELECTOR}`)
  }
  return { ok: true }
}
