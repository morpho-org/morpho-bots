import type { Address, Hex } from 'viem'

import { getAddress, isAddress, isHex, parseGwei, size } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { MAX_LOSS_FACTOR } from '../domain/loss-factor'
import { ConfigValidationError } from './config-validation.error'
import {
  bootstrapConfigsValue,
  hexListValue,
  ladderConfigsValue,
  parseBytes32
} from './market-collections'
import {
  isSupportedChainId,
  SUPPORTED_CHAIN_IDS,
  type SupportedChainId
} from './supported-chains.utils'

export {
  bootstrapConfigsValue,
  hexListValue,
  ladderConfigsValue,
  parseBytes32
} from './market-collections'

/** String-valued runtime environment boundary accepted by configuration parsing. */
export type Environment = Record<string, string | undefined>

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const MAXIMUM_REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_TRANSACTION_RECEIPT_TIMEOUT_MS = 180_000
const MAXIMUM_TRANSACTION_RECEIPT_TIMEOUT_MS = 900_000
const DEFAULT_REFERENCE_LOOKBACK_SECONDS = 259_200n
const MINIMUM_REFERENCE_LOOKBACK_SECONDS = 3_600n
const MAXIMUM_REFERENCE_LOOKBACK_SECONDS = 2_592_000n

/**
 * Reads one required trimmed environment value.
 * @param environment - Environment map to inspect.
 * @param name - Required variable name.
 * @returns The non-empty trimmed value.
 * @throws When the variable is absent or empty.
 */
const requiredValue = (environment: Environment, name: string) => {
  const value = environment[name]?.trim()
  if (!value) throw new ConfigValidationError(name, 'missing', `Missing required env var: ${name}`)
  return value
}

/**
 * Parses a supported chain from trimmed unsigned decimal notation.
 * @param environment - Environment map containing the required chain identifier.
 * @returns The supported chain identifier, narrowed to a chain the bot can serve.
 * @throws When CHAIN_ID is absent, malformed, unsafe, or names an unsupported chain.
 */
export const chainIdValue = (environment: Environment): SupportedChainId => {
  const raw = requiredValue(environment, 'CHAIN_ID')
  const chainId = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(chainId) || !isSupportedChainId(chainId)) {
    throw new ConfigValidationError(
      'CHAIN_ID',
      'unsupported-chain',
      `Unsupported CHAIN_ID; supported: ${SUPPORTED_CHAIN_IDS.join(', ')}`
    )
  }
  return chainId
}

/**
 * Validates and checksum-normalizes one EVM address with viem.
 * @param value - Untrusted address string.
 * @param name - Field name used in validation errors.
 * @returns The EIP-55 checksum-normalized address.
 * @throws When viem rejects the address, including invalid mixed-case checksums.
 */
export const parseAddress = (value: string, name: string): Address => {
  if (!isAddress(value, { strict: false })) {
    throw new ConfigValidationError(name, 'invalid-address', `${name} must be an EVM address`)
  }
  return getAddress(value)
}

/**
 * Reads and normalizes one required EVM address.
 * @param environment - Environment map to inspect.
 * @param name - Required address variable name.
 * @returns The EIP-55 checksum-normalized address.
 * @throws When the variable is missing or viem rejects its address syntax/checksum.
 */
export const addressValue = (environment: Environment, name: string) =>
  parseAddress(requiredValue(environment, name), name)

/**
 * Reads and validates the maker signing key for write-enabled operation.
 * @param environment - Environment map to inspect.
 * @returns A usable secp256k1 private key narrowed to strict hex.
 * @throws `ConfigValidationError` when the key is missing, not bytes32, or not a usable scalar.
 * @remarks Read-only mode must not call this utility, so it never requests or retains a key.
 */
export const privateKeyValue = (environment: Environment): Hex => {
  const privateKey = requiredValue(environment, 'MAKER_PRIVATE_KEY')
  if (!isHex(privateKey, { strict: true }) || size(privateKey) !== 32) {
    throw new ConfigValidationError(
      'MAKER_PRIVATE_KEY',
      'invalid-bytes32',
      'MAKER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string'
    )
  }
  try {
    privateKeyToAccount(privateKey)
  } catch {
    throw new ConfigValidationError(
      'MAKER_PRIVATE_KEY',
      'invalid-private-key',
      'MAKER_PRIVATE_KEY must be a valid secp256k1 private key'
    )
  }
  return privateKey
}

/**
 * Reads an unsigned base-10 integer as bigint.
 * @param environment - Environment map to inspect.
 * @param name - Required integer variable name.
 * @returns The exact non-negative bigint value.
 * @throws When the value is absent or is not unsigned decimal notation.
 */
export const unsignedBigIntValue = (environment: Environment, name: string) => {
  const value = requiredValue(environment, name)
  // Viem conversion helpers cover hex values; no viem API validates unsigned decimal env syntax.
  if (!/^\d+$/.test(value)) {
    throw new ConfigValidationError(
      name,
      'invalid-unsigned-integer',
      `${name} must be an unsigned decimal integer`
    )
  }
  return BigInt(value)
}

