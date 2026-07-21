import type { Address, Chain, Hex } from 'viem'

import { CrossedBooksResolver } from '@repo/contracts'
import { getAddress, isAddress, isHex, parseGwei } from 'viem'
import { base } from 'viem/chains'
const MIDNIGHT = getAddress('0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A')
type Env = Record<string, string | undefined>
type Config = {
  chain: Chain
  chainId: number
  midnight: Address
  resolver: Address
  rpcUrl: string
  rpcUrlFallback: string | undefined
  privateKey: Hex
  apiBaseUrl: string
  scanIntervalMs: number
  minimumProfit: bigint
  maxFeeWei: bigint
}
function required(env: Env, name: string) {
  const value = env[name]?.trim()
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}
export function loadConfig(env: Env = Bun.env): Config {
  const chainIdRaw = required(env, 'CHAIN_ID')
  if (!/^\d+$/.test(chainIdRaw)) throw new Error('CHAIN_ID must be an unsigned decimal integer')
  const chainId = Number(chainIdRaw)
  if (chainId !== base.id) throw new Error(`Unsupported CHAIN_ID ${chainId}; supported: ${base.id}`)
  const privateKey = required(env, 'RESOLVER_PRIVATE_KEY')
  if (!isHex(privateKey, { strict: true }) || privateKey.length !== 66)
    throw new Error('RESOLVER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string')
  const rawAddress = env.RESOLVER_ADDRESS?.trim()
  if (rawAddress && !isAddress(rawAddress, { strict: false }))
    throw new Error('RESOLVER_ADDRESS must be an EVM address')
  const apiBaseUrl = (env.API_BASE_URL?.trim() || 'https://api.morpho.org').replace(/\/$/, '')
  if (!URL.canParse(apiBaseUrl)) throw new Error('API_BASE_URL must be a valid URL')
  const scanRaw = env.SCAN_INTERVAL_MS?.trim() || '15000'
  if (!/^\d+$/.test(scanRaw) || Number(scanRaw) <= 0)
    throw new Error('SCAN_INTERVAL_MS must be a positive integer')
  const profitRaw = env.MIN_PROFIT_ASSETS?.trim() || '1'
  if (!/^\d+$/.test(profitRaw))
    throw new Error('MIN_PROFIT_ASSETS must be a uint256 decimal string')
  return {
    chain: base,
    chainId,
    midnight: MIDNIGHT,
    resolver: rawAddress ? getAddress(rawAddress) : CrossedBooksResolver.with(MIDNIGHT).address,
    rpcUrl: required(env, 'RPC_URL'),
    rpcUrlFallback: env.RPC_URL_FALLBACK?.trim() || undefined,
    privateKey,
    apiBaseUrl,
    scanIntervalMs: Number(scanRaw),
    minimumProfit: BigInt(profitRaw),
    maxFeeWei: parseGwei(env.MAX_FEE_GWEI?.trim() || '300')
  }
}
