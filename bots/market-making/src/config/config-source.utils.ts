import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from 'yaml'

import type { Environment } from './config.utils'

import { ConfigFileError } from './config-file.error'
import { ConfigValidationError } from './config-validation.error'

/** Combined raw configuration values and parsed bootstrap entries from YAML and environment input. */
export type ConfigurationSource = {
  values: Record<string, unknown>
  bootstrap: unknown
  ladder: unknown
  path?: string
}

/** Optional configuration path, invocation directory, file reader, and identity-loading mode. */
export type ConfigurationLoadOptions = {
  configPath?: string
  cwd?: string
  fileSystem?: ConfigurationFileSystem
  /** Selects address-only configuration and suppresses maker signing-secret loading. */
  readOnly?: boolean
  /** Reads a keystore password without echoing it when interactive storage is selected. */
  readPassword?: () => Promise<string>
}

type ConfigurationFileMetadata = {
  size: number
  isFile: () => boolean
}

type ConfigurationFileHandle = {
  stat: () => Promise<ConfigurationFileMetadata>
  read: (
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: null
  ) => Promise<{ bytesRead: number }>
  close: () => Promise<void>
}

type ConfigurationFileSystem = {
  open: (path: string, flags: number) => Promise<ConfigurationFileHandle>
}

const MAX_CONFIGURATION_SOURCE_BYTES = 1_048_576
const MAX_YAML_DEPTH = 64

const nodeFileSystem: ConfigurationFileSystem = {
  open: async (path, flags) => (await open(path, flags)) as ConfigurationFileHandle
}

const environmentKeys = [
  'CHAIN_ID',
  'RPC_URL',
  'REFERENCE_RPC_URL',
  'MAKER_PRIVATE_KEY',
  'KEY_STORAGE_METHOD',
  'KEYSTORE_PATH',
  'KEYSTORE_PASSWORD',
  'KEYSTORE_INTERACTIVE',
  'AWS_KMS_KEY_ID',
  'AWS_REGION',
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
  'TRANSACTION_RECEIPT_TIMEOUT_MS'
] as const

const yamlKeys = {
  root: ['chain', 'identity', 'contracts', 'apis', 'markets', 'setup', 'bootstrap', 'ladder'],
  chain: ['id', 'rpcUrl', 'archiveRpcUrl'],
  identity: [
    'makerAddress',
    'keyStorageMethod',
    'makerPrivateKey',
    'keystorePath',
    'keystorePassword',
    'keystoreInteractive',
    'awsKmsKeyId',
    'awsRegion'
  ],
  contracts: ['midnightAddress', 'loanAssetAddress', 'ratifierAddress'],
  apis: ['morphoBaseUrl', 'routerBaseUrl'],
  markets: ['allowlist', 'referenceMarketId', 'v0OfferGroupIds'],
  setup: [
    'nativeReserveWei',
    'maximumLendExposureAssets',
    'requestTimeoutMs',
    'transactionReceiptTimeoutMs'
  ],
  bootstrap: [
    'marketId',
    'targetRate',
    'creditTarget',
    'acceptanceAssets',
    'offerSize',
    'premiumBps',
    'maximumMarketExposure',
    'maximumTotalExposure',
    'minimumRateBps',
    'maximumRateBps',
    'autoRefill'
  ],
  ladder: [
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
  ]
} as const

const record = (value: unknown, field: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigValidationError(field, 'wrong-type', `${field} must be a mapping`)
  }
  return value as Record<string, unknown>
}

const rejectUnknownKeys = (value: Record<string, unknown>, allowed: readonly string[]) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new ConfigFileError('unknown-key')
  }
}

const rejectUnsafeYamlNodes = (document: ReturnType<typeof parseDocument>) => {
  visit(document, {
    Node(_key, node, path) {
      if (path.length > MAX_YAML_DEPTH) throw new ConfigFileError('malformed')
      if (isAlias(node) || node.tag !== undefined) throw new ConfigFileError('malformed')
    },
    Pair(_key, pair) {
      if (
        isScalar(pair.key) &&
        (pair.key.value === '__proto__' || pair.key.value === 'constructor')
      ) {
        throw new ConfigFileError('malformed')
      }
    }
  })
}

