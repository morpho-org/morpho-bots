import { parseHttpHeartbeatUrl } from '@repo/bot-kit/heartbeat-url'
import { classifyShippingConfig } from '@repo/bot-kit/shipping-config'
import { base } from 'viem/chains'

import { ConfigValidationError } from '../src/config/config-validation.error'
import {
  addressValue,
  bootstrapConfigsValue,
  bytes32Value,
  chainIdValue,
  hexListValue,
  ladderConfigsValue,
  privateKeyValue,
  requestTimeoutValue,
  transactionReceiptTimeoutValue,
  unsignedBigIntValue,
  urlValue
} from '../src/config/config.utils'
import { generateLadder, offerMaxAssetsByRung } from '../src/domain/ladder/ladder'

export const BOT_ENVIRONMENT_KEYS = [
  'CHAIN_ID',
  'RPC_URL',
  'REFERENCE_RPC_URL',
  'MAKER_PRIVATE_KEY',
  'MAKER_ADDRESS',
  'MIDNIGHT_ADDRESS',
  'LOAN_ASSET_ADDRESS',
  'RATIFIER_ADDRESS',
  'MARKET_IDS',
  'REFERENCE_MARKET_ID',
  'NATIVE_RESERVE_WEI',
  'MAXIMUM_LEND_EXPOSURE_ASSETS',
  'MORPHO_API_BASE_URL',
  'ROUTER_API_BASE_URL',
  'V0_OFFER_GROUP_IDS',
  'REQUEST_TIMEOUT_MS',
  'TRANSACTION_RECEIPT_TIMEOUT_MS',
  'BETTERSTACK_SOURCE_TOKEN',
  'BETTERSTACK_INGESTING_HOST',
  'BETTERSTACK_HEARTBEAT_URL',
  'BOOTSTRAP_MARKETS',
  'LADDER_MARKETS'
] as const

export const SENSITIVE_UI_KEYS = [
  'MAKER_PRIVATE_KEY',
  'BETTERSTACK_SOURCE_TOKEN',
  'RPC_URL',
  'REFERENCE_RPC_URL',
  'BETTERSTACK_HEARTBEAT_URL'
] as const

export const SCALAR_FIELDS = [
  ['CHAIN_ID', 'Chain ID', 'Base only (8453)', 'number'],
  ['RPC_URL', 'Current-state RPC URL', 'Base JSON-RPC endpoint', 'password'],
  ['REFERENCE_RPC_URL', 'Archive RPC URL', 'Historical reference reads', 'password'],
  ['MAKER_PRIVATE_KEY', 'Maker private key', 'Prefer environment secrets', 'password'],
  ['MAKER_ADDRESS', 'Maker address', 'Balance, allowance, offers, and exposure owner', 'text'],
  ['MIDNIGHT_ADDRESS', 'Midnight address', 'Expected singleton contract', 'text'],
  ['LOAN_ASSET_ADDRESS', 'Loan asset address', 'Asset used by every configured market', 'text'],
  ['RATIFIER_ADDRESS', 'Ratifier address', 'Router-listed Ecrecover ratifier', 'text'],
  ['MARKET_IDS', 'Market IDs', 'Comma-separated bytes32 allowlist', 'text'],
  ['REFERENCE_MARKET_ID', 'Reference market ID', 'Morpho Blue variable-rate market', 'text'],
  ['NATIVE_RESERVE_WEI', 'Native reserve (wei)', 'Non-negative gas reserve', 'number'],
  [
    'MAXIMUM_LEND_EXPOSURE_ASSETS',
    'Maximum lend exposure',
    'Non-negative allowance floor',
    'number'
  ],
  ['MORPHO_API_BASE_URL', 'Morpho API base URL', 'Books and maker offer groups', 'url'],
  ['ROUTER_API_BASE_URL', 'Router API base URL', 'Ratifier registry', 'url'],
  ['V0_OFFER_GROUP_IDS', 'V0 offer group IDs', 'Optional comma-separated IDs', 'text'],
  ['REQUEST_TIMEOUT_MS', 'Request timeout (ms)', '1–120000', 'number'],
  ['TRANSACTION_RECEIPT_TIMEOUT_MS', 'Receipt timeout (ms)', '1–900000', 'number']
] as const

export const BOOTSTRAP_FIELDS = [
  ['marketId', 'Market ID', 'Allowlisted bytes32 market', 'text'],
  ['creditTarget', 'Credit target', 'Positive raw credit units', 'number'],
  ['acceptanceAssets', 'Acceptance assets', 'Allowed target shortfall', 'number'],
  ['offerSize', 'Offer size', 'Desired raw offer size', 'number'],
  ['premiumBps', 'Premium (BPS)', 'Zero or negative', 'number'],
  ['maximumMarketExposure', 'Maximum market exposure', 'Raw per-market cap', 'number'],
  ['maximumTotalExposure', 'Maximum total exposure', 'Raw strategy-wide cap', 'number'],
  ['minimumRateBps', 'Minimum rate (BPS)', 'Inclusive final-rate floor', 'number'],
  ['maximumRateBps', 'Maximum rate (BPS)', 'Inclusive final-rate ceiling', 'number'],
  ['autoRefill', 'Auto-refill', 'Resume after observed completion', 'checkbox']
] as const

