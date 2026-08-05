import type { Hex } from 'viem'

import { inspect } from 'node:util'

import type { SetupCheckConfig } from '../application/setup/setup-check.service'
import type { BootstrapConfig } from '../domain/bootstrap/position-bootstrap'
import type { LadderConfig } from '../domain/ladder/ladder'
import type { ConfigurationLoadOptions, ConfigurationSource } from './config-source.utils'
import type { Environment } from './config.utils'
import type { MakerIdentity } from './signer-identity.utils'

import { configurationFromEnvironment, loadConfigurationSources } from './config-source.utils'
import { ConfigValidationError } from './config-validation.error'
import {
  addressValue,
  bytes32Value,
  chainIdValue,
  requestTimeoutValue,
  transactionReceiptTimeoutValue,
  unsignedBigIntValue,
  urlValue
} from './config.utils'
import { bootstrapConfigsValue, hexListValue, ladderConfigsValue } from './market-collections'
import { signerIdentity } from './signer-identity.utils'

export type { MakerIdentity } from './signer-identity.utils'

/** Immutable, validated market-making runtime configuration loaded from YAML and environment values. */
export class ConfigService {
  /**
   * Parses the existing environment-only representation through the shared validation path.
   * @param environment - Environment map; defaults to `Bun.env` at the runtime boundary.
   * @param options - Runtime mode; read-only operation accepts only the configured maker address.
   * @returns An immutable configuration with checksummed addresses and narrowed IDs.
   * @throws `ConfigValidationError` on missing, malformed, duplicated, unsupported, or out-of-range
   * values; rejected values and secrets are not retained by the error.
   */
  static from(
    environment: Environment = Bun.env,
    options: Pick<ConfigurationLoadOptions, 'readOnly'> = {}
  ) {
    return ConfigService.fromSource(
      configurationFromEnvironment(environment, options),
      options.readOnly
    )
  }

  /**
   * Loads an explicit or discovered YAML file, overlays environment values, and validates once.
   * @param environment - Environment values; supplied keys always override corresponding YAML.
   * @param options - Optional path, invocation directory, file reader, and identity-loading mode.
   * @returns A single immutable configuration shared by setup and bootstrap consumers.
   * @throws `ConfigFileError` or `ConfigValidationError` with no rejected values attached.
   * @remarks Without an explicit path, discovery securely opens `market-making.yaml` before
   * `market-making.yml` in `options.cwd` (or `process.cwd()`). Only an absent higher-precedence path
   * permits fallback; unsafe entries fail closed. No file means env-only loading. Read-only mode
   * omits YAML and environment private-key values before typed validation.
   */
  static async load(environment: Environment = process.env, options: ConfigurationLoadOptions = {}) {
    const source = await loadConfigurationSources(environment, options)
    const declaredMethod = source.values.KEY_STORAGE_METHOD?.toString().trim()
    const keystorePath = source.values.KEYSTORE_PATH?.toString().trim()
    const interactive = source.values.KEYSTORE_INTERACTIVE?.toString().trim()
    if (
      !options.readOnly &&
      (declaredMethod === 'keystore' || (!declaredMethod && keystorePath)) &&
      interactive === 'true' &&
      (source.values.KEYSTORE_PASSWORD === undefined || source.values.KEYSTORE_PASSWORD === '')
    ) {
      if (!options.readPassword) {
        throw new ConfigValidationError(
          'KEYSTORE_PASSWORD',
          'interactive-unavailable',
          'Interactive keystore password input is unavailable'
        )
      }
      source.values.KEYSTORE_PASSWORD = await options.readPassword()
      source.values.KEYSTORE_INTERACTIVE = 'false'
    }
    return ConfigService.fromSource(source, options.readOnly)
  }

  private static fromSource(source: ConfigurationSource, readOnly = false) {
    const environment = source.values as Environment
    const chainId = chainIdValue(environment)

    const maker = addressValue(environment, 'MAKER_ADDRESS')
    const identity: MakerIdentity = readOnly
      ? { readOnly: true, maker }
      : signerIdentity(environment, maker)

    return new ConfigService({
      identity,
      setup: {
        chainId,
        maker,
        midnight: addressValue(environment, 'MIDNIGHT_ADDRESS'),
        nativeReserve: unsignedBigIntValue(environment, 'NATIVE_RESERVE_WEI'),
        loanAsset: addressValue(environment, 'LOAN_ASSET_ADDRESS'),
        maximumLendExposure: unsignedBigIntValue(environment, 'MAXIMUM_LEND_EXPOSURE_ASSETS'),
        ratifier: addressValue(environment, 'RATIFIER_ADDRESS'),
        marketIds: hexListValue(environment, 'MARKET_IDS', false),
        referenceMarketId: bytes32Value(environment, 'REFERENCE_MARKET_ID')
      },
      rpcUrl: urlValue(environment, 'RPC_URL'),
      referenceRpcUrl: urlValue(environment, 'REFERENCE_RPC_URL'),
      morphoApiBaseUrl: urlValue(environment, 'MORPHO_API_BASE_URL'),
      routerApiBaseUrl: urlValue(environment, 'ROUTER_API_BASE_URL'),
      v0OfferGroupIds: hexListValue(environment, 'V0_OFFER_GROUP_IDS', false),
      requestTimeoutMs: requestTimeoutValue(environment),
      transactionReceiptTimeoutMs: transactionReceiptTimeoutValue(environment),
      bootstrap: bootstrapConfigsValue(
        source.bootstrap,
        hexListValue(environment, 'MARKET_IDS', false)
      ),
      ladder: ladderConfigsValue(source.ladder, hexListValue(environment, 'MARKET_IDS', false))
    })
  }