const yamlIntegerEnvironmentKeys = new Set([
  'CHAIN_ID',
  'NATIVE_RESERVE_WEI',
  'MAXIMUM_LEND_EXPOSURE_ASSETS',
  'REQUEST_TIMEOUT_MS',
  'TRANSACTION_RECEIPT_TIMEOUT_MS'
])

const scalar = (value: unknown, field: string) => {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    throw new ConfigValidationError(field, 'wrong-type', `${field} must be a scalar value`)
  }
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new ConfigValidationError(
      field,
      'unsafe-number',
      `${field} must be an integer-safe value`
    )
  }
  return String(value)
}

const stringList = (value: unknown, field: string) => {
  if (!Array.isArray(value)) {
    throw new ConfigValidationError(field, 'wrong-type', `${field} must be a list`)
  }
  return value.map(item => scalar(item, field)).join(',')
}

const yamlSource = (input: unknown, readOnly: boolean): ConfigurationSource => {
  const root = record(input, 'configuration')
  rejectUnknownKeys(root, yamlKeys.root)
  const values: Record<string, unknown> = {}

  const mapGroup = (
    groupName: keyof Pick<typeof yamlKeys, 'chain' | 'identity' | 'contracts' | 'apis' | 'setup'>,
    mapping: Record<string, string>
  ) => {
    if (root[groupName] === undefined) return
    const group = record(root[groupName], groupName)
    rejectUnknownKeys(group, yamlKeys[groupName])
    for (const [yamlName, environmentName] of Object.entries(mapping)) {
      if (group[yamlName] === undefined) continue
      const value = scalar(group[yamlName], yamlName)
      if (yamlIntegerEnvironmentKeys.has(environmentName) && !/^\d+$/.test(value)) {
        throw new ConfigValidationError(
          yamlName,
          'invalid-integer',
          `${yamlName} must be a decimal integer`
        )
      }
      values[environmentName] = value
    }
  }

  mapGroup('chain', {
    id: 'CHAIN_ID',
    rpcUrl: 'RPC_URL',
    archiveRpcUrl: 'REFERENCE_RPC_URL'
  })
  mapGroup(
    'identity',
    readOnly
      ? { makerAddress: 'MAKER_ADDRESS' }
      : {
          makerAddress: 'MAKER_ADDRESS',
          keyStorageMethod: 'KEY_STORAGE_METHOD',
          makerPrivateKey: 'MAKER_PRIVATE_KEY',
          keystorePath: 'KEYSTORE_PATH',
          keystorePassword: 'KEYSTORE_PASSWORD',
          keystoreInteractive: 'KEYSTORE_INTERACTIVE',
          awsKmsKeyId: 'AWS_KMS_KEY_ID',
          awsRegion: 'AWS_REGION'
        }
  )
  mapGroup('contracts', {
    midnightAddress: 'MIDNIGHT_ADDRESS',
    loanAssetAddress: 'LOAN_ASSET_ADDRESS',
    ratifierAddress: 'RATIFIER_ADDRESS'
  })
  mapGroup('apis', {
    morphoBaseUrl: 'MORPHO_API_BASE_URL',
    routerBaseUrl: 'ROUTER_API_BASE_URL'
  })
  mapGroup('setup', {
    nativeReserveWei: 'NATIVE_RESERVE_WEI',
    maximumLendExposureAssets: 'MAXIMUM_LEND_EXPOSURE_ASSETS',
    requestTimeoutMs: 'REQUEST_TIMEOUT_MS',
    transactionReceiptTimeoutMs: 'TRANSACTION_RECEIPT_TIMEOUT_MS'
  })

  if (root.markets !== undefined) {
    const markets = record(root.markets, 'markets')
    rejectUnknownKeys(markets, yamlKeys.markets)
    if (markets.allowlist !== undefined)
      values.MARKET_IDS = stringList(markets.allowlist, 'markets.allowlist')
    if (markets.referenceMarketId !== undefined)
      values.REFERENCE_MARKET_ID = scalar(markets.referenceMarketId, 'markets.referenceMarketId')
    if (markets.v0OfferGroupIds !== undefined)
      values.V0_OFFER_GROUP_IDS = stringList(markets.v0OfferGroupIds, 'markets.v0OfferGroupIds')
  }

  let bootstrap: unknown = []
  if (root.bootstrap !== undefined) {
    if (!Array.isArray(root.bootstrap)) {
      throw new ConfigValidationError('bootstrap', 'wrong-type', 'bootstrap must be a list')
    }
    bootstrap = root.bootstrap.map(item => {
      const mapped = record(item, 'bootstrap item')
      rejectUnknownKeys(mapped, yamlKeys.bootstrap)
      return mapped
    })
  }

  let ladder: unknown = []
  if (root.ladder !== undefined) {
    if (!Array.isArray(root.ladder)) {
      throw new ConfigValidationError('ladder', 'wrong-type', 'ladder must be a list')
    }
    ladder = root.ladder.map(item => {
      const mapped = record(item, 'ladder item')
      rejectUnknownKeys(mapped, yamlKeys.ladder)
      return mapped
    })
  }

  return { values, bootstrap, ladder }
}

