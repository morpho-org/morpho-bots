import type { Address, Hex } from 'viem'

import { getAddress, isAddress, isHex } from 'viem'
import { base } from 'viem/chains'

import type { SetupCheckConfig } from '../application/setup-check.service'

type Environment = Record<string, string | undefined>

const PRIVATE_KEY_HEX_LENGTH = 66
const BYTES_32_HEX_LENGTH = 66
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const MAXIMUM_REQUEST_TIMEOUT_MS = 120_000

function required(environment: Environment, name: string) {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

function address(environment: Environment, name: string): Address {
  const value = required(environment, name)
  if (!isAddress(value, { strict: false })) throw new Error(`${name} must be an EVM address`)
  return getAddress(value)
}

function unsignedBigInt(environment: Environment, name: string) {
  const value = required(environment, name)
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an unsigned decimal integer`)
  return BigInt(value)
}

function requestTimeout(environment: Environment) {
  const raw = environment.REQUEST_TIMEOUT_MS?.trim() ?? String(DEFAULT_REQUEST_TIMEOUT_MS)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_REQUEST_TIMEOUT_MS) {
    throw new Error(`REQUEST_TIMEOUT_MS must be between 1 and ${MAXIMUM_REQUEST_TIMEOUT_MS}`)
  }
  return value
}

function hexList(environment: Environment, name: string, requiredList: boolean): Hex[] {
  const raw = requiredList ? required(environment, name) : (environment[name]?.trim() ?? '')
  const values = raw
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  if (requiredList && values.length === 0)
    throw new Error(`${name} must contain at least one market id`)
  if (
    values.some(value => !isHex(value, { strict: true }) || value.length !== BYTES_32_HEX_LENGTH)
  ) {
    throw new Error(`${name} must contain 0x-prefixed 32-byte hex values`)
  }
  if (new Set(values).size !== values.length) throw new Error(`${name} must not contain duplicates`)
  return values as Hex[]
}

function bytes32(environment: Environment, name: string): Hex {
  const value = required(environment, name)
  if (!isHex(value, { strict: true }) || value.length !== BYTES_32_HEX_LENGTH) {
    throw new Error(`${name} must be a 0x-prefixed 32-byte hex value`)
  }
  return value
}

function url(environment: Environment, name: string) {
  const value = required(environment, name).replace(/\/$/, '')
  if (!URL.canParse(value)) throw new Error(`${name} must be a valid URL`)
  return value
}

/** Immutable, validated market-making runtime configuration loaded from environment values. */
export class ConfigService {
  /**
   * Parses and validates every setup-check environment variable before provider access begins.
   * @param environment - Environment map; defaults to `Bun.env` at the runtime boundary.
   * @returns An immutable configuration with checksummed addresses and narrowed IDs.
   * @throws On missing, malformed, duplicated, unsupported, or out-of-range values.
   * @remarks Read-only apart from reading the supplied map; values and secrets are never logged.
   */
  static from(environment: Environment = Bun.env) {
    const chainId = Number(required(environment, 'CHAIN_ID'))
    if (chainId !== base.id)
      throw new Error(`Unsupported CHAIN_ID ${chainId}; supported: ${base.id}`)

    const privateKey = required(environment, 'MAKER_PRIVATE_KEY')
    if (!isHex(privateKey, { strict: true }) || privateKey.length !== PRIVATE_KEY_HEX_LENGTH) {
      throw new Error('MAKER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
    }

    return new ConfigService({
      setup: {
        chainId,
        maker: address(environment, 'MAKER_ADDRESS'),
        midnight: address(environment, 'MIDNIGHT_ADDRESS'),
        nativeReserve: unsignedBigInt(environment, 'NATIVE_RESERVE_WEI'),
        loanAsset: address(environment, 'LOAN_ASSET_ADDRESS'),
        maximumLendExposure: unsignedBigInt(environment, 'MAXIMUM_LEND_EXPOSURE_ASSETS'),
        ratifier: address(environment, 'RATIFIER_ADDRESS'),
        marketIds: hexList(environment, 'MARKET_IDS', true),
        referenceMarketId: bytes32(environment, 'REFERENCE_MARKET_ID')
      },
      rpcUrl: url(environment, 'RPC_URL'),
      referenceRpcUrl: url(environment, 'REFERENCE_RPC_URL'),
      privateKey,
      morphoApiBaseUrl: url(environment, 'MORPHO_API_BASE_URL'),
      routerApiBaseUrl: url(environment, 'ROUTER_API_BASE_URL'),
      v0OfferGroupIds: hexList(environment, 'V0_OFFER_GROUP_IDS', false),
      requestTimeoutMs: requestTimeout(environment)
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

  /** @returns The complete validated requirements consumed by `SetupCheckService`. */
  get setup() {
    return this.values.setup
  }

  /** @returns Current-state Base RPC URL; callers must not include it in reports or logs. */
  get rpcUrl() {
    return this.values.rpcUrl
  }

  /** @returns Archive-capable Base RPC URL; callers must keep it out of errors and reports. */
  get referenceRpcUrl() {
    return this.values.referenceRpcUrl
  }

  /** @returns Maker private key for local address derivation; callers must never log it. */
  get privateKey() {
    return this.values.privateKey
  }

  /** @returns Validated Morpho API origin; reports identify it only as `morpho-api`. */
  get morphoApiBaseUrl() {
    return this.values.morphoApiBaseUrl
  }

  /** @returns Validated Router API origin; reports identify it only as `router-api`. */
  get routerApiBaseUrl() {
    return this.values.routerApiBaseUrl
  }

  /** @returns Strategy-owned V0 offer-group IDs used to reject unknown namespaces. */
  get v0OfferGroupIds() {
    return this.values.v0OfferGroupIds
  }

  /** @returns Bounded provider timeout in milliseconds, between 1 and 120,000 inclusive. */
  get requestTimeoutMs() {
    return this.values.requestTimeoutMs
  }
}