export const LADDER_FIELDS = [
  ['marketId', 'Market ID', 'Allowlisted bytes32 market', 'text'],
  ['quotePremiumBps', 'Quote premium (BPS)', 'Signed center offset', 'number'],
  ['spreadBps', 'Full spread (BPS)', 'Positive even nearest-rung distance', 'number'],
  ['stepBps', 'Step (BPS)', 'Positive same-side rung distance', 'number'],
  ['rungCount', 'Rungs per side', '1–512', 'number'],
  ['sizeSkewBps', 'Size skew (BPS)', 'Signed outer-rung weight change', 'number'],
  ['lowerRateBudgetAssets', 'Lower-rate budget', 'Positive reduce-only budget', 'number'],
  ['higherRateBudgetAssets', 'Higher-rate budget', 'Positive lend-buy budget', 'number'],
  ['targetMarketExposureAssets', 'Target market exposure', 'Positive market cap', 'number'],
  ['maximumTotalExposureAssets', 'Maximum total exposure', 'Positive strategy cap', 'number'],
  ['minimumOfferAssets', 'Minimum offer assets', 'Positive emitted-rung floor', 'number'],
  ['groupMode', 'Group mode', 'shared-rung or per-book', 'select'],
  ['loopIntervalSeconds', 'Loop interval (seconds)', '1–2147483', 'number'],
  ['movementToleranceBps', 'Movement tolerance (BPS)', 'Non-negative deadband', 'number'],
  ['minimumRateBps', 'Minimum rate (BPS)', 'Inclusive hard floor', 'number'],
  ['maximumRateBps', 'Maximum rate (BPS)', 'Inclusive hard ceiling', 'number']
] as const

export const OBSERVABILITY_FIELDS = [
  [
    'BETTERSTACK_SOURCE_TOKEN',
    'Better Stack source token',
    'Optional; pair with ingest host',
    'password'
  ],
  ['BETTERSTACK_INGESTING_HOST', 'Better Stack ingest host', 'Optional; pair with token', 'text'],
  ['BETTERSTACK_HEARTBEAT_URL', 'Better Stack heartbeat URL', 'Optional heartbeat', 'password']
] as const

type ScalarKey = (typeof SCALAR_FIELDS)[number][0]
type BootstrapKey = (typeof BOOTSTRAP_FIELDS)[number][0]
type LadderKey = (typeof LADDER_FIELDS)[number][0]
type ObservabilityKey = (typeof OBSERVABILITY_FIELDS)[number][0]
export type BootstrapInput = Record<Exclude<BootstrapKey, 'autoRefill'>, string> & {
  autoRefill: boolean
}
export type LadderInput = Record<LadderKey, string>
export type PlaygroundState = {
  scalar: Record<ScalarKey, string>
  bootstrap: BootstrapInput[]
  ladder: LadderInput[]
  observability: Record<ObservabilityKey, string>
  referenceRateBps: string
}

const DEFAULT_MARKET_ID = `0x${'5'.repeat(64)}`
const REFERENCE_MARKET_ID = `0x${'7'.repeat(64)}`
const OFFER_GROUP_ID = `0x${'8'.repeat(64)}`

export const createDefaultBootstrap = (marketId = DEFAULT_MARKET_ID): BootstrapInput => ({
  marketId,
  creditTarget: '10000000000',
  acceptanceAssets: '100000000',
  offerSize: '500000000',
  premiumBps: '-50',
  maximumMarketExposure: '20000000000',
  maximumTotalExposure: '30000000000',
  minimumRateBps: '200',
  maximumRateBps: '800',
  autoRefill: false
})

export const createDefaultLadder = (marketId = DEFAULT_MARKET_ID): LadderInput => ({
  marketId,
  quotePremiumBps: '0',
  spreadBps: '200',
  stepBps: '100',
  rungCount: '3',
  sizeSkewBps: '0',
  lowerRateBudgetAssets: '10000000000',
  higherRateBudgetAssets: '10000000000',
  targetMarketExposureAssets: '20000000000',
  maximumTotalExposureAssets: '30000000000',
  minimumOfferAssets: '101000000',
  groupMode: 'shared-rung',
  loopIntervalSeconds: '60',
  movementToleranceBps: '10',
  minimumRateBps: '200',
  maximumRateBps: '800'
})