const parseYaml = (text: string) => {
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIGURATION_SOURCE_BYTES) {
    throw new ConfigFileError('too-large')
  }
  if (!text.trim()) throw new ConfigFileError('empty')
  try {
    const document = parseDocument(text, { schema: 'failsafe', uniqueKeys: true })
    if (document.errors.length > 0 || document.warnings.length > 0) throw document.errors
    rejectUnsafeYamlNodes(document)
    if (document.contents === null) throw new ConfigFileError('empty')
    return document
  } catch (error) {
    if (error instanceof ConfigFileError && error.reason === 'empty') throw error
    throw new ConfigFileError('malformed')
  }
}

const yamlDocumentValue = (
  document: ReturnType<typeof parseDocument>,
  validateBootstrapBooleans: boolean
) => {
  if (validateBootstrapBooleans && isMap(document.contents)) {
    const bootstrap = document.contents.get('bootstrap', true)
    if (isSeq(bootstrap)) {
      for (const [index, item] of bootstrap.items.entries()) {
        if (!isMap(item)) continue
        const autoRefill = item.get('autoRefill', true)
        if (autoRefill === undefined) continue
        if (
          !isScalar(autoRefill) ||
          autoRefill.type !== 'PLAIN' ||
          (autoRefill.source !== 'true' && autoRefill.source !== 'false')
        ) {
          throw new ConfigValidationError(
            `bootstrap[${index}].autoRefill`,
            'wrong-type',
            `bootstrap[${index}].autoRefill must be a boolean`
          )
        }
        autoRefill.value = autoRefill.source === 'true'
      }
    }
  }
  try {
    return document.toJS({ maxAliasCount: 0 }) as unknown
  } catch {
    throw new ConfigFileError('malformed')
  }
}

const yamlEnvironmentPaths: Partial<
  Record<(typeof environmentKeys)[number], readonly [string, string]>
