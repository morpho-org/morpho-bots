import type { Address, Hex } from 'viem'

import { addressSchema } from '@repo/utils'
import { isAddressEqual } from 'viem'
import { z } from 'zod'

import type { WireTx } from './protocol'

/** The policy-file version this build understands. */
export const POLICY_VERSION = 1

/**
 * A transaction decoded into bigint fields, handed to calldata modules. Structurally the signing
 * input; modules inspect `to`/`data`/`value` etc. without re-parsing the wire strings.
 */
export type DecodedTx = {
  chainId: number
  to: Address
  data: Hex
  value: bigint
  nonce: number
  gas: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

/**
 * A pluggable deep-calldata check. `parseConfig` runs once at policy-load time (startup) so a bad
 * module config fails the daemon fast; `check` runs per request against the decoded tx. v1 ships the
 * registry EMPTY — the seam that later closes the structural-only gap (skim-recipient lint or
 * balance-delta simulation).
 */
export type CalldataModule = {
  parseConfig(raw: unknown): unknown
  check(tx: DecodedTx, config: unknown): { ok: true } | { ok: false; reason: string }
}

/** Registry of named calldata modules. Ships empty in v1; tests register toy modules. */
export const CALLDATA_MODULES: Record<string, CalldataModule> = {}

/** A parsed, compiled policy: bigint ceilings resolved and calldata modules bound at load time. */
export type Policy = {
  version: number
  rules: CompiledRule[]
}

type CompiledRule = {
  name: string
  chainIds: number[]
  to: Address[]
  // Plain strings: lowercased at compile time and only ever used for `includes` membership.
  selectors: string[] | undefined
  maxValueWei: bigint
  maxFeePerGasWei: bigint
  maxGasLimit: bigint
  maxDataBytes: number | undefined
  calldata: { module: string; run: CalldataModule; config: unknown } | undefined
}

/** The result of evaluating a wire tx against a policy. `rule`/`check` name the winning/blocking rule. */
export type PolicyDecision =
  | { ok: true; rule: string }
  | { ok: false; rule?: string; check?: string; message: string }

/** Raised when a policy file is structurally invalid, has no rules, or names an unknown module. */
export class PolicyConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PolicyConfigError'
  }
}

const decimalString = z.string().regex(/^\d+$/, 'must be a decimal string')
const selectorString = z
  .string()
  .regex(/^0x[0-9a-fA-F]{8}$/, 'selector must be a 0x-prefixed 4-byte hex string')

const ruleSchema = z
  .object({
    name: z.string().min(1),
    chainIds: z.array(z.number().int().positive()).min(1),
    to: z.array(addressSchema).min(1),
    selectors: z.array(selectorString).min(1).optional(),
    maxValueWei: decimalString.default('0'),
    maxFeePerGasWei: decimalString,
    maxGasLimit: decimalString,
    maxDataBytes: z.number().int().nonnegative().optional(),
    calldata: z
      .object({ module: z.string().min(1), config: z.unknown() })
      .strict()
      .optional()
  })
  .strict()

const policySchema = z
  .object({
    version: z.literal(POLICY_VERSION),
    rules: z.array(ruleSchema).min(1, 'policy must define at least one rule')
  })
  .strict()

type RawRule = z.infer<typeof ruleSchema>

function compileRule(rule: RawRule): CompiledRule {
  let calldata: CompiledRule['calldata']
  if (rule.calldata) {
    const run = CALLDATA_MODULES[rule.calldata.module]
    if (!run) throw new PolicyConfigError(`unknown calldata module '${rule.calldata.module}'`)
    calldata = { module: rule.calldata.module, run, config: run.parseConfig(rule.calldata.config) }
  }
  return {
    name: rule.name,
    chainIds: rule.chainIds,
    to: rule.to,
    selectors: rule.selectors?.map(s => s.toLowerCase()),
    maxValueWei: BigInt(rule.maxValueWei),
    maxFeePerGasWei: BigInt(rule.maxFeePerGasWei),
    maxGasLimit: BigInt(rule.maxGasLimit),
    maxDataBytes: rule.maxDataBytes,
    calldata
  }
}