export const createDefaultPlaygroundState = (): PlaygroundState => ({
  scalar: {
    CHAIN_ID: String(base.id),
    RPC_URL: 'https://base-rpc.example',
    REFERENCE_RPC_URL: 'https://base-archive-rpc.example',
    MAKER_PRIVATE_KEY: `0x${'a'.repeat(64)}`,
    MAKER_ADDRESS: `0x${'1'.repeat(40)}`,
    MIDNIGHT_ADDRESS: `0x${'2'.repeat(40)}`,
    LOAN_ASSET_ADDRESS: `0x${'3'.repeat(40)}`,
    RATIFIER_ADDRESS: `0x${'4'.repeat(40)}`,
    MARKET_IDS: DEFAULT_MARKET_ID,
    REFERENCE_MARKET_ID,
    NATIVE_RESERVE_WEI: '10000000000000000',
    MAXIMUM_LEND_EXPOSURE_ASSETS: '10000000000',
    MORPHO_API_BASE_URL: 'https://api.example',
    ROUTER_API_BASE_URL: 'https://router.example',
    V0_OFFER_GROUP_IDS: OFFER_GROUP_ID,
    REQUEST_TIMEOUT_MS: '10000',
    TRANSACTION_RECEIPT_TIMEOUT_MS: '180000'
  },
  bootstrap: [createDefaultBootstrap()],
  ladder: [createDefaultLadder()],
  observability: {
    BETTERSTACK_SOURCE_TOKEN: '',
    BETTERSTACK_INGESTING_HOST: '',
    BETTERSTACK_HEARTBEAT_URL: ''
  },
  referenceRateBps: '500'
})

const structuredBootstrap = (state: PlaygroundState) => state.bootstrap.map(item => ({ ...item }))
const structuredLadder = (state: PlaygroundState) => state.ladder.map(item => ({ ...item }))
const list = (value: string) =>
  value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
const yamlQuote = (value: string) => JSON.stringify(value)

const canonicalScalar = (state: PlaygroundState): PlaygroundState['scalar'] => ({
  ...state.scalar,
  CHAIN_ID: String(chainIdValue(state.scalar))
})

const rawEnvironmentRecord = (state: PlaygroundState): Record<string, string> => ({
  ...state.scalar,
  BOOTSTRAP_MARKETS: JSON.stringify(structuredBootstrap(state)),
  LADDER_MARKETS: JSON.stringify(structuredLadder(state)),
  ...state.observability
})

const environmentRecord = (state: PlaygroundState): Record<string, string> => ({
  ...canonicalScalar(state),
  BOOTSTRAP_MARKETS: JSON.stringify(structuredBootstrap(state)),
  LADDER_MARKETS: JSON.stringify(structuredLadder(state)),
  ...state.observability
})

export const validateProductionState = (state: PlaygroundState) => {
  const errors: string[] = []
  const capture = (operation: () => unknown) => {
    try {
      operation()
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Invalid configuration')
    }
  }
  const environment = rawEnvironmentRecord(state)
  capture(() => {
    chainIdValue(environment)
    privateKeyValue(environment)
    for (const field of [
      'MAKER_ADDRESS',
      'MIDNIGHT_ADDRESS',
      'LOAN_ASSET_ADDRESS',
      'RATIFIER_ADDRESS'
    ])
      addressValue(environment, field)
    for (const field of [
      'RPC_URL',
      'REFERENCE_RPC_URL',
      'MORPHO_API_BASE_URL',
      'ROUTER_API_BASE_URL'
    ])
      urlValue(environment, field)
    bytes32Value(environment, 'REFERENCE_MARKET_ID')
    const markets = hexListValue(environment, 'MARKET_IDS', false)
    hexListValue(environment, 'V0_OFFER_GROUP_IDS', false)
    for (const field of ['NATIVE_RESERVE_WEI', 'MAXIMUM_LEND_EXPOSURE_ASSETS'])
      unsignedBigIntValue(environment, field)
    requestTimeoutValue(environment)
    transactionReceiptTimeoutValue(environment)
    bootstrapConfigsValue(structuredBootstrap(state), markets)
    ladderConfigsValue(structuredLadder(state), markets)
  })
  return { valid: errors.length === 0, errors }
}

export type QuickLadderValidationError = {
  path: string
  reason: string
  message: string
}

const remapLadderValidationError = (
  error: ConfigValidationError,
  index: number
): QuickLadderValidationError => {
  const from = 'ladder[0]'
  const to = `ladder[${index}]`
  return {
    path: error.field.startsWith(from) ? `${to}${error.field.slice(from.length)}` : error.field,
    reason: error.reason,
    message: error.message.startsWith(from)
      ? `${to}${error.message.slice(from.length)}`
      : error.message
  }
}

/** Validates one quick-edit ladder without depending on unrelated scalar or bootstrap validity. */
export const validateQuickLadderState = (state: PlaygroundState, index: number) => {
  const errors: QuickLadderValidationError[] = []
  const input = state.ladder[index]
  if (!input) return { valid: true, errors }

  let markets
  try {
    markets = hexListValue({ MARKET_IDS: state.scalar.MARKET_IDS }, 'MARKET_IDS', false)
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      errors.push({ path: error.field, reason: error.reason, message: error.message })
      return { valid: false, errors }
    }
    throw error
  }

  try {
    ladderConfigsValue([{ ...input }], markets)
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      errors.push(remapLadderValidationError(error, index))
      return { valid: false, errors }
    }
    throw error
  }

  try {
    ladderConfigsValue(structuredLadder(state), markets)
  } catch (error) {
    if (error instanceof ConfigValidationError && !error.field.startsWith('ladder[')) {
      errors.push({ path: error.field, reason: error.reason, message: error.message })
    }
  }

  try {
    const referenceRateBps = BigInt(state.referenceRateBps)
    if (referenceRateBps <= 0n) {
      errors.push({
        path: 'referenceRateBps',
        reason: 'not-positive',
        message: 'referenceRateBps must be positive'
      })
    }
  } catch {
    errors.push({
      path: 'referenceRateBps',
      reason: 'invalid-integer',
      message: 'referenceRateBps must be an integer'
    })
  }

  return { valid: errors.length === 0, errors }
}