> = {
  CHAIN_ID: ['chain', 'id'],
  RPC_URL: ['chain', 'rpcUrl'],
  REFERENCE_RPC_URL: ['chain', 'archiveRpcUrl'],
  MAKER_PRIVATE_KEY: ['identity', 'makerPrivateKey'],
  KEY_STORAGE_METHOD: ['identity', 'keyStorageMethod'],
  KEYSTORE_PATH: ['identity', 'keystorePath'],
  KEYSTORE_PASSWORD: ['identity', 'keystorePassword'],
  KEYSTORE_INTERACTIVE: ['identity', 'keystoreInteractive'],
  AWS_KMS_KEY_ID: ['identity', 'awsKmsKeyId'],
  AWS_REGION: ['identity', 'awsRegion'],
  MAKER_ADDRESS: ['identity', 'makerAddress'],
  MIDNIGHT_ADDRESS: ['contracts', 'midnightAddress'],
  LOAN_ASSET_ADDRESS: ['contracts', 'loanAssetAddress'],
  RATIFIER_ADDRESS: ['contracts', 'ratifierAddress'],
  MARKET_IDS: ['markets', 'allowlist'],
  REFERENCE_MARKET_ID: ['markets', 'referenceMarketId'],
  NATIVE_RESERVE_WEI: ['setup', 'nativeReserveWei'],
  MAXIMUM_LEND_EXPOSURE_ASSETS: ['setup', 'maximumLendExposureAssets'],
  MORPHO_API_BASE_URL: ['apis', 'morphoBaseUrl'],
  ROUTER_API_BASE_URL: ['apis', 'routerBaseUrl'],
  V0_OFFER_GROUP_IDS: ['markets', 'v0OfferGroupIds'],
  REQUEST_TIMEOUT_MS: ['setup', 'requestTimeoutMs'],
  TRANSACTION_RECEIPT_TIMEOUT_MS: ['setup', 'transactionReceiptTimeoutMs']
}

type SignerEnvironmentKey =
  | 'MAKER_PRIVATE_KEY'
  | 'KEY_STORAGE_METHOD'
  | 'KEYSTORE_PATH'
  | 'KEYSTORE_PASSWORD'
  | 'KEYSTORE_INTERACTIVE'
  | 'AWS_KMS_KEY_ID'
  | 'AWS_REGION'

const signerEnvironmentKeys = new Set<SignerEnvironmentKey>([
  'MAKER_PRIVATE_KEY',
  'KEY_STORAGE_METHOD',
  'KEYSTORE_PATH',
  'KEYSTORE_PASSWORD',
  'KEYSTORE_INTERACTIVE',
  'AWS_KMS_KEY_ID',
  'AWS_REGION'
])

const hasSignerEnvironmentOverride = (environment: Environment, key: SignerEnvironmentKey) => {
  const value = environment[key]
  if (value === undefined) return false
  if (key === 'KEYSTORE_PASSWORD') {
    return value.length > 0 || environment.KEYSTORE_INTERACTIVE?.trim() === 'true'
  }
  return value.trim().length > 0
}

const removeOverriddenYamlValues = (input: unknown, environment: Environment) => {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return
  const root = input as Record<string, unknown>
  const environmentMethod = hasSignerEnvironmentOverride(environment, 'KEY_STORAGE_METHOD')
    ? environment.KEY_STORAGE_METHOD!.trim()
    : hasSignerEnvironmentOverride(environment, 'MAKER_PRIVATE_KEY')
      ? 'private-key'
      : hasSignerEnvironmentOverride(environment, 'KEYSTORE_PATH')
        ? 'keystore'
        : hasSignerEnvironmentOverride(environment, 'AWS_KMS_KEY_ID')
          ? 'aws'
          : undefined
  if (environmentMethod !== undefined) {
    const identity = root.identity
    if (typeof identity === 'object' && identity !== null && !Array.isArray(identity)) {
      const retained = new Set(
        environmentMethod === 'private-key'
          ? ['makerAddress', 'makerPrivateKey']
          : environmentMethod === 'keystore'
            ? ['makerAddress', 'keystorePath', 'keystorePassword', 'keystoreInteractive']
            : ['makerAddress', 'awsKmsKeyId', 'awsRegion']
      )
      for (const key of yamlKeys.identity) {
        if (!retained.has(key)) delete (identity as Record<string, unknown>)[key]
      }
    }
  }
  for (const key of environmentKeys) {
    if (environment[key] === undefined) continue
    if (
      signerEnvironmentKeys.has(key as SignerEnvironmentKey) &&
      !hasSignerEnvironmentOverride(environment, key as SignerEnvironmentKey)
    )
      continue
    const path = yamlEnvironmentPaths[key]
    if (!path) continue
    const group = root[path[0]]
    if (typeof group === 'object' && group !== null && !Array.isArray(group)) {
      delete (group as Record<string, unknown>)[path[1]]
    }
  }
  if (environment.BOOTSTRAP_MARKETS !== undefined) delete root.bootstrap
  if (environment.LADDER_MARKETS !== undefined) delete root.ladder
}

