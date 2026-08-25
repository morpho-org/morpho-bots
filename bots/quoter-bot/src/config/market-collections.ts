import type { Hex } from 'viem'

import type { BootstrapConfig } from '../domain/bootstrap/position-bootstrap'
import type { LadderConfig } from '../domain/ladder/ladder'
import type { MaturityPremiumConfig } from '../domain/maturity-premium'
import type { TargetRateConfigured, TargetRateStrategyConfig } from '../domain/target-rate'

import { BootstrapConfigurationError } from '../domain/bootstrap/bootstrap-configuration.error'
import { validateBootstrapConfig } from '../domain/bootstrap/position-bootstrap'
import { isBytes32, normalizeBytes32 } from '../domain/bytes32'
import { assertLadderShapeAtReference, validateLadderConfig } from '../domain/ladder/ladder'
import { LadderConfigurationError } from '../domain/ladder/ladder-configuration.error'
import { ConfigValidationError } from './config-validation.error'

/** Minimal string environment shape used by pure market-id parsing. */
export type MarketCollectionEnvironment = Record<string, string | undefined>

/**
 * Validates and canonicalizes one browser-safe market identifier without loading runtime providers.
 * @param value - Untrusted candidate market identifier.
 * @param name - Stable field path used in sanitized validation errors.
 * @returns The canonical lower-case bytes32 identifier.
 */
export const parseBytes32 = (value: string, name: string): Hex => {
  if (!isBytes32(value)) {
    throw new ConfigValidationError(
      name,
      'invalid-bytes32',
      `${name} must be a 0x-prefixed 32-byte hex value`
    )
  }
  return normalizeBytes32(value)
}

/**
 * Parses an ordered comma-separated market allowlist without provider, logging, or secret access.
 * @param environment - String boundary containing the named list.
 * @param name - Environment field to parse and identify in sanitized failures.
 * @param requiredList - Whether the ordered list must contain at least one identifier.
 * @returns Canonical unique identifiers in source order.
 */