export type ObservabilityStatus = {
  integration: 'shipping' | 'heartbeat'
  state: 'disabled' | 'misconfigured' | 'enabled'
  level: 'status' | 'warning'
  message: string
}

/** Reports best-effort runtime observability state without treating it as core config validity. */
export const getObservabilityStatuses = (state: PlaygroundState): ObservabilityStatus[] => {
  const shipping = classifyShippingConfig(state.observability)
  const heartbeatValue = state.observability.BETTERSTACK_HEARTBEAT_URL.trim()
  const heartbeatState = !heartbeatValue
    ? 'disabled'
    : parseHttpHeartbeatUrl(heartbeatValue)
      ? 'enabled'
      : 'misconfigured'
  return [
    {
      integration: 'shipping',
      state: shipping.state,
      level: shipping.state === 'misconfigured' ? 'warning' : 'status',
      message:
        shipping.state === 'enabled'
          ? 'Log shipping transport configured at runtime because both Better Stack variables are set; delivery remains best-effort.'
          : shipping.state === 'disabled'
            ? 'Log shipping disabled. No Better Stack shipping variables are set.'
            : 'Log shipping is misconfigured and disabled at runtime. Set both Better Stack shipping variables; runtime emits logship.misconfigured.'
    },
    {
      integration: 'heartbeat',
      state: heartbeatState,
      level: heartbeatState === 'misconfigured' ? 'warning' : 'status',
      message:
        heartbeatState === 'enabled'
          ? 'Heartbeat enabled at runtime with an HTTP(S) URL.'
          : heartbeatState === 'disabled'
            ? 'Heartbeat disabled. No heartbeat URL is set.'
            : 'Heartbeat is misconfigured and disabled at runtime. Use an HTTP(S) URL; runtime emits heartbeat.misconfigured.'
    }
  ]
}

/** Backward-compatible production/export validation boundary. */
export const validatePlaygroundState = validateProductionState

const LADDER_IMPORT_FIELDS = [
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
const LADDER_IMPORT_FIELD_SET = new Set<string>(LADDER_IMPORT_FIELDS)
const UNSAFE_IMPORT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const isOwnEnumerablePlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (Object.getPrototypeOf(value) !== Object.prototype) return false
  return Reflect.ownKeys(value).every(key => {
    if (typeof key !== 'string') return false
    return Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
  })
}

const assertExactLadderObject = (value: unknown, prefix: string) => {
  if (!isOwnEnumerablePlainObject(value)) {
    throw new Error(`${prefix} must be an own enumerable plain object`)
  }
  const keys = Object.keys(value)
  if (keys.some(key => UNSAFE_IMPORT_KEYS.has(key))) {
    throw new Error(`${prefix} contains an unsafe key`)
  }
  if (keys.some(key => !LADDER_IMPORT_FIELD_SET.has(key))) {
    throw new Error(`${prefix} contains an unsupported key`)
  }
}

const importedLadderValue = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertExactLadderObject(item, `ladder[${index}]`))
    return value
  }
  if (!isOwnEnumerablePlainObject(value)) {
    throw new Error('Import must be a LADDER_MARKETS array or one exact ladder object')
  }
  assertExactLadderObject(value, 'ladder[0]')
  return [value]
}

const ladderInputFromConfig = (
  config: ReturnType<typeof ladderConfigsValue>[number]
): LadderInput => ({
  marketId: config.marketId,
  quotePremiumBps: String(config.quotePremiumBps),
  spreadBps: String(config.spreadBps),
  stepBps: String(config.stepBps),
  rungCount: String(config.rungCount),
  sizeSkewBps: String(config.sizeSkewBps),
  lowerRateBudgetAssets: String(config.lowerRateBudgetAssets),
  higherRateBudgetAssets: String(config.higherRateBudgetAssets),
  targetMarketExposureAssets: String(config.targetMarketExposureAssets),
  maximumTotalExposureAssets: String(config.maximumTotalExposureAssets),
  minimumOfferAssets: String(config.minimumOfferAssets),
  groupMode: config.groupMode,
  loopIntervalSeconds: String(config.loopIntervalSeconds),
  movementToleranceBps: String(config.movementToleranceBps),
  minimumRateBps: String(config.minimumRateBps),
  maximumRateBps: String(config.maximumRateBps)
})

const MAXIMUM_LADDER_IMPORT_BYTES = 128 * 1024
const MAXIMUM_JSON_NESTING = 128
const DUPLICATE_JSON_MEMBER_ERROR = 'Import contains duplicate JSON member names'

