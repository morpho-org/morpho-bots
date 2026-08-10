import type { Address, Hex } from 'viem'

import { getAddress, isAddress, isHex, size } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { ConfigValidationError } from './config-validation.error'
import {
  bootstrapConfigsValue,
  hexListValue,
  ladderConfigsValue,
  parseBytes32
} from './market-collections'

export {
  bootstrapConfigsValue,
  hexListValue,
  ladderConfigsValue,
  parseBytes32
} from './market-collections'

/** String-valued runtime environment boundary accepted by configuration parsing. */
export type Environment = Record<string, string | undefined>

/** Base mainnet chain ID — the only chain the market-making bot supports. */
export const BASE_CHAIN_ID = 8453

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const MAXIMUM_REQUEST_TIMEOUT_MS = 120_000
const DEFAULT_TRANSACTION_RECEIPT_TIMEOUT_MS = 180_000
const MAXIMUM_TRANSACTION_RECEIPT_TIMEOUT_MS = 900_000

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
 * Parses the only supported chain from trimmed unsigned decimal notation.
 * @param environment - Environment map containing the required chain identifier.
 * @returns The supported chain identifier.
 * @throws When CHAIN_ID is absent, malformed, unsafe, or unsupported.
 */
export const chainIdValue = (environment: Environment) => {
  const raw = requiredValue(environment, 'CHAIN_ID')
  const chainId = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(chainId) || chainId !== BASE_CHAIN_ID) {
    throw new ConfigValidationError(
      'CHAIN_ID',
      'unsupported-chain',
      `Unsupported CHAIN_ID; supported: ${BASE_CHAIN_ID}`
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