  private constructor(
    readonly values: {
      identity: MakerIdentity
      setup: SetupCheckConfig
      rpcUrl: string
      referenceRpcUrl: string
      morphoApiBaseUrl: string
      routerApiBaseUrl: string
      v0OfferGroupIds: readonly Hex[]
      requestTimeoutMs: number
      transactionReceiptTimeoutMs: number
      bootstrap: readonly BootstrapConfig[]
      ladder: readonly LadderConfig[]
    }
  ) {}

  /** Exposes the selected validated maker identity. @returns Address-only identity in read-only mode, otherwise the signer identity. */
  get identity() {
    return this.values.identity
  }

  /** Reports whether mutation authority is disabled. @returns `true` when the CLI selected read-only mode. */
  get readOnly() {
    return this.values.identity.readOnly
  }

  /** Exposes validated readiness requirements. @returns The complete validated requirements consumed by `SetupCheckService`. */
  get setup() {
    return this.values.setup
  }

  /** Exposes the redaction-sensitive current RPC endpoint. @returns Current-state Base RPC URL; callers must not include it in reports or logs. */
  get rpcUrl() {
    return this.values.rpcUrl
  }

  /** Exposes the redaction-sensitive archive RPC endpoint. @returns Archive-capable Base RPC URL; callers must keep it out of errors and reports. */
  get referenceRpcUrl() {
    return this.values.referenceRpcUrl
  }

  /** Exposes the maker secret only to write-enabled composition code. @returns Maker private key, or `undefined` in read-only mode; callers must never log it. */
  get privateKey() {
    return !this.values.identity.readOnly && this.values.identity.method === 'private-key'
      ? this.values.identity.privateKey
      : undefined
  }

  /** Exposes the effective validated signing backend without exposing credentials. @returns Selected signing method, or `undefined` in read-only mode. */
  get keyStorageMethod() {
    return this.values.identity.readOnly ? undefined : this.values.identity.method
  }

  /** Prevents private keys and keystore passwords from entering JSON logs. @returns Redacted signing method and read-only state. */
  toJSON() {
    return { keyStorageMethod: this.keyStorageMethod, readOnly: this.readOnly }
  }

  /** Prevents private keys and keystore passwords from entering diagnostic inspection. @returns Redacted diagnostic representation. */
  [inspect.custom]() {
    return `ConfigService ${inspect(this.toJSON())}`
  }

  /** Exposes the validated Morpho API origin. @returns Validated Morpho API origin; reports identify it only as `morpho-api`. */
  get morphoApiBaseUrl() {
    return this.values.morphoApiBaseUrl
  }

  /** Exposes the validated Router API origin. @returns Validated Router API origin; reports identify it only as `router-api`. */
  get routerApiBaseUrl() {
    return this.values.routerApiBaseUrl
  }

  /** Exposes strategy-owned offer groups. @returns Strategy-owned V0 offer-group IDs used to reject unknown namespaces. */
  get v0OfferGroupIds() {
    return this.values.v0OfferGroupIds
  }

  /** Exposes the aggregate provider timeout. @returns Bounded provider timeout in milliseconds, between 1 and 120,000 inclusive. */
  get requestTimeoutMs() {
    return this.values.requestTimeoutMs
  }

  /** Exposes the post-submission confirmation deadline. @returns Bounded receipt timeout in milliseconds, between 1 and 900,000 inclusive. */
  get transactionReceiptTimeoutMs() {
    return this.values.transactionReceiptTimeoutMs
  }

  /** Exposes position-bootstrap settings. @returns The validated ordered market list; `BOOTSTRAP_MARKETS` replaces YAML `bootstrap` as a whole. */
  get bootstrap() {
    return this.values.bootstrap
  }

  /** Exposes ladder settings. @returns Validated ordered markets; `LADDER_MARKETS` replaces YAML `ladder` as a whole. */
  get ladder() {
    return this.values.ladder
  }
}