class LadderImportJsonError extends Error {}
class JsonScannerSyntaxError extends Error {}
class MalformedJsonUnicodeError extends Error {}

/**
 * Scans JSON object names before JSON.parse can overwrite duplicate members.
 * String names are decoded independently so escaped-equivalent names compare equal.
 */
const assertNoDuplicateJsonMembers = (text: string) => {
  let position = 0
  const syntaxError = (): never => {
    throw new JsonScannerSyntaxError()
  }
  const skipWhitespace = () => {
    while (
      text[position] === ' ' ||
      text[position] === '\t' ||
      text[position] === '\n' ||
      text[position] === '\r'
    ) {
      position++
    }
  }
  const scanString = (): string => {
    const start = position
    if (text[position++] !== '"') syntaxError()
    while (position < text.length) {
      const character = text[position++]!
      if (character === '"') {
        const encoded = text.slice(start, position)
        const decoded = (() => {
          try {
            return JSON.parse(encoded) as string
          } catch {
            return syntaxError()
          }
        })()
        for (let index = 0; index < decoded.length; index++) {
          const codeUnit = decoded.charCodeAt(index)
          if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
            const lowSurrogate = decoded.charCodeAt(index + 1)
            if (!(lowSurrogate >= 0xdc00 && lowSurrogate <= 0xdfff)) {
              throw new MalformedJsonUnicodeError()
            }
            index++
          } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
            throw new MalformedJsonUnicodeError()
          }
        }
        return encoded
      }
      if (character.charCodeAt(0) <= 0x1f) syntaxError()
      if (character !== '\\') continue
      const escape = text[position++]
      if (escape === 'u') {
        const hexadecimal = text.slice(position, position + 4)
        if (!/^[0-9a-fA-F]{4}$/.test(hexadecimal)) syntaxError()
        position += 4
      } else if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
        syntaxError()
      }
    }
    return syntaxError()
  }
  const scanValue = (depth: number): void => {
    skipWhitespace()
    const character = text[position]
    if (character === '"') {
      scanString()
      return
    }
    if (character === '{') {
      if (depth >= MAXIMUM_JSON_NESTING) {
        throw new LadderImportJsonError('Import JSON exceeds the nesting limit')
      }
      position++
      skipWhitespace()
      const members = new Set<string>()
      if (text[position] === '}') {
        position++
        return
      }
      while (position < text.length) {
        skipWhitespace()
        const encodedName = scanString()
        const name = (() => {
          try {
            return (JSON.parse(encodedName) as string).normalize('NFC')
          } catch {
            return syntaxError()
          }
        })()
        if (members.has(name)) throw new LadderImportJsonError(DUPLICATE_JSON_MEMBER_ERROR)
        members.add(name)
        skipWhitespace()
        if (text[position++] !== ':') syntaxError()
        scanValue(depth + 1)
        skipWhitespace()
        const separator = text[position++]
        if (separator === '}') return
        if (separator !== ',') syntaxError()
      }
      syntaxError()
    }
    if (character === '[') {
      if (depth >= MAXIMUM_JSON_NESTING) {
        throw new LadderImportJsonError('Import JSON exceeds the nesting limit')
      }
      position++
      skipWhitespace()
      if (text[position] === ']') {
        position++
        return
      }
      while (position < text.length) {
        scanValue(depth + 1)
        skipWhitespace()
        const separator = text[position++]
        if (separator === ']') return
        if (separator !== ',') syntaxError()
      }
      syntaxError()
    }
    const remainder = text.slice(position)
    const token = remainder.match(
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/
    )?.[0]
    if (token === undefined) return syntaxError()
    position += token.length
  }

  try {
    scanValue(0)
    skipWhitespace()
    if (position !== text.length) syntaxError()
  } catch (error) {
    // Malformed JSON is intentionally left to the native parser and its normal error path.
    if (!(error instanceof JsonScannerSyntaxError)) throw error
  }
}

const parseStrictImportJson = (text: string): unknown => {
  if (new TextEncoder().encode(text).byteLength > MAXIMUM_LADDER_IMPORT_BYTES) {
    throw new LadderImportJsonError('Import exceeds the 128 KiB size limit')
  }
  assertNoDuplicateJsonMembers(text)
  return JSON.parse(text)
}

const parseImportJsonLayer = (text: string): unknown => {
  let failure: unknown
  try {
    return parseStrictImportJson(text)
  } catch (error) {
    failure = error
  }
  if (failure instanceof LadderImportJsonError) throw failure
  throw new Error('Import must be valid JSON or a JSON string literal containing valid JSON')
}

/** Parses supported JSON ladder shapes through the production parser and returns canonical UI inputs. */
export const parseLadderMarketsImport = (
  text: string,
  allowlistedMarketIds: string
): LadderInput[] => {
  let parsed = parseImportJsonLayer(text)
  if (typeof parsed === 'string') parsed = parseImportJsonLayer(parsed)
  if (typeof parsed === 'string') {
    throw new Error('Import accepts at most one JSON string literal layer')
  }
  const markets = hexListValue({ MARKET_IDS: allowlistedMarketIds }, 'MARKET_IDS', false)
  const imported = importedLadderValue(parsed)
  return ladderConfigsValue(imported, markets).map(ladderInputFromConfig)
}