/**
 * Reads a required positive base-10 integer as bigint.
 * @param environment - Environment map to inspect.
 * @param name - Required integer variable name.
 * @returns The exact positive bigint value.
 * @throws When the value is absent, invalid, or zero.
 */
export const positiveBigIntValue = (environment: Environment, name: string) => {
  const value = unsignedBigIntValue(environment, name)
  if (value === 0n) {
    throw new ConfigValidationError(name, 'out-of-range', `${name} must be greater than zero`)
  }
  return value
}

/**
 * Reads a required positive safe integer.
 * @param environment - Environment map to inspect.
 * @param name - Required integer variable name.
 * @returns The positive safe integer value.
 * @throws When the value is absent, invalid, zero, or outside the safe-integer range.
 */
export const positiveIntegerValue = (environment: Environment, name: string) => {
  const value = positiveBigIntValue(environment, name)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConfigValidationError(name, 'out-of-range', `${name} must be a positive safe integer`)
  }
  return Number(value)
}

/**
 * Reads a required positive gwei fee bound and converts it to wei exactly.
 * @param environment - Environment map to inspect.
 * @param name - Required gwei variable name.
 * @returns The bound in wei, at least 1.
 * @throws When the value is absent, is not plain decimal notation, carries more than nine fractional
 * digits, or is non-positive.
 * @remarks Fee bounds are decimal because chains differ by orders of magnitude: a Base tip is
 * nominal (~0.005 gwei) where mainnet's is a real market. The regex screens the value ahead of
 * `parseGwei`, which throws its own untyped error on exponent notation and silently ROUNDS anything
 * finer than a wei — rounding a ceiling upward past the bound its operator declared.
 */
export const positiveGweiWeiValue = (environment: Environment, name: string) => {
  const value = requiredValue(environment, name)
  if (!/^\d+(\.\d{1,9})?$/.test(value)) {
    throw new ConfigValidationError(
      name,
      'invalid-decimal',
      `${name} must be a positive decimal number of gwei, with at most nine decimal places (1 wei)`
    )
  }
  const wei = parseGwei(value)
  if (wei <= 0n) {
    throw new ConfigValidationError(name, 'out-of-range', `${name} must be at least 1 wei`)
  }
  return wei
}

const boundedTimeoutValue = (
  environment: Environment,
  options: { name: string; defaultMs: number; maximumMs: number }
) => {
  const raw = environment[options.name]?.trim() ?? String(options.defaultMs)
  if (!/^\d+$/.test(raw)) {
    throw new ConfigValidationError(
      options.name,
      'invalid-integer',
      `${options.name} must be a decimal integer`
    )
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > options.maximumMs) {
    throw new ConfigValidationError(
      options.name,
      'out-of-range',
      `${options.name} must be between 1 and ${options.maximumMs}`
    )
  }
  return value
}

/**
 * Reads the bounded aggregate provider timeout.
 * @param environment - Environment map to inspect.
 * @returns A timeout from 1 through 120,000 milliseconds.
 * @throws When the trimmed value is not decimal digits or is outside the supported safe-integer range.
 */
export const requestTimeoutValue = (environment: Environment) =>
  boundedTimeoutValue(environment, {
    name: 'REQUEST_TIMEOUT_MS',
    defaultMs: DEFAULT_REQUEST_TIMEOUT_MS,
    maximumMs: MAXIMUM_REQUEST_TIMEOUT_MS
  })

/**
 * Reads the transaction-confirmation timeout independently from provider request deadlines.
 * @param environment - Environment map to inspect.
 * @returns A receipt timeout from 1 through 900,000 milliseconds, defaulting to 180,000.
 * @throws `ConfigValidationError` when the value is not decimal digits or is outside the supported
 * range.
 * @remarks This longer deadline starts only after a transaction hash has been returned; it does not
 * change JSON-RPC request, fetch, or aggregate pagination deadlines.
 */
export const transactionReceiptTimeoutValue = (environment: Environment) =>
  boundedTimeoutValue(environment, {
    name: 'TRANSACTION_RECEIPT_TIMEOUT_MS',
    defaultMs: DEFAULT_TRANSACTION_RECEIPT_TIMEOUT_MS,
    maximumMs: MAXIMUM_TRANSACTION_RECEIPT_TIMEOUT_MS
  })

/**
 * Reads the window the `variable_rate_avg` strategy averages the Blue reference market over.
 * @param environment - Environment map to inspect.
 * @returns The window in seconds, defaulting to three days.
 * @throws `ConfigValidationError` when the value is not decimal digits or falls outside one hour
 * through thirty days.
 * @remarks Widening the window trades responsiveness for immunity to transient spikes in the
 * reference market, which can walk the ladder into the resting book. The floor is the hourly
 * reference refresh cadence, below which a wider average carries no additional observation; the
 * ceiling keeps the historical checkpoint inside plausible reference-market and archive history,
 * so an overlong window fails here rather than as an opaque reference-checkpoint failure later.
 */
