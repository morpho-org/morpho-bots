import type { Address, Hex } from 'viem'

import { bytesToHex, getAddress, hexToBytes, isAddress, isHex, size } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { BootstrapConfig } from '../domain/bootstrap/position-bootstrap'
import type { LadderConfig } from '../domain/ladder/ladder'

import { BootstrapConfigurationError } from '../domain/bootstrap/bootstrap-configuration.error'
import { validateBootstrapConfig } from '../domain/bootstrap/position-bootstrap'
import { validateLadderConfig } from '../domain/ladder/ladder'
import { LadderConfigurationError } from '../domain/ladder/ladder-configuration.error'
import { ConfigValidationError } from './config-validation.error'

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

/** Validated write-mode signer source without the configured maker address. */
type MakerSigner =
  | { method: 'private-key'; privateKey: Hex }
  | { method: 'keystore'; path: string; password: string }
  | { method: 'aws'; keyId: string; region: string }

/** Selects and validates exactly one local, keystore, or AWS KMS signing source. */
export const makerSignerValue = (environment: Environment): MakerSigner => {
  const declared = environment.KEY_STORAGE_METHOD?.trim()
  if (declared && !['private-key', 'keystore', 'aws'].includes(declared)) {
    throw new ConfigValidationError(
      'KEY_STORAGE_METHOD',
      'unsupported',
      'KEY_STORAGE_METHOD must be private-key, keystore, or aws'
    )
  }
  const selected = [
    environment.MAKER_PRIVATE_KEY?.trim() ? 'private-key' : undefined,
    environment.KEYSTORE_PATH?.trim() ? 'keystore' : undefined,
    environment.AWS_KMS_KEY_ID?.trim() ? 'aws' : undefined
  ].filter((value): value is MakerSigner['method'] => value !== undefined)
  if (selected.length > 1 || (declared && selected.some(value => value !== declared))) {
    throw new ConfigValidationError(
      'KEY_STORAGE_METHOD',
      'conflicting-sources',
      'Exactly one maker key storage method must be configured'
    )
  }
  const method = (declared ?? selected[0]) as MakerSigner['method'] | undefined
  if (!method) {
    throw new ConfigValidationError(
      'MAKER_PRIVATE_KEY',
      'missing',
      'Missing required env var: MAKER_PRIVATE_KEY'
    )
  }
  if (method === 'private-key') {
    if (
      environment.KEYSTORE_PATH?.trim() ||
      environment.KEYSTORE_PASSWORD?.trim() ||
      environment.KEYSTORE_INTERACTIVE?.trim() === 'true' ||
      environment.AWS_KMS_KEY_ID?.trim() ||
      environment.AWS_REGION?.trim()
    ) {
      throw new ConfigValidationError(
        'KEY_STORAGE_METHOD',
        'conflicting-sources',
        'Exactly one maker key storage method must be configured'
      )
    }
    return { method, privateKey: privateKeyValue(environment) }
  }
  if (method === 'keystore') {
    if (environment.AWS_KMS_KEY_ID?.trim() || environment.AWS_REGION?.trim()) {
      throw new ConfigValidationError(
        'KEY_STORAGE_METHOD',
        'conflicting-sources',
        'Exactly one maker key storage method must be configured'
      )
    }
    const password = environment.KEYSTORE_PASSWORD?.trim()
    const interactive = environment.KEYSTORE_INTERACTIVE?.trim()
    if (interactive !== undefined && interactive !== 'true' && interactive !== 'false') {
      throw new ConfigValidationError(
        'KEYSTORE_INTERACTIVE',
        'invalid-boolean',
        'KEYSTORE_INTERACTIVE must be true or false'
      )
    }
    if ((password ? 1 : 0) + (interactive === 'true' ? 1 : 0) !== 1) {
      throw new ConfigValidationError(
        'KEYSTORE_PASSWORD',
        'password-mode',
        'Keystore signing requires exactly one of a password or interactive prompt'
      )
    }
    if (!password) {
      throw new ConfigValidationError(
        'KEYSTORE_PASSWORD',
        'interactive-unresolved',
        'Interactive keystore password was not provided'
      )
    }
    return { method, path: requiredValue(environment, 'KEYSTORE_PATH'), password }
  }
  if (
    environment.KEYSTORE_PATH?.trim() ||
    environment.KEYSTORE_PASSWORD?.trim() ||
    environment.KEYSTORE_INTERACTIVE?.trim() === 'true'
  ) {
    throw new ConfigValidationError(
      'KEY_STORAGE_METHOD',
      'conflicting-sources',
      'Exactly one maker key storage method must be configured'
    )
  }
  return {
    method,
    keyId: requiredValue(environment, 'AWS_KMS_KEY_ID'),
    region: requiredValue(environment, 'AWS_REGION')
  }
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
 * Validates an exact bytes32 value with viem strict hex and byte-size utilities.
 * @param value - Untrusted hex string.
 * @param name - Field name used in validation errors.
 * @returns The narrowed 32-byte hex value.
 * @throws When the value is malformed, non-prefixed, or not exactly 32 bytes.
 */
export const parseBytes32 = (value: string, name: string): Hex => {
  if (!isHex(value, { strict: true }) || size(value) !== 32) {
    throw new ConfigValidationError(
      name,
      'invalid-bytes32',
      `${name} must be a 0x-prefixed 32-byte hex value`
    )
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
    throw new ConfigValidationError(
      name,
      'empty-list',
      `${name} must contain at least one market id`
    )
  }
  let normalized: Hex[]
  try {
    normalized = values.map(value => parseBytes32(value, name))
  } catch {
    throw new ConfigValidationError(
      name,
      'invalid-list-item',
      `${name} must contain 0x-prefixed 32-byte hex values`
    )
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new ConfigValidationError(name, 'duplicate', `${name} must not contain duplicates`)
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
  if (!URL.canParse(raw)) {
    throw new ConfigValidationError(name, 'invalid-url', `${name} must be a valid URL`)
  }
  return raw.endsWith('/') ? raw.slice(0, -1) : raw
}

const bootstrapFields = [
  'marketId',
  'creditTarget',
  'acceptanceAssets',
  'offerSize',
  'premiumBps',
  'maximumMarketExposure',
  'maximumTotalExposure',
  'minimumRateBps',
  'maximumRateBps',
  'autoRefill'
] as const

const bootstrapRecord = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigValidationError(field, 'wrong-type', `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

const integerBigInt = (value: unknown, field: string, signed: boolean) => {
  if (typeof value !== 'string') {
    throw new ConfigValidationError(field, 'invalid-integer', `${field} must be an integer`)
  }
  const syntax = signed ? /^-?\d+$/ : /^\d+$/
  if (!syntax.test(value)) {
    throw new ConfigValidationError(field, 'invalid-integer', `${field} must be an integer`)
  }
  return BigInt(value)
}

/**
 * Parses and validates the complete replacement list used by YAML or `BOOTSTRAP_MARKETS`.
 * @param value - Untrusted YAML/JSON bootstrap list.
 * @param allowlistedMarkets - Canonical market IDs permitted by the setup configuration.
 * @returns Ordered, exact bigint bootstrap settings accepted by domain validation.
 * @throws `ConfigValidationError` for wrong types, unsupported fields, duplicates, unsafe numbers,
 * non-allowlisted markets, or domain-invalid values.
 */
export const bootstrapConfigsValue = (
  value: unknown,
  allowlistedMarkets: readonly Hex[]
): BootstrapConfig[] => {
  if (!Array.isArray(value)) {
    throw new ConfigValidationError('bootstrap', 'wrong-type', 'bootstrap must be a list')
  }
  const configs = value.map((item, index) => {
    const prefix = `bootstrap[${index}]`
    const itemRecord = bootstrapRecord(item, prefix)
    if (Object.keys(itemRecord).some(key => !bootstrapFields.includes(key as never))) {
      throw new ConfigValidationError(
        prefix,
        'unknown-key',
        `${prefix} contains an unsupported key`
      )
    }
    const required = (name: (typeof bootstrapFields)[number]) => {
      if (itemRecord[name] === undefined) {
        throw new ConfigValidationError(
          `${prefix}.${name}`,
          'missing',
          `${prefix}.${name} is required`
        )
      }
      return itemRecord[name]
    }
    const marketValue = required('marketId')
    if (typeof marketValue !== 'string') {
      throw new ConfigValidationError(
        `${prefix}.marketId`,
        'wrong-type',
        `${prefix}.marketId must be a string`
      )
    }
    const config: BootstrapConfig = {
      marketId: parseBytes32(marketValue, `${prefix}.marketId`),
      creditTarget: integerBigInt(required('creditTarget'), `${prefix}.creditTarget`, false),
      acceptanceAssets: integerBigInt(
        required('acceptanceAssets'),
        `${prefix}.acceptanceAssets`,
        false
      ),
      offerSize: integerBigInt(required('offerSize'), `${prefix}.offerSize`, false),
      premiumBps: integerBigInt(required('premiumBps'), `${prefix}.premiumBps`, true),
      maximumMarketExposure: integerBigInt(
        required('maximumMarketExposure'),
        `${prefix}.maximumMarketExposure`,
        false
      ),
      maximumTotalExposure: integerBigInt(
        required('maximumTotalExposure'),
        `${prefix}.maximumTotalExposure`,
        false
      ),
      minimumRateBps: integerBigInt(required('minimumRateBps'), `${prefix}.minimumRateBps`, false),
      maximumRateBps: integerBigInt(required('maximumRateBps'), `${prefix}.maximumRateBps`, false),
      autoRefill: required('autoRefill') as boolean
    }
    if (typeof config.autoRefill !== 'boolean') {
      throw new ConfigValidationError(
        `${prefix}.autoRefill`,
        'wrong-type',
        `${prefix}.autoRefill must be a boolean`
      )
    }
    if (!allowlistedMarkets.includes(config.marketId)) {
      throw new ConfigValidationError(
        `${prefix}.marketId`,
        'not-allowlisted',
        `${prefix}.marketId must appear in markets.allowlist or MARKET_IDS`
      )
    }
    try {
      validateBootstrapConfig(config)
    } catch (error) {
      if (error instanceof BootstrapConfigurationError) {
        throw new ConfigValidationError(
          `${prefix}.${error.field}`,
          'invalid-bootstrap',
          `${prefix}.${error.field} ${error.reason}`
        )
      }
      throw error
    }
    return config
  })
  if (new Set(configs.map(config => config.marketId)).size !== configs.length) {
    throw new ConfigValidationError('bootstrap', 'duplicate', 'bootstrap market IDs must be unique')
  }
  return configs
}

const ladderFields = [
  'marketId',
  'quotePremiumBps',
  'spreadBps',
  'stepBps',
  'rungCount',
  'sizeSkewBps',
  'lowerRateBudgetAssets',
  'higherRateBudgetAssets',
  'targetMarketExposureAssets',
  'maximumTotalExposureAssets',
  'minimumOfferAssets',
  'groupMode',
  'loopIntervalSeconds',
  'movementToleranceBps',
  'minimumRateBps',
  'maximumRateBps'
] as const

const safeInteger = (value: unknown, field: string) => {
  const parsed = integerBigInt(value, field, false)
  const number = Number(parsed)
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new ConfigValidationError(
      field,
      'out-of-range',
      `${field} must be a positive safe integer`
    )
  }
  return number
}

/**
 * Parses and validates the complete replacement list used by YAML or `LADDER_MARKETS`.
 * @param value - Untrusted YAML/JSON ladder list.
 * @param allowlistedMarkets - Canonical market IDs permitted by setup configuration.
 * @returns Ordered, exact ladder settings accepted by domain preflight.
 * @throws ConfigValidationError for unsupported fields, malformed values, duplicates, or unsafe shape.
 */
export const ladderConfigsValue = (
  value: unknown,
  allowlistedMarkets: readonly Hex[]
): LadderConfig[] => {
  if (!Array.isArray(value)) {
    throw new ConfigValidationError('ladder', 'wrong-type', 'ladder must be a list')
  }
  const configs = value.map((item, index) => {
    const prefix = `ladder[${index}]`
    const itemRecord = bootstrapRecord(item, prefix)
    if (Object.keys(itemRecord).some(key => !ladderFields.includes(key as never))) {
      throw new ConfigValidationError(
        prefix,
        'unknown-key',
        `${prefix} contains an unsupported key`
      )
    }
    const required = (name: (typeof ladderFields)[number]) => {
      if (itemRecord[name] === undefined) {
        throw new ConfigValidationError(
          `${prefix}.${name}`,
          'missing',
          `${prefix}.${name} is required`
        )
      }
      return itemRecord[name]
    }
    const marketValue = required('marketId')
    const groupMode = required('groupMode')
    if (typeof marketValue !== 'string' || typeof groupMode !== 'string') {
      throw new ConfigValidationError(
        prefix,
        'wrong-type',
        `${prefix} string fields must be strings`
      )
    }
    const config: LadderConfig = {
      marketId: parseBytes32(marketValue, `${prefix}.marketId`),
      quotePremiumBps: integerBigInt(
        required('quotePremiumBps'),
        `${prefix}.quotePremiumBps`,
        true
      ),
      spreadBps: integerBigInt(required('spreadBps'), `${prefix}.spreadBps`, false),
      stepBps: integerBigInt(required('stepBps'), `${prefix}.stepBps`, false),
      rungCount: safeInteger(required('rungCount'), `${prefix}.rungCount`),
      sizeSkewBps: integerBigInt(required('sizeSkewBps'), `${prefix}.sizeSkewBps`, true),
      lowerRateBudgetAssets: integerBigInt(
        required('lowerRateBudgetAssets'),
        `${prefix}.lowerRateBudgetAssets`,
        false
      ),
      higherRateBudgetAssets: integerBigInt(
        required('higherRateBudgetAssets'),
        `${prefix}.higherRateBudgetAssets`,
        false
      ),
      targetMarketExposureAssets: integerBigInt(
        required('targetMarketExposureAssets'),
        `${prefix}.targetMarketExposureAssets`,
        false
      ),
      maximumTotalExposureAssets: integerBigInt(
        required('maximumTotalExposureAssets'),
        `${prefix}.maximumTotalExposureAssets`,
        false
      ),
      minimumOfferAssets: integerBigInt(
        required('minimumOfferAssets'),
        `${prefix}.minimumOfferAssets`,
        false
      ),
      groupMode: groupMode as LadderConfig['groupMode'],
      loopIntervalSeconds: safeInteger(
        required('loopIntervalSeconds'),
        `${prefix}.loopIntervalSeconds`
      ),
      movementToleranceBps: integerBigInt(
        required('movementToleranceBps'),
        `${prefix}.movementToleranceBps`,
        false
      ),
      minimumRateBps: integerBigInt(required('minimumRateBps'), `${prefix}.minimumRateBps`, false),
      maximumRateBps: integerBigInt(required('maximumRateBps'), `${prefix}.maximumRateBps`, false)
    }
    if (!allowlistedMarkets.includes(config.marketId)) {
      throw new ConfigValidationError(
        `${prefix}.marketId`,
        'not-allowlisted',
        `${prefix}.marketId must be allowlisted`
      )
    }
    try {
      validateLadderConfig(config)
    } catch (error) {
      if (error instanceof LadderConfigurationError) {
        throw new ConfigValidationError(
          `${prefix}.${error.field}`,
          'invalid-ladder',
          `${prefix}.${error.field} ${error.reason}`
        )
      }
      throw error
    }
    return config
  })
  if (new Set(configs.map(config => config.marketId)).size !== configs.length) {
    throw new ConfigValidationError('ladder', 'duplicate', 'ladder market IDs must be unique')
  }
  return configs
}