const parseMarketsValue = (name: 'BOOTSTRAP_MARKETS' | 'LADDER_MARKETS', text: string) => {
  if (Buffer.byteLength(text, 'utf8') > MAX_CONFIGURATION_SOURCE_BYTES) {
    throw new ConfigValidationError(name, 'too-large', `${name} exceeds the maximum supported size`)
  }
  try {
    JSON.parse(text)
    const document = parseDocument(text, { intAsBigInt: true, uniqueKeys: true })
    if (document.errors.length > 0) throw document.errors
    rejectUnsafeYamlNodes(document)
    return document.toJS({ maxAliasCount: 0 }) as unknown
  } catch {
    throw new ConfigValidationError(
      name,
      'malformed-json',
      `${name} must be a JSON array with unique object keys`
    )
  }
}

const readConfiguration = async (
  path: string,
  explicit: boolean,
  fileSystem: ConfigurationFileSystem
) => {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new ConfigFileError(explicit ? 'unreadable-explicit' : 'unreadable-discovered')
  }

  let handle: ConfigurationFileHandle
  try {
    handle = await fileSystem.open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
    )
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined
    if (explicit && code === 'ENOENT') throw new ConfigFileError('missing-explicit')
    if (!explicit && code === 'ENOENT') return undefined
    throw new ConfigFileError(explicit ? 'unreadable-explicit' : 'unreadable-discovered')
  }

  let result: ReturnType<typeof parseYaml> | undefined
  let operationError: unknown
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) {
      throw new ConfigFileError(explicit ? 'unreadable-explicit' : 'unreadable-discovered')
    }
    if (metadata.size > MAX_CONFIGURATION_SOURCE_BYTES) {
      throw new ConfigFileError('too-large')
    }

    const buffer = Buffer.allocUnsafe(MAX_CONFIGURATION_SOURCE_BYTES + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const readResult = await handle.read(buffer, bytesRead, buffer.length - bytesRead, null)
      if (readResult.bytesRead === 0) break
      bytesRead += readResult.bytesRead
    }
    if (bytesRead > MAX_CONFIGURATION_SOURCE_BYTES) throw new ConfigFileError('too-large')
    result = parseYaml(buffer.subarray(0, bytesRead).toString('utf8'))
  } catch (error) {
    operationError = error
  }

  try {
    await handle.close()
  } catch {
    throw new ConfigFileError(explicit ? 'unreadable-explicit' : 'unreadable-discovered')
  }

  if (operationError instanceof ConfigFileError) throw operationError
  if (operationError !== undefined || result === undefined) {
    throw new ConfigFileError(explicit ? 'unreadable-explicit' : 'unreadable-discovered')
  }
  return result
}

/**
 * Loads the optional YAML source and overlays every explicitly supplied supported environment value.
 * @param environment - Untrusted process environment values, which take precedence over YAML.
 * @param options - Optional explicit YAML path and invocation working directory.
 * @returns The merged unvalidated source and selected path for the shared typed configuration path.
 * @throws `ConfigFileError` for unsafe file paths, file access failures, oversized input, or YAML
 * parser failures; `ConfigValidationError` for oversized or malformed `BOOTSTRAP_MARKETS` JSON.
 * @remarks Opens each candidate once with nonblocking, no-follow semantics, validates and reads that
 * same handle, and falls back only when opening the higher-precedence candidate reports `ENOENT`.
 * Reads configuration only; it does not mutate the environment or configuration files.
 */
