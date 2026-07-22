import type { Address, Chain, Hex } from 'viem'

import { CrossedBooksResolver } from '@repo/contracts'
import { getAddress, isAddress, isHex, parseGwei } from 'viem'
import { base } from 'viem/chains'

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
  static from(environment: Environment = Bun.env) {
    const chainId = Number(unsignedDecimal(environment, 'CHAIN_ID'))
    if (chainId !== base.id) {
      throw new Error(`Unsupported CHAIN_ID ${chainId}; supported: ${base.id}`)
    }

    const privateKey = required(environment, 'RESOLVER_PRIVATE_KEY')
    if (!isHex(privateKey, { strict: true }) || privateKey.length !== PRIVATE_KEY_HEX_LENGTH) {
      throw new Error('RESOLVER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
    }

    const resolverAddress = environment.RESOLVER_ADDRESS?.trim()
    if (resolverAddress && !isAddress(resolverAddress, { strict: false })) {
      throw new Error('RESOLVER_ADDRESS must be an EVM address')
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

    return new ConfigService({
      chain: base,
      midnight: MIDNIGHT,
      resolver: resolverAddress
        ? getAddress(resolverAddress)
        : CrossedBooksResolver.with(MIDNIGHT).address,
      rpcUrl: required(environment, 'RPC_URL'),
      rpcUrlFallback: environment.RPC_URL_FALLBACK?.trim() || undefined,
      privateKey,
      apiBaseUrl,
      routerApiBaseUrl,
      scanIntervalMs,
      minimumProfit,
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
      privateKey: Hex
      apiBaseUrl: string
      routerApiBaseUrl: string
      scanIntervalMs: number
      minimumProfit: bigint
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

  get privateKey() {
    return this.values.privateKey
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

  get maxFeeWei() {
    return this.values.maxFeeWei
  }
}
