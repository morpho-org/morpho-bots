import type { Address, Hex } from 'viem';
import { isAddressEqual } from 'viem';

/** The only Executor entrypoint the signer authorizes: exec_606BaXt(bytes[]). */
export const EXECUTOR_SELECTOR = '0x00000001';

/** Default gas-limit ceiling (matches the daemon-era signer policy default). */
export const DEFAULT_MAX_GAS_LIMIT = 15_000_000n;

/** Default calldata byte ceiling (matches the daemon-era signer policy default). */
export const DEFAULT_MAX_DATA_BYTES = 65_536;

/** One signer authorizes one Executor on one chain, under fixed fee/gas/size ceilings. */
export type Policy = {
  chainId: number;
  executor: Address;
  maxFeePerGasWei: bigint;
  maxGasLimit: bigint;
  maxDataBytes: number;
};

/** The prepared-transaction fields the pre-broadcast guard evaluates against a {@link Policy}. */
export type PolicyTx = {
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
};

export type PolicyCheck =
  | 'chainId'
  | 'executor'
  | 'value'
  | 'maxFeePerGas'
  | 'gas'
  | 'maxDataBytes'
  | 'selector';

export type PolicyDecision = { ok: true } | { ok: false; check: PolicyCheck; message: string };

/** Raised when a prepared transaction fails the default-deny policy — an upstream bug, never sent. */
export class PolicyViolationError extends Error {
  readonly code = 'policy_violation';

  constructor(
    message: string,
    readonly check: PolicyCheck
  ) {
    super(message);
    this.name = 'PolicyViolationError';
  }
}

/**
 * Default-deny authorization for a prepared transaction, with zero value and the `exec_606BaXt`
 * selector fixed as non-configurable invariants and the fee/gas/size ceilings taken from the
 * {@link Policy}. Every field must satisfy its rule; the first failure decides. In-process, this
 * runs between prepare and broadcast — the cheap defense-in-depth against an upstream encoding bug
 * ever sending value, hitting the wrong contract, or exceeding a ceiling.
 *
 * OUTER-ENVELOPE guard, by deliberate scope: it pins only the OUTER call — target is the Executor,
 * selector is `exec_606BaXt`, value is 0, and the fee/gas/size ceilings hold. It does NOT decode or
 * allowlist the inner `bytes[]` program the Executor executes; the integrity of those inner calls
 * rests elsewhere — venue response handling (including the 1inch router pin), quote validation, and
 * the mandatory pre-send simulation that reverts an unprofitable or malformed program before it can
 * be broadcast.
 */
export function evaluatePolicy(policy: Policy, tx: PolicyTx): PolicyDecision {
  const deny = (check: PolicyCheck, message: string): PolicyDecision => ({
    ok: false,
    check,
    message
  });
  if (tx.chainId !== policy.chainId) {
    return deny('chainId', `chainId ${tx.chainId} does not equal ${policy.chainId}`);
  }
  if (!isAddressEqual(tx.to, policy.executor)) {
    return deny('executor', `target ${tx.to} is not the configured Executor`);
  }
  if (tx.value !== 0n) {
    return deny('value', 'transaction value must be zero');
  }
  if (tx.maxFeePerGas > policy.maxFeePerGasWei) {
    return deny('maxFeePerGas', `maxFeePerGas ${tx.maxFeePerGas} exceeds policy ceiling`);
  }
  if (tx.gas > policy.maxGasLimit) {
    return deny('gas', `gas ${tx.gas} exceeds policy ceiling`);
  }
  const dataBytes = (tx.data.length - 2) / 2;
  if (dataBytes > policy.maxDataBytes) {
    return deny('maxDataBytes', `calldata size ${dataBytes} exceeds policy ceiling`);
  }
  if (tx.data.slice(0, 10).toLowerCase() !== EXECUTOR_SELECTOR) {
    return deny('selector', `calldata must call Executor selector ${EXECUTOR_SELECTOR}`);
  }
  return { ok: true };
}