export const loadConfigurationSources = async (
  environment: Environment,
  options: ConfigurationLoadOptions = {}
): Promise<ConfigurationSource> => {
  const cwd = options.cwd ?? process.cwd()
  const fileSystem = options.fileSystem ?? nodeFileSystem
  if (options.configPath && !['.yaml', '.yml'].includes(extname(options.configPath))) {
    throw new ConfigFileError('unsupported-extension')
  }
  const explicitPath = options.configPath
    ? isAbsolute(options.configPath)
      ? options.configPath
      : resolve(cwd, options.configPath)
    : undefined
  let path = explicitPath
  let document: ReturnType<typeof parseDocument> | undefined
  if (explicitPath) {
    document = await readConfiguration(explicitPath, true, fileSystem)
  } else {
    for (const name of ['market-making.yaml', 'market-making.yml']) {
      const candidate = join(cwd, name)
      const discovered = await readConfiguration(candidate, false, fileSystem)
      if (discovered !== undefined) {
        path = candidate
        document = discovered
        break
      }
    }
  }

  const raw = document
    ? yamlDocumentValue(document, environment.BOOTSTRAP_MARKETS === undefined)
    : {}
  removeOverriddenYamlValues(raw, environment)
  const readOnly = options.readOnly === true
  const source = yamlSource(raw, readOnly)

  for (const key of environmentKeys) {
    if (readOnly && key !== 'MAKER_ADDRESS' && yamlEnvironmentPaths[key]?.[0] === 'identity')
      continue
    if (
      environment[key] !== undefined &&
      (!signerEnvironmentKeys.has(key as SignerEnvironmentKey) ||
        hasSignerEnvironmentOverride(environment, key as SignerEnvironmentKey))
    )
      source.values[key] = environment[key]
  }
  if (environment.BOOTSTRAP_MARKETS !== undefined) {
    source.bootstrap = parseMarketsValue('BOOTSTRAP_MARKETS', environment.BOOTSTRAP_MARKETS)
  }
  if (environment.LADDER_MARKETS !== undefined) {
    source.ladder = parseMarketsValue('LADDER_MARKETS', environment.LADDER_MARKETS)
  }
  return { ...source, path }
}

/**
 * Converts environment-only input into the shared source representation.
 * @param environment - Untrusted process environment values.
 * @param options - Runtime mode; read-only loading omits the private-key value entirely.
 * @returns An unvalidated source with no selected YAML path.
 * @throws `ConfigValidationError` when `BOOTSTRAP_MARKETS` is oversized or malformed JSON.
 * @remarks Performs no I/O and does not mutate the supplied environment. Read-only output never
 * retains `MAKER_PRIVATE_KEY`, even when the environment contains it.
 */
export const configurationFromEnvironment = (
  environment: Environment,
  options: Pick<ConfigurationLoadOptions, 'readOnly'> = {}
): ConfigurationSource => {
  const values: Record<string, unknown> = {}
  for (const key of environmentKeys) {
    if (
      options.readOnly &&
      key !== 'MAKER_ADDRESS' &&
      yamlEnvironmentPaths[key]?.[0] === 'identity'
    )
      continue
    if (
      environment[key] !== undefined &&
      (!signerEnvironmentKeys.has(key as SignerEnvironmentKey) ||
        hasSignerEnvironmentOverride(environment, key as SignerEnvironmentKey))
    )
      values[key] = environment[key]
  }
  let bootstrap: unknown = []
  if (environment.BOOTSTRAP_MARKETS !== undefined) {
    bootstrap = parseMarketsValue('BOOTSTRAP_MARKETS', environment.BOOTSTRAP_MARKETS)
  }
  const ladder =
    environment.LADDER_MARKETS === undefined
      ? []
      : parseMarketsValue('LADDER_MARKETS', environment.LADDER_MARKETS)
  return { values, bootstrap, ladder }
}
