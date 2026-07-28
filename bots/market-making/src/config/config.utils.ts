import type { Address, Hex } from 'viem'

import { bytesToHex, getAddress, hexToBytes, isAddress, isHex, size } from 'viem'

/** String-valued runtime environment boundary accepted by configuration parsing. */
export type Environment = Record<string, string | undefined>

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const MAXIMUM_REQUEST_TIMEOUT_MS = 120_000

/**
 * Reads one required trimmed environment value.
 * @param environment - Environment map to inspect.
 * @param name - Required variable name.
 * @returns The non-empty trimmed value.
 * @throws When the variable is absent or empty.
 */
export const requiredValue = (environment: Environment, name: string) => {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

/**
 * Validates and checksum-normalizes one EVM address with viem.
 * @param value - Untrusted address string.
 * @param name - Field name used in validation errors.
 * @returns The EIP-55 checksum-normalized address.
 * @throws When viem rejects the address, including invalid mixed-case checksums.
 */
export const parseAddress = (value: string, name: string): Address => {
  if (!isAddress(value, { strict: false })) throw new Error(`${name} must be an EVM address`)
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
 * Reads an unsigned base-10 integer as bigint.
 * @param environment - Environment map to inspect.
 * @param name - Required integer variable name.
 * @returns The exact non-negative bigint value.
 * @throws When the value is absent or is not unsigned decimal notation.
 */
export const unsignedBigIntValue = (environment: Environment, name: string) => {
  const value = requiredValue(environment, name)
  // Viem conversion helpers cover hex values; no viem API validates unsigned decimal env syntax.
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an unsigned decimal integer`)
  return BigInt(value)
}

/**
 * Reads the bounded aggregate provider timeout.
 * @param environment - Environment map to inspect.
 * @returns A timeout from 1 through 120,000 milliseconds.
 * @throws When the value is not a safe integer in the supported range.
 */
export const requestTimeoutValue = (environment: Environment) => {
  const raw = environment.REQUEST_TIMEOUT_MS?.trim() ?? String(DEFAULT_REQUEST_TIMEOUT_MS)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_REQUEST_TIMEOUT_MS) {
    throw new Error(`REQUEST_TIMEOUT_MS must be between 1 and ${MAXIMUM_REQUEST_TIMEOUT_MS}`)
  }
  return value
}

/**
 * Validates an exact bytes32 value with viem strict hex and byte-size utilities.
 * @param value - Untrusted hex string.
 * @param name - Field name used in validation errors.
 * @returns The narrowed 32-byte hex value.
 * @throws When the value is malformed, non-prefixed, or not exactly 32 bytes.
 */
export const parseBytes32 = (value: string, name: string): Hex => {
  if (!isHex(value, { strict: true }) || size(value) !== 32) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte hex value`)
  }
  return bytesToHex(hexToBytes(value))
}

/**
 * Reads a comma-delimited list of unique bytes32 values.
 * @param environment - Environment map to inspect.
 * @param name - List variable name.
 * @param requiredList - Whether at least one item is required.
 * @returns Validated unique values in input order.
 * @throws When required input is empty, any item is not bytes32, or duplicates exist.
 */
export const hexListValue = (
  environment: Environment,
  name: string,
  requiredList: boolean
): Hex[] => {
  const raw = requiredList ? requiredValue(environment, name) : (environment[name]?.trim() ?? '')
  const values = raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  if (requiredList && values.length === 0) {
    throw new Error(`${name} must contain at least one market id`)
  }
  let normalized: Hex[]
  try {
    normalized = values.map(value => parseBytes32(value, name))
  } catch {
    throw new Error(`${name} must contain 0x-prefixed 32-byte hex values`)
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${name} must not contain duplicates`)
  }
  return normalized
}

/**
 * Reads and validates one required bytes32 value.
 * @param environment - Environment map to inspect.
 * @param name - Required bytes32 variable name.
 * @returns The validated 32-byte hex value.
 * @throws When missing or rejected by strict viem hex/size validation.
 */
export const bytes32Value = (environment: Environment, name: string) =>
  parseBytes32(requiredValue(environment, name), name)

/**
 * Reads one provider URL and removes a single trailing slash.
 * @param environment - Environment map to inspect.
 * @param name - Required URL variable name.
 * @returns A normalized URL string.
 * @throws When the URL is absent or cannot be parsed.
 */
export const urlValue = (environment: Environment, name: string) => {
  const raw = requiredValue(environment, name)
  if (!URL.canParse(raw)) throw new Error(`${name} must be a valid URL`)
  return raw.endsWith('/') ? raw.slice(0, -1) : raw
}