export const validatePreviewState = (state: PlaygroundState) => {
  const production = validateProductionState(state)
  if (!production.valid) return production
  try {
    generatePreviewLadders(state)
    return { valid: true, errors: [] }
  } catch (error) {
    return {
      valid: false,
      errors: [error instanceof Error ? error.message : 'Invalid preview configuration']
    }
  }
}

const assertExportable = (state: PlaygroundState) => {
  const result = validateProductionState(state)
  if (!result.valid) throw new Error(`Configuration is invalid: ${result.errors.join('; ')}`)
}

/** Exact compact JSON value expected in the LADDER_MARKETS environment variable. */
export const exportLadderMarketsEnvValue = (state: PlaygroundState) => {
  assertExportable(state)
  return JSON.stringify(structuredLadder(state))
}

type ExportOptions = { includeSensitiveValues?: boolean }
const REDACTED_VALUE = '<redacted>'
const exportSensitiveValue = (value: string, options: ExportOptions) =>
  options.includeSensitiveValues || value === '' ? value : REDACTED_VALUE
const redactSensitiveRecord = (record: Record<string, string>, options: ExportOptions) => {
  for (const key of SENSITIVE_UI_KEYS) {
    if (key in record) record[key] = exportSensitiveValue(record[key] ?? '', options)
  }
  return record
}
const exportScalar = (state: PlaygroundState, options: ExportOptions) => {
  return redactSensitiveRecord(canonicalScalar(state), options) as PlaygroundState['scalar']
}