export const referenceLookbackSecondsValue = (environment: Environment) => {
  const raw = environment.REFERENCE_LOOKBACK_SECONDS?.trim()
  if (raw === undefined || raw === '') return DEFAULT_REFERENCE_LOOKBACK_SECONDS
  if (!/^\d+$/.test(raw)) {
    throw new ConfigValidationError(
      'REFERENCE_LOOKBACK_SECONDS',
      'invalid-integer',
      'REFERENCE_LOOKBACK_SECONDS must be a decimal integer'
    )
  }
  const value = BigInt(raw)
  if (value < MINIMUM_REFERENCE_LOOKBACK_SECONDS || value > MAXIMUM_REFERENCE_LOOKBACK_SECONDS) {
    throw new ConfigValidationError(
      'REFERENCE_LOOKBACK_SECONDS',
      'out-of-range',
      `REFERENCE_LOOKBACK_SECONDS must be between ${MINIMUM_REFERENCE_LOOKBACK_SECONDS} and ${MAXIMUM_REFERENCE_LOOKBACK_SECONDS}`
    )
  }
  return value
}

/**
 * Parses an optional bytes32 variable when present.
 * @param environment - Environment map to inspect.
 * @param name - Optional bytes32 variable name.
 * @returns The validated 32-byte hex value, or `undefined` when absent.
 */
export const optionalBytes32Value = (environment: Environment, name: string) => {
  const value = environment[name]?.trim()
  return value ? parseBytes32(value, name) : undefined
}

/**
 * Reads one provider URL and removes a single trailing slash.
 * @param environment - Environment map to inspect.
 * @param name - Required URL variable name.
 * @returns A normalized URL string.
 * @throws When the URL is absent or cannot be parsed.
 */
export const urlValue = (environment: Environment, name: string) => {
  const raw = requiredValue(environment, name)
  if (!URL.canParse(raw)) {
    throw new ConfigValidationError(name, 'invalid-url', `${name} must be a valid URL`)
  }
  return raw.endsWith('/') ? raw.slice(0, -1) : raw
}

/**
 * Parses and normalizes an optional provider URL when present.
 * @param environment - Environment map to inspect.
 * @param name - Optional URL variable name.
 * @returns A normalized URL, or `undefined` when absent.
 */
export const optionalUrlValue = (environment: Environment, name: string) => {
  const value = environment[name]?.trim()
  if (!value) return undefined
  if (!URL.canParse(value)) {
    throw new ConfigValidationError(name, 'invalid-url', `${name} must be a valid URL`)
  }
  return value.endsWith('/') ? value.slice(0, -1) : value
}

const ACCEPTED_LOSS_FACTOR_FIELD = 'markets.acceptedLossFactor'

/**
 * Validates the operator-accepted loss factor of each allowlisted market.
 * @param input - Raw `markets.acceptedLossFactor` mapping or `ACCEPTED_LOSS_FACTOR` object.
 * @param marketIds - Validated market allowlist.
 * @returns Canonical market id to accepted value; omitted markets are absent and accept `0`.
 * @throws `ConfigValidationError` for a non-mapping, an unknown or duplicate market, a value that is
 * not a canonical unsigned decimal string, or a value at or above `MAX_LOSS_FACTOR`, which would
 * accept a maxed-out market and so disable the guard.
 */
export const acceptedLossFactorValue = (
  input: unknown,
  marketIds: readonly Hex[]
): ReadonlyMap<Hex, bigint> => {
  const accepted = new Map<Hex, bigint>()
  if (input === undefined) return accepted
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ConfigValidationError(
      ACCEPTED_LOSS_FACTOR_FIELD,
      'wrong-type',
      `${ACCEPTED_LOSS_FACTOR_FIELD} must map market ids to decimal strings`
    )
  }
  const allowlisted = new Set(marketIds)
  for (const [key, value] of Object.entries(input)) {
    const marketId = parseBytes32(key, ACCEPTED_LOSS_FACTOR_FIELD)
    if (!allowlisted.has(marketId)) {
      throw new ConfigValidationError(
        ACCEPTED_LOSS_FACTOR_FIELD,
        'unknown-market',
        `${ACCEPTED_LOSS_FACTOR_FIELD} must only name markets in markets.allowlist`
      )
    }
    if (accepted.has(marketId)) {
      throw new ConfigValidationError(
        ACCEPTED_LOSS_FACTOR_FIELD,
        'duplicate',
        `${ACCEPTED_LOSS_FACTOR_FIELD} must not repeat a market id`
      )
    }
    if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
      throw new ConfigValidationError(
        ACCEPTED_LOSS_FACTOR_FIELD,
        'invalid-unsigned-integer',
        `${ACCEPTED_LOSS_FACTOR_FIELD} values must be canonical unsigned decimal strings`
      )
    }
    const lossFactor = BigInt(value)
    if (lossFactor >= MAX_LOSS_FACTOR) {
      throw new ConfigValidationError(
        ACCEPTED_LOSS_FACTOR_FIELD,
        'out-of-range',
        `${ACCEPTED_LOSS_FACTOR_FIELD} values must be below type(uint128).max`
      )
    }
    accepted.set(marketId, lossFactor)
  }
  return accepted
}
