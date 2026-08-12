import type { Address, Chain, Hex } from 'viem'

import { CrossedBooksResolver } from '@repo/contracts'
import { getAddress, isAddress, isHex, parseGwei } from 'viem'
import { base } from 'viem/chains'

import { DEFAULT_MAX_MATCHES } from '../domain/matching.service'
import { InvalidConfigurationError } from './invalid-configuration.error'
import { parseReadonly } from './readonly.utils'
import { ResolverPrivateKeyRequiredError } from './resolver-private-key-required.error'

const MIDNIGHT = getAddress('0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A')
const PRIVATE_KEY_HEX_LENGTH = 66

type Environment = Record<string, string | undefined>

function required(environment: Environment, name: string) {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

function unsignedDecimal(environment: Environment, name: string, fallback?: string) {
  const value = environment[name]?.trim() || fallback
  if (!value || !/^\d+$/.test(value)) throw new Error(`${name} must be an unsigned decimal integer`)
  return value
}

export class ConfigService {
  /**
   * Loads and validates resolver configuration from environment values.
   * @param environment - Runtime environment; defaults to `process.env`.
   * @returns Immutable configuration with signer material omitted in readonly mode.
   * @throws `InvalidConfigurationError` when readonly mode or its caller is invalid.
   * @throws `ResolverPrivateKeyRequiredError` when write mode has no signing key.
   * @throws `Error` when another required runtime value is invalid.
   * @remarks This method performs no network access and does not retain `RESOLVER_PRIVATE_KEY` when
   * readonly mode is enabled.
   */
  static from(environment: Environment = process.env) {
    const chainId = Number(unsignedDecimal(environment, 'CHAIN_ID'))
    if (chainId !== base.id) {
      throw new Error(`Unsupported CHAIN_ID ${chainId}; supported: ${base.id}`)
    }

    const readOnly = parseReadonly(environment.READONLY)
    const privateKey = readOnly ? undefined : environment.RESOLVER_PRIVATE_KEY?.trim()
    if (!readOnly && !privateKey) throw new ResolverPrivateKeyRequiredError()
    if (
      privateKey !== undefined &&
      (!isHex(privateKey, { strict: true }) || privateKey.length !== PRIVATE_KEY_HEX_LENGTH)
    ) {
      throw new Error('RESOLVER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
    }

    const resolverAddress = environment.RESOLVER_ADDRESS?.trim()
    if (resolverAddress && !isAddress(resolverAddress, { strict: false })) {
      throw new Error('RESOLVER_ADDRESS must be an EVM address')
    }

    const simulationCaller = environment.SIMULATION_CALLER_ADDRESS?.trim()
    if (readOnly && !simulationCaller) {
      throw new InvalidConfigurationError(
        'Readonly mode requires SIMULATION_CALLER_ADDRESS to preserve execution caller semantics'
      )
    }
    if (simulationCaller && !isAddress(simulationCaller, { strict: false })) {
      throw new InvalidConfigurationError('SIMULATION_CALLER_ADDRESS must be an EVM address')
    }

    const apiBaseUrl = (environment.API_BASE_URL?.trim() || 'https://api.morpho.org').replace(
      /\/$/,
      ''
    )
    if (!URL.canParse(apiBaseUrl)) throw new Error('API_BASE_URL must be a valid URL')

    const routerApiBaseUrl = (environment.ROUTER_API_BASE_URL?.trim() || apiBaseUrl).replace(
      /\/$/,
      ''
    )
    if (!URL.canParse(routerApiBaseUrl)) {
      throw new Error('ROUTER_API_BASE_URL must be a valid URL')
    }

    const scanIntervalMs = Number(unsignedDecimal(environment, 'SCAN_INTERVAL_MS', '15000'))
    if (scanIntervalMs <= 0) throw new Error('SCAN_INTERVAL_MS must be a positive integer')

    const minimumProfit = BigInt(unsignedDecimal(environment, 'MIN_PROFIT_ASSETS', '1'))

    const maxMatches = Number(
      unsignedDecimal(environment, 'MAX_MATCHES', String(DEFAULT_MAX_MATCHES))
    )
    if (!Number.isSafeInteger(maxMatches) || maxMatches <= 0) {
      throw new Error('MAX_MATCHES must be a positive safe integer')
    }

    return new ConfigService({
      chain: base,
      midnight: MIDNIGHT,
      resolver: resolverAddress
        ? getAddress(resolverAddress)
        : CrossedBooksResolver.with(MIDNIGHT).address,
      rpcUrl: required(environment, 'RPC_URL'),
      rpcUrlFallback: environment.RPC_URL_FALLBACK?.trim() || undefined,
      readOnly,
      privateKey,
      simulationCaller: simulationCaller ? getAddress(simulationCaller) : undefined,
      apiBaseUrl,
      routerApiBaseUrl,
      scanIntervalMs,
      minimumProfit,
      maxMatches,
      maxFeeWei: parseGwei(environment.MAX_FEE_GWEI?.trim() || '300')
    })
  }

  readonly chainId: number

  private constructor(
    readonly values: {
      chain: Chain
      midnight: Address
      resolver: Address
      rpcUrl: string
      rpcUrlFallback: string | undefined
      readOnly: boolean
      privateKey: Hex | undefined
      simulationCaller: Address | undefined
      apiBaseUrl: string
      routerApiBaseUrl: string
      scanIntervalMs: number
      minimumProfit: bigint
      maxMatches: number
      maxFeeWei: bigint
    }
  ) {
    this.chainId = values.chain.id
  }

  get chain() {
    return this.values.chain
  }

  get midnight() {
    return this.values.midnight
  }

  get resolver() {
    return this.values.resolver
  }

  get rpcUrl() {
    return this.values.rpcUrl
  }

  get rpcUrlFallback() {
    return this.values.rpcUrlFallback
  }

  /** Returns the validated signer key in write mode and `undefined` in readonly mode. */
  get privateKey() {
    return this.values.privateKey
  }

  /** Returns whether transaction signing and submission are disabled. */
  get readOnly() {
    return this.values.readOnly
  }

  /** Returns the validated execution-equivalent caller used only for keyless simulation. */
  get simulationCaller() {
    return this.values.simulationCaller
  }

  get apiBaseUrl() {
    return this.values.apiBaseUrl
  }

  get routerApiBaseUrl() {
    return this.values.routerApiBaseUrl
  }

  get scanIntervalMs() {
    return this.values.scanIntervalMs
  }

  get minimumProfit() {
    return this.values.minimumProfit
  }

  get maxMatches() {
    return this.values.maxMatches
  }

  get maxFeeWei() {
    return this.values.maxFeeWei
  }
}