export const hexListValue = (
  environment: MarketCollectionEnvironment,
  name: string,
  requiredList: boolean
): Hex[] => {
  const raw = environment[name]?.trim() ?? ''
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

export const BOOTSTRAP_MARKET_FIELDS = [
  'marketId',
  'targetRate',
  'creditTarget',
  'acceptanceAssets',
  'offerSize',
  'premiumBps',
  'maturityPremium',
  'maximumMarketExposure',
  'maximumTotalExposure',
  'minimumRateBps',
  'maximumRateBps',
  'autoRefill'
] as const

export const LADDER_MARKET_FIELDS = [
  'marketId',
  'targetRate',
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

const plainRecord = (value: unknown, field: string): Record<string, unknown> => {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
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

const targetRateStrategyValue = (value: unknown, field: string): TargetRateStrategyConfig => {
  if (value === undefined) return { strategy: 'variable_rate_avg' }
  const targetRate = plainRecord(value, field)
  if (typeof targetRate.strategy !== 'string') {
    throw new ConfigValidationError(
      `${field}.strategy`,
      'wrong-type',
      `${field}.strategy must be a string`
    )
  }
  if (targetRate.strategy === 'variable_rate_avg') {
    if (Object.keys(targetRate).some(key => key !== 'strategy')) {
      throw new ConfigValidationError(field, 'unknown-key', `${field} contains an unsupported key`)
    }
    return { strategy: 'variable_rate_avg' }
  }
  if (targetRate.strategy !== 'hardcoded') {
    throw new ConfigValidationError(
      `${field}.strategy`,
      'invalid-strategy',
      `${field}.strategy must be variable_rate_avg or hardcoded`
    )
  }
  if (Object.keys(targetRate).some(key => key !== 'strategy' && key !== 'hardcodedRateBps')) {
    throw new ConfigValidationError(field, 'unknown-key', `${field} contains an unsupported key`)
  }
  if (targetRate.hardcodedRateBps === undefined) {
    throw new ConfigValidationError(
      `${field}.hardcodedRateBps`,
      'missing',
      `${field}.hardcodedRateBps is required`
    )
  }
  const hardcodedRateBps = integerBigInt(
    targetRate.hardcodedRateBps,
    `${field}.hardcodedRateBps`,
    false
  )
  if (hardcodedRateBps <= 0n) {
    throw new ConfigValidationError(
      `${field}.hardcodedRateBps`,
      'out-of-range',
      `${field}.hardcodedRateBps must be positive`
    )
  }
  return { strategy: 'hardcoded', hardcodedRateBps }
}

const maturityPremiumValue = (value: unknown, field: string): MaturityPremiumConfig | undefined => {
  if (value === undefined) return undefined
  const maturityPremium = plainRecord(value, field)
  if (
    Object.keys(maturityPremium).some(
      key => key !== 'shape' && key !== 'premiumPerYearBps' && key !== 'maximumPremiumBps'
    )
  ) {
    throw new ConfigValidationError(field, 'unknown-key', `${field} contains an unsupported key`)
  }
  if (typeof maturityPremium.shape !== 'string') {
    throw new ConfigValidationError(
      `${field}.shape`,
      'wrong-type',
      `${field}.shape must be a string`
    )
  }
  if (maturityPremium.shape !== 'linear') {
    throw new ConfigValidationError(
      `${field}.shape`,
      'invalid-shape',
      `${field}.shape must be linear`
    )
  }
  if (maturityPremium.premiumPerYearBps === undefined) {
    throw new ConfigValidationError(
      `${field}.premiumPerYearBps`,
      'missing',
      `${field}.premiumPerYearBps is required`
    )
  }
  const premiumPerYearBps = integerBigInt(
    maturityPremium.premiumPerYearBps,
    `${field}.premiumPerYearBps`,
    false
  )
  const maximumPremiumBps =
    maturityPremium.maximumPremiumBps === undefined
      ? undefined
      : integerBigInt(maturityPremium.maximumPremiumBps, `${field}.maximumPremiumBps`, false)
  return {
    shape: 'linear',
    premiumPerYearBps,
    ...(maximumPremiumBps === undefined ? {} : { maximumPremiumBps })
  }
}

const exactRecord = <Field extends string>(
  value: unknown,
  prefix: string,
  fields: readonly Field[],
  optionalFields: readonly Field[] = []
) => {
  const record = plainRecord(value, prefix)
  const keys = Object.keys(record)
  if (keys.some(key => key === '__proto__' || key === 'constructor' || key === 'prototype')) {
    throw new ConfigValidationError(prefix, 'unsafe-key', `${prefix} contains an unsafe key`)
  }
  if (keys.some(key => !fields.includes(key as Field))) {
    throw new ConfigValidationError(prefix, 'unknown-key', `${prefix} contains an unsupported key`)
  }
  const missing = fields.find(
    field => !optionalFields.includes(field) && record[field] === undefined
  )
  if (missing !== undefined) {
    throw new ConfigValidationError(
      `${prefix}.${missing}`,
      'missing',
      `${prefix}.${missing} is required`
    )
  }
  return record
}

/**
 * Converts an exact bootstrap collection into production domain values using shared pure semantics.
 * @param value - Untrusted collection value at the JSON or YAML boundary.
 * @param allowlistedMarkets - Canonical markets allowed for this complete replacement collection.
 * @returns Validated bootstrap configurations in input order.
 */
export const bootstrapConfigsValue = (
  value: unknown,
  allowlistedMarkets: readonly Hex[]
): TargetRateConfigured<BootstrapConfig>[] => {
  if (!Array.isArray(value)) {
    throw new ConfigValidationError('bootstrap', 'wrong-type', 'bootstrap must be a list')
  }
  const configs = value.map((item, index) => {
    const prefix = `bootstrap[${index}]`
    const record = exactRecord(item, prefix, BOOTSTRAP_MARKET_FIELDS, [
      'targetRate',
      'maturityPremium'
    ])
    const required = (name: (typeof BOOTSTRAP_MARKET_FIELDS)[number]) => record[name]
    const marketValue = required('marketId')
    if (typeof marketValue !== 'string') {
      throw new ConfigValidationError(
        `${prefix}.marketId`,
        'wrong-type',
        `${prefix}.marketId must be a string`
      )
    }
    const maturityPremium = maturityPremiumValue(
      record.maturityPremium,
      `${prefix}.maturityPremium`
    )
    const config: TargetRateConfigured<BootstrapConfig> = {
      marketId: parseBytes32(marketValue, `${prefix}.marketId`),
      targetRate: targetRateStrategyValue(record.targetRate, `${prefix}.targetRate`),
      creditTarget: integerBigInt(required('creditTarget'), `${prefix}.creditTarget`, false),
      acceptanceAssets: integerBigInt(
        required('acceptanceAssets'),
        `${prefix}.acceptanceAssets`,
        false
      ),
      offerSize: integerBigInt(required('offerSize'), `${prefix}.offerSize`, false),
      premiumBps: integerBigInt(required('premiumBps'), `${prefix}.premiumBps`, true),
      ...(maturityPremium === undefined ? {} : { maturityPremium }),
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
      if (config.targetRate.strategy === 'hardcoded') {
        const requestedRateBps = config.targetRate.hardcodedRateBps + config.premiumBps
        if (requestedRateBps < config.minimumRateBps) {
          throw new BootstrapConfigurationError(
            'requestedRateBps',
            'must be at least minimumRateBps'
          )
        }
        if (requestedRateBps > config.maximumRateBps) {
          throw new BootstrapConfigurationError(
            'requestedRateBps',
            'must be at most maximumRateBps'
          )
        }
      }
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
 * Converts an exact ladder collection into production domain values using shared pure semantics.
 * @param value - Untrusted collection value at the JSON or YAML boundary.
 * @param allowlistedMarkets - Canonical markets allowed for this complete replacement collection.
 * @returns Validated ladder configurations in input order.
 */
export const ladderConfigsValue = (
  value: unknown,
  allowlistedMarkets: readonly Hex[]
): TargetRateConfigured<LadderConfig>[] => {
  if (!Array.isArray(value)) {
    throw new ConfigValidationError('ladder', 'wrong-type', 'ladder must be a list')
  }
  const configs = value.map((item, index) => {
    const prefix = `ladder[${index}]`
    const record = exactRecord(item, prefix, LADDER_MARKET_FIELDS, ['targetRate'])
    const required = (name: (typeof LADDER_MARKET_FIELDS)[number]) => record[name]
    const marketValue = required('marketId')
    const groupMode = required('groupMode')
    if (typeof marketValue !== 'string' || typeof groupMode !== 'string') {
      throw new ConfigValidationError(
        prefix,
        'wrong-type',
        `${prefix} string fields must be strings`
      )
    }
    const config: TargetRateConfigured<LadderConfig> = {
      marketId: parseBytes32(marketValue, `${prefix}.marketId`),
      targetRate: targetRateStrategyValue(record.targetRate, `${prefix}.targetRate`),
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
      if (config.targetRate.strategy === 'hardcoded') {
        assertLadderShapeAtReference(config, config.targetRate.hardcodedRateBps)
      }
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