/**
 * Parses and compiles a raw policy object. Throws {@link PolicyConfigError} on any schema violation,
 * empty rule set, unknown calldata module, or a module's `parseConfig` rejection. Calldata module
 * configs are validated here (startup), never per request.
 */
export function parsePolicy(raw: unknown): Policy {
  const parsed = policySchema.safeParse(raw)
  if (!parsed.success) {
    throw new PolicyConfigError(
      `invalid policy: ${parsed.error.issues.map(i => i.message).join('; ')}`
    )
  }
  try {
    return { version: parsed.data.version, rules: parsed.data.rules.map(compileRule) }
  } catch (error) {
    if (error instanceof PolicyConfigError) throw error
    throw new PolicyConfigError(
      `calldata module config rejected: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function decodeTx(tx: WireTx): DecodedTx {
  return {
    chainId: tx.chainId,
    to: tx.to,
    data: tx.data,
    value: BigInt(tx.value),
    nonce: tx.nonce,
    gas: BigInt(tx.gas),
    maxFeePerGas: BigInt(tx.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas)
  }
}

type RuleResult = { ok: true } | { ok: false; check: string; clause: string }

// Cheap-first: reject on the least-work check that fails so a caller sees the most fundamental
// mismatch. Order per the plan: chainId → to → value → maxFeePerGas → gas → maxDataBytes →
// selectors → calldata module.
function evaluateRule(rule: CompiledRule, tx: DecodedTx): RuleResult {
  const fail = (check: string, detail: string): RuleResult => ({
    ok: false,
    check,
    clause: `rule '${rule.name}': ${check} ${detail}`
  })

  if (!rule.chainIds.includes(tx.chainId)) {
    return fail('chainId', `${tx.chainId} not in [${rule.chainIds.join(', ')}]`)
  }
  if (!rule.to.some(allowed => isAddressEqual(allowed, tx.to))) {
    return fail('to', `${tx.to} not allowlisted`)
  }
  if (tx.value > rule.maxValueWei) {
    return fail('value', `${tx.value} exceeds ${rule.maxValueWei}`)
  }
  if (tx.maxFeePerGas > rule.maxFeePerGasWei) {
    return fail('maxFeePerGas', `${tx.maxFeePerGas} exceeds ${rule.maxFeePerGasWei}`)
  }
  if (tx.gas > rule.maxGasLimit) {
    return fail('gas', `${tx.gas} exceeds ${rule.maxGasLimit}`)
  }
  if (rule.maxDataBytes !== undefined) {
    const dataBytes = (tx.data.length - 2) / 2
    if (dataBytes > rule.maxDataBytes) {
      return fail('maxDataBytes', `${dataBytes} exceeds ${rule.maxDataBytes}`)
    }
  }
  if (rule.selectors) {
    const selector = tx.data.slice(0, 10).toLowerCase()
    if (tx.data.length < 10 || !rule.selectors.includes(selector)) {
      return fail('selectors', `${selector} not allowlisted`)
    }
  }
  if (rule.calldata) {
    const result = rule.calldata.run.check(tx, rule.calldata.config)
    if (!result.ok) return fail('calldata', result.reason)
  }
  return { ok: true }
}

/**
 * Default-deny evaluation: signs iff at least one rule passes ALL its checks (file order, first
 * match wins). On rejection the returned `message` aggregates one clause per rule, and `rule`/`check`
 * name the first rule's blocking check. Stateless per request — same-nonce RBF re-signs pass freely.
 */
export function evaluatePolicy(policy: Policy, wireTx: WireTx): PolicyDecision {
  const tx = decodeTx(wireTx)
  const clauses: string[] = []
  let headline: { rule: string; check: string } | undefined
  for (const rule of policy.rules) {
    const result = evaluateRule(rule, tx)
    if (result.ok) return { ok: true, rule: rule.name }
    clauses.push(result.clause)
    headline ??= { rule: rule.name, check: result.check }
  }
  return {
    ok: false,
    rule: headline?.rule,
    check: headline?.check,
    message: clauses.length > 0 ? clauses.join('; ') : 'no rules configured (default deny)'
  }
}
