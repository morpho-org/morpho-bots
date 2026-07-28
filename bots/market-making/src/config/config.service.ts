import type { Hex } from 'viem'

import { isHex, size } from 'viem'
import { base } from 'viem/chains'

import type { SetupCheckConfig } from '../application/setup-check.service'
import type { Environment } from './config.utils'

import { ConfigValidationError } from './config-validation.error'
import {
  addressValue,
  bytes32Value,
  hexListValue,
  requestTimeoutValue,
  requiredValue,
  unsignedBigIntValue,
  urlValue
} from './config.utils'

/** Immutable, validated market-making runtime configuration loaded from environment values. */
export class ConfigService {
  /**
   * Parses and validates every setup-check environment variable before provider access begins.
   * @param environment - Environment map; defaults to `Bun.env` at the runtime boundary.
   * @returns An immutable configuration with checksummed addresses and narrowed IDs.
   * @throws `ConfigValidationError` on missing, malformed, duplicated, unsupported, or out-of-range
   * values; rejected values and secrets are not retained by the error.
   * @remarks Read-only apart from reading the supplied map; values and secrets are never logged.
   */
  static from(environment: Environment = Bun.env) {
    const chainId = Number(requiredValue(environment, 'CHAIN_ID'))
    if (chainId !== base.id)
      throw new ConfigValidationError(
        'CHAIN_ID',
        'unsupported-chain',
        `Unsupported CHAIN_ID ${chainId}; supported: ${base.id}`
      )

    const privateKey = requiredValue(environment, 'MAKER_PRIVATE_KEY')
    if (!isHex(privateKey, { strict: true }) || size(privateKey) !== 32) {
      throw new ConfigValidationError(
        'MAKER_PRIVATE_KEY',
        'invalid-bytes32',
        'MAKER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string'
      )
    }

    return new ConfigService({
      setup: {
        chainId,
        maker: addressValue(environment, 'MAKER_ADDRESS'),
        midnight: addressValue(environment, 'MIDNIGHT_ADDRESS'),
        nativeReserve: unsignedBigIntValue(environment, 'NATIVE_RESERVE_WEI'),
        loanAsset: addressValue(environment, 'LOAN_ASSET_ADDRESS'),
        maximumLendExposure: unsignedBigIntValue(environment, 'MAXIMUM_LEND_EXPOSURE_ASSETS'),
        ratifier: addressValue(environment, 'RATIFIER_ADDRESS'),
        marketIds: hexListValue(environment, 'MARKET_IDS', true),
        referenceMarketId: bytes32Value(environment, 'REFERENCE_MARKET_ID')
      },
      rpcUrl: urlValue(environment, 'RPC_URL'),
      referenceRpcUrl: urlValue(environment, 'REFERENCE_RPC_URL'),
      privateKey,
      morphoApiBaseUrl: urlValue(environment, 'MORPHO_API_BASE_URL'),
      routerApiBaseUrl: urlValue(environment, 'ROUTER_API_BASE_URL'),
      v0OfferGroupIds: hexListValue(environment, 'V0_OFFER_GROUP_IDS', false),
      requestTimeoutMs: requestTimeoutValue(environment)
    })
  }

  private constructor(
    readonly values: {
      setup: SetupCheckConfig
      rpcUrl: string
      referenceRpcUrl: string
      privateKey: Hex
      morphoApiBaseUrl: string
      routerApiBaseUrl: string
      v0OfferGroupIds: readonly Hex[]
      requestTimeoutMs: number
    }
  ) {}

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

  /** Exposes the maker secret only to composition code. @returns Maker private key for local address derivation; callers must never log it. */
  get privateKey() {
    return this.values.privateKey
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
}