export const exportYaml = (state: PlaygroundState, options: ExportOptions = {}) => {
  assertExportable(state)
  const scalar = exportScalar(state, options)
  const yamlList = (name: string, values: string[]) =>
    values.length === 0
      ? [`  ${name}: []`]
      : [`  ${name}:`, ...values.map(value => `    - ${yamlQuote(value)}`)]
  const lines = [
    'chain:',
    `  id: ${scalar.CHAIN_ID}`,
    `  rpcUrl: ${yamlQuote(scalar.RPC_URL)}`,
    `  archiveRpcUrl: ${yamlQuote(scalar.REFERENCE_RPC_URL)}`,
    'identity:',
    `  makerAddress: ${yamlQuote(scalar.MAKER_ADDRESS)}`,
    `  makerPrivateKey: ${yamlQuote(scalar.MAKER_PRIVATE_KEY)}`,
    'contracts:',
    `  midnightAddress: ${yamlQuote(scalar.MIDNIGHT_ADDRESS)}`,
    `  loanAssetAddress: ${yamlQuote(scalar.LOAN_ASSET_ADDRESS)}`,
    `  ratifierAddress: ${yamlQuote(scalar.RATIFIER_ADDRESS)}`,
    'apis:',
    `  morphoBaseUrl: ${yamlQuote(scalar.MORPHO_API_BASE_URL)}`,
    `  routerBaseUrl: ${yamlQuote(scalar.ROUTER_API_BASE_URL)}`,
    'markets:',
    ...yamlList('allowlist', list(scalar.MARKET_IDS)),
    `  referenceMarketId: ${yamlQuote(scalar.REFERENCE_MARKET_ID)}`,
    ...yamlList('v0OfferGroupIds', list(scalar.V0_OFFER_GROUP_IDS)),
    'setup:',
    `  nativeReserveWei: ${yamlQuote(scalar.NATIVE_RESERVE_WEI)}`,
    `  maximumLendExposureAssets: ${yamlQuote(scalar.MAXIMUM_LEND_EXPOSURE_ASSETS)}`,
    `  requestTimeoutMs: ${scalar.REQUEST_TIMEOUT_MS}`,
    `  transactionReceiptTimeoutMs: ${scalar.TRANSACTION_RECEIPT_TIMEOUT_MS}`,
    state.bootstrap.length === 0 ? 'bootstrap: []' : 'bootstrap:'
  ]
  for (const item of state.bootstrap)
    for (const [index, [key]] of BOOTSTRAP_FIELDS.entries()) {
      const value = item[key]
      lines.push(
        `${index === 0 ? '  - ' : '    '}${key}: ${typeof value === 'boolean' ? value : yamlQuote(value)}`
      )
    }
  lines.push(state.ladder.length === 0 ? 'ladder: []' : 'ladder:')
  for (const item of state.ladder)
    for (const [index, [key]] of LADDER_FIELDS.entries())
      lines.push(`${index === 0 ? '  - ' : '    '}${key}: ${yamlQuote(item[key])}`)
  return `${lines.join('\n')}\n`
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`

/** POSIX-shell-safe export. Values are single-quoted so expansion and command substitution stay inert. */
export const exportShell = (state: PlaygroundState, options: ExportOptions = {}) => {
  assertExportable(state)
  const environment = redactSensitiveRecord(environmentRecord(state), options)
  return `${Object.entries(environment)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('\n')}\n`
}

export const exportJson = (state: PlaygroundState, options: ExportOptions = {}) => {
  assertExportable(state)
  const scalar = exportScalar(state, options)
  const configuration = {
    ...scalar,
    MARKET_IDS: list(scalar.MARKET_IDS),
    V0_OFFER_GROUP_IDS: list(scalar.V0_OFFER_GROUP_IDS),
    BOOTSTRAP_MARKETS: structuredBootstrap(state),
    LADDER_MARKETS: structuredLadder(state)
  }
  const observability = redactSensitiveRecord({ ...state.observability }, options)
  return `${JSON.stringify({ configuration, observability }, null, 2)}\n`
}

type PreviewRung = { index: number; rateBps: string; assets: string; offerMaxAssets: string }
type PreviewLadder = {
  marketId: string
  centerRateBps: string
  lower: PreviewRung[]
  higher: PreviewRung[]
}

export type LadderGraphicRung = {
  index: number
  rateBps: string
  allocationAssets: string
  offerMaxAssets: string
  side: 'higher' | 'lower'
  sideLabel: 'Lend' | 'Reduce-only'
  y: number
  allocationBarRatio: number
  offerMaxBarRatio: number
}

export type LadderGraphicModel = {
  marketId: string
  axis: {
    minimumRateBps: string
    maximumRateBps: string
    referenceRateBps: string
    centerRateBps: string
  }
  gapBps: string
  plotHeight: number
  rateToY: (rateBps: string) => number
  rungs: LadderGraphicRung[]
  callouts: { label: string; value: string; parameters: string[] }[]
}

export const generatePreviewLadders = (state: PlaygroundState): PreviewLadder[] => {
  const referenceRateBps = BigInt(state.referenceRateBps)
  if (referenceRateBps <= 0n) throw new Error('referenceRateBps must be positive')
  const markets = hexListValue(environmentRecord(state), 'MARKET_IDS', false)
  const configs = ladderConfigsValue(structuredLadder(state), markets)
  return configs.map(config => {
    const generated = generateLadder({ config, referenceRateBps })
    const maxAssets = offerMaxAssetsByRung(generated)
    const mapRungs = (rungs: typeof generated.lower, caps: readonly bigint[]) =>
      rungs.map((rung, index) => ({
        index: rung.index,
        rateBps: String(rung.rateBps),
        assets: String(rung.assets),
        offerMaxAssets: String(caps[index]!)
      }))
    return {
      marketId: generated.marketId,
      centerRateBps: String(generated.centerRateBps),
      lower: mapRungs(generated.lower, maxAssets.lower),
      higher: mapRungs(generated.higher, maxAssets.higher)
    }
  })
}

const GRAPHIC_RATIO_SCALE = 1_000_000_000_000n
const ASSET_RATIO_SCALE = 10_000n
const MINIMUM_GRAPHIC_HEIGHT = 336
const MAXIMUM_GRAPHIC_HEIGHT = 32_768
const MINIMUM_ROW_SPACING = 28

const boundedRatio = (numerator: bigint, denominator: bigint, scale = GRAPHIC_RATIO_SCALE) => {
  if (denominator <= 0n) throw new Error('Graphic ratio denominator must be positive')
  const bounded = numerator < 0n ? 0n : numerator > denominator ? denominator : numerator
  return Number((bounded * scale) / denominator) / Number(scale)
}

const boundedPlotHeight = (range: bigint, minimumRateDelta: bigint) => {
  if (range <= 0n || minimumRateDelta <= 0n) throw new Error('Graphic rate range must be positive')
  const required =
    (range * BigInt(MINIMUM_ROW_SPACING) + minimumRateDelta - 1n) / minimumRateDelta + 2n
  if (required > BigInt(MAXIMUM_GRAPHIC_HEIGHT)) {
    throw new Error(
      `Preview geometry exceeds the ${MAXIMUM_GRAPHIC_HEIGHT}px practical plot-height limit`
    )
  }
  return Math.max(MINIMUM_GRAPHIC_HEIGHT, Number(required))
}

const graphicAssets = (value: bigint) => Intl.NumberFormat('en-US').format(value)

const graphicCallouts = (
  values: Record<string, string>,
  centerRateBps: string,
  sideTotals: { lower: bigint; higher: bigint },
  effectiveRuntimeCycleSeconds: string
) => [
  {
    label: 'Center',
    value: `${values.referenceRateBps} + ${values.quotePremiumBps} = ${centerRateBps} BPS`,
    parameters: ['referenceRateBps', 'quotePremiumBps']
  },
  {
    label: 'Spacing & gap',
    value: `${values.stepBps} BPS steps · ${values.spreadBps} BPS full gap`,
    parameters: ['stepBps', 'spreadBps']
  },
  {
    label: 'Rungs & sizing',
    value: `${values.rungCount}/side · ${values.sizeSkewBps} BPS skew · ${values.minimumOfferAssets} floor`,
    parameters: ['rungCount', 'sizeSkewBps', 'minimumOfferAssets']
  },
  {
    label: 'Budgets',
    value: `${values.lowerRateBudgetAssets} reduce-only · ${values.higherRateBudgetAssets} lend`,
    parameters: ['lowerRateBudgetAssets', 'higherRateBudgetAssets']
  },
  {
    label: 'Exposure caps',
    value: `${values.targetMarketExposureAssets} target (static binding cap) · ${values.maximumTotalExposureAssets} configured total ceiling; current aggregate exposure and live capacity excluded`,
    parameters: ['targetMarketExposureAssets', 'maximumTotalExposureAssets']
  },
  {
    label: 'Grouping',
    value:
      values.groupMode === 'per-book'
        ? `per-book · side-wide shared offer maxAssets caps · Reduce-only: ${graphicAssets(sideTotals.lower)} · Lend: ${graphicAssets(sideTotals.higher)}`
        : 'shared-rung · each offer maxAssets equals its rung allocation',
    parameters: ['groupMode']
  },
  {
    label: 'Cadence & tolerance',
    value: `${values.loopIntervalSeconds}s configured interval · ${effectiveRuntimeCycleSeconds}s effective runtime cycle (minimum across configured markets) · ${values.movementToleranceBps} BPS informational deadband against retained active center; fresh stateless center unchanged`,
    parameters: ['loopIntervalSeconds', 'movementToleranceBps']
  },
  {
    label: 'Hard bounds',
    value: `${values.minimumRateBps}–${values.maximumRateBps} BPS`,
    parameters: ['minimumRateBps', 'maximumRateBps']
  }
]

/** Builds presentation-only SVG geometry from the production-equivalent generated ladders. */
export const generateLadderGraphicModels = (state: PlaygroundState): LadderGraphicModel[] => {
  const previews = generatePreviewLadders(state)
  const effectiveRuntimeCycleSeconds = state.ladder.reduce(
    (minimum, input) =>
      BigInt(input.loopIntervalSeconds) < minimum ? BigInt(input.loopIntervalSeconds) : minimum,
    BigInt(state.ladder[0]?.loopIntervalSeconds ?? '1')
  )
  return previews.map((preview, index) => {
    const input = state.ladder[index]!
    const parameterValues: Record<string, string> = {
      ...input,
      referenceRateBps: state.referenceRateBps
    }
    const minimum = BigInt(input.minimumRateBps)
    const maximum = BigInt(input.maximumRateBps)
    const range = maximum - minimum
    const rows = [
      ...preview.higher.toReversed().map(rung => ({
        index: rung.index,
        rateBps: rung.rateBps,
        allocationAssets: rung.assets,
        offerMaxAssets: rung.offerMaxAssets,
        side: 'higher' as const,
        sideLabel: 'Lend' as const
      })),
      ...preview.lower.map(rung => ({
        index: rung.index,
        rateBps: rung.rateBps,
        allocationAssets: rung.assets,
        offerMaxAssets: rung.offerMaxAssets,
        side: 'lower' as const,
        sideLabel: 'Reduce-only' as const
      }))
    ]
    const sideTotals = {
      lower: preview.lower.reduce((total, rung) => total + BigInt(rung.assets), 0n),
      higher: preview.higher.reduce((total, rung) => total + BigInt(rung.assets), 0n)
    }
    const scaleAssets = [sideTotals.lower, sideTotals.higher].reduce(
      (largest, total) => (total > largest ? total : largest),
      1n
    )
    const importantRates = [preview.centerRateBps, ...rows.map(rung => rung.rateBps)]
      .map(BigInt)
      .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    const minimumRateDelta = importantRates.slice(1).reduce((minimumDelta, rate, index) => {
      const delta = rate - importantRates[index]!
      return delta > 0n && delta < minimumDelta ? delta : minimumDelta
    }, range)
    const plotHeight = boundedPlotHeight(range, minimumRateDelta)
    const rateToY = (rateBps: string) =>
      32 + boundedRatio(maximum - BigInt(rateBps), range) * plotHeight
    const rungs = rows.map(rung => ({
      ...rung,
      y: rateToY(rung.rateBps),
      allocationBarRatio: boundedRatio(
        BigInt(rung.allocationAssets),
        scaleAssets,
        ASSET_RATIO_SCALE
      ),
      offerMaxBarRatio: boundedRatio(BigInt(rung.offerMaxAssets), scaleAssets, ASSET_RATIO_SCALE)
    }))
    return {
      marketId: preview.marketId,
      axis: {
        minimumRateBps: input.minimumRateBps,
        maximumRateBps: input.maximumRateBps,
        referenceRateBps: state.referenceRateBps,
        centerRateBps: preview.centerRateBps
      },
      gapBps: input.spreadBps,
      plotHeight,
      rateToY,
      rungs,
      callouts: graphicCallouts(
        parameterValues,
        preview.centerRateBps,
        sideTotals,
        String(effectiveRuntimeCycleSeconds)
      )
    }
  })
}
