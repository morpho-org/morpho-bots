import type { Address, Hex } from 'viem'

import { Executor } from '@repo/contracts'
import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'

import type { ChainConfig } from '../src/config'

import { loadLiquidateConfig, loadUnhealthyPositionsConfig } from '../src/config'

const MIDNIGHT = '0x1111111111111111111111111111111111111111' as Address
const EXECUTOOOR = '0x3333333333333333333333333333333333333333'
const COLLATERAL = '0x4444444444444444444444444444444444444444'
const PRIVATE_KEY = `0x${'a'.repeat(64)}`
const DERIVED = privateKeyToAccount(PRIVATE_KEY as Hex).address

const CHAIN_MAP: Record<number, ChainConfig> = {
  [mainnet.id]: { chain: mainnet, midnight: MIDNIGHT }
}

const deps = { chainMap: CHAIN_MAP }

// The per-operation loaders replaced the monolithic `loadConfig`: `unhealthy-positions` reads chain
// + Executor + discovery + market whitelist (secret-free), while `liquidate` reads venues + probe +
// quoting + the operator EOA. The queue reads the signer key + broadcast endpoint + fee ceiling. A
// venue key is present so `liquidate` is armed rather than bad-debt-only.
function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    CHAIN_ID: String(mainnet.id),
    RPC_URL: 'https://rpc.example',
    LIQUIDATOR_PRIVATE_KEY: PRIVATE_KEY,
    LIQUIDATOR_ADDRESS: DERIVED,
    EXECUTOOOR_ADDRESS: EXECUTOOOR,
    ZEROX_API_KEY: 'zerox-key',
    ...overrides
  }
}

describe('loadUnhealthyPositionsConfig', () => {
  it('parses chain, Executor, discovery, and market whitelist with defaults', () => {
    const config = loadUnhealthyPositionsConfig(baseEnv(), deps)
    expect(config.chainId).toBe(mainnet.id)
    expect(config.chain).toBe(mainnet)
    expect(config.midnight).toBe(MIDNIGHT)
    expect(config.rpcUrl).toBe('https://rpc.example')
    expect(config.logLevel).toBe('info')
    expect(config.executooorAddress).toBe(getAddress(EXECUTOOOR))
    expect(config.discovery.apiUrl).toBe(
      'https://api.morpho.org/markets/midnight/liquidation-candidates'
    )
    expect(config.discovery.healthFactorLte).toBe(1.02)
    expect(config.markets.apiUrl).toBe('https://api.morpho.org/v0/midnight/markets')
    expect(config.markets.refreshMs).toBe(60_000)
  })

  it('resolves the built-in Base chain config from the default map', () => {
    const config = loadUnhealthyPositionsConfig(baseEnv({ CHAIN_ID: '8453' }))
    expect(config.chainId).toBe(8453)
    expect(config.midnight).toBe(getAddress('0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A'))
  })

  it('is loadable WITHOUT the signer private key (the source is secret-free)', () => {
    const config = loadUnhealthyPositionsConfig(
      baseEnv({ LIQUIDATOR_PRIVATE_KEY: undefined }),
      deps
    )
    expect(config.chainId).toBe(mainnet.id)
  })

  it('honors LOG_LEVEL overrides', () => {
    const config = loadUnhealthyPositionsConfig(baseEnv({ LOG_LEVEL: 'debug' }), deps)
    expect(config.logLevel).toBe('debug')
  })

  it('throws when a required var is missing', () => {
    expect(() => loadUnhealthyPositionsConfig(baseEnv({ RPC_URL: undefined }), deps)).toThrow(
      /Missing required env var: RPC_URL/
    )
  })

  it('throws on an unknown CHAIN_ID', () => {
    expect(() => loadUnhealthyPositionsConfig(baseEnv({ CHAIN_ID: '999999' }), deps)).toThrow(
      /Unsupported CHAIN_ID 999999/
    )
  })

  it('throws on a non-decimal CHAIN_ID', () => {
    expect(() => loadUnhealthyPositionsConfig(baseEnv({ CHAIN_ID: '0x1' }), deps)).toThrow(
      /CHAIN_ID must be a positive integer/
    )
  })

  it('normalizes EXECUTOOOR_ADDRESS to its EIP-55 checksum', () => {
    const lower = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
    const config = loadUnhealthyPositionsConfig(baseEnv({ EXECUTOOOR_ADDRESS: lower }), deps)
    expect(config.executooorAddress).toBe(getAddress(lower))
    expect(config.executooorAddress).not.toBe(lower)
  })

  it('defaults to the Executor deterministic CREATE2 address when EXECUTOOOR_ADDRESS is unset', () => {
    const config = loadUnhealthyPositionsConfig(baseEnv({ EXECUTOOOR_ADDRESS: undefined }), deps)
    expect(config.executooorAddress).toBe(getAddress(Executor.with().address))
  })

  it('throws on an invalid EXECUTOOOR_ADDRESS', () => {
    expect(() =>
      loadUnhealthyPositionsConfig(baseEnv({ EXECUTOOOR_ADDRESS: 'not-an-address' }), deps)
    ).toThrow(/not a valid address/)
  })

  it('throws on an unknown LOG_LEVEL', () => {
    expect(() => loadUnhealthyPositionsConfig(baseEnv({ LOG_LEVEL: 'verbose' }), deps)).toThrow(
      /LOG_LEVEL must be one of/
    )
  })

  it('overrides the markets API URL and refresh interval from env', () => {
    const config = loadUnhealthyPositionsConfig(
      baseEnv({ MARKETS_API_URL: 'https://custom.example/markets', MARKETS_REFRESH_MS: '5000' }),
      deps
    )
    expect(config.markets.apiUrl).toBe('https://custom.example/markets')
    expect(config.markets.refreshMs).toBe(5000)
  })

  it('throws on a malformed MARKETS_API_URL', () => {
    expect(() =>
      loadUnhealthyPositionsConfig(baseEnv({ MARKETS_API_URL: 'not a url' }), deps)
    ).toThrow(/MARKETS_API_URL is not a valid URL/)
  })

  it('overrides the discovery endpoint and health-factor cutoff from env', () => {
    const config = loadUnhealthyPositionsConfig(
      baseEnv({
        LIQUIDATION_CANDIDATES_API_URL: 'https://custom.example/candidates',
        HEALTH_FACTOR_LTE: '1.1'
      }),
      deps
    )
    expect(config.discovery.apiUrl).toBe('https://custom.example/candidates')
    expect(config.discovery.healthFactorLte).toBe(1.1)
  })

  it('throws on a malformed LIQUIDATION_CANDIDATES_API_URL (fail loud at startup)', () => {
    expect(() =>
      loadUnhealthyPositionsConfig(baseEnv({ LIQUIDATION_CANDIDATES_API_URL: 'not a url' }), deps)
    ).toThrow(/LIQUIDATION_CANDIDATES_API_URL is not a valid URL/)
  })

  it('throws on a HEALTH_FACTOR_LTE below the 1.0 floor', () => {
    expect(() => loadUnhealthyPositionsConfig(baseEnv({ HEALTH_FACTOR_LTE: '0.9' }), deps)).toThrow(
      /HEALTH_FACTOR_LTE must be >= 1/
    )
  })
})

describe('loadLiquidateConfig', () => {
  it('infers enabled venues and applies routing + probe + quoting defaults', () => {
    const config = loadLiquidateConfig(baseEnv(), deps)
    expect(config.liquidatorAddress).toBe(DERIVED)

    expect(config.venues.enabled).toEqual(['0x'])
    expect(config.venues.slippageBps).toBe(100)
    expect(config.venues.excludeCollaterals).toEqual([])
    expect(config.venues.zeroxBaseUrl).toBeUndefined()

    expect(config.probe.staleMs).toBe(600_000)
    expect(config.probe.httpRps).toBe(1)
    expect(config.probe.ladderWholeTokens).toEqual(['0.01', '0.1', '1', '10', '100'])

    expect(config.quoting.quoteTimeoutMs).toBe(2500)
    expect(config.quoting.httpRps).toBe(2)
    expect(config.quoting.maxRouteImpactBps).toBe(500)
    expect(config.quoting.pendleSlippageBps).toBe(50)
    expect(config.quoting.seizeCapMarginBps).toBe(30)
  })

  it('enables 1inch when only ONEINCH_API_KEY is set', () => {
    const config = loadLiquidateConfig(
      baseEnv({ ZEROX_API_KEY: undefined, ONEINCH_API_KEY: 'k' }),
      deps
    )
    expect(config.venues.enabled).toEqual(['1inch'])
  })

  it('enables both venues when both keys are set', () => {
    const config = loadLiquidateConfig(baseEnv({ ONEINCH_API_KEY: 'k' }), deps)
    expect(config.venues.enabled).toEqual(['0x', '1inch'])
  })

  it('puts lifi first in the default order when LIFI_API_KEY is set', () => {
    const config = loadLiquidateConfig(baseEnv({ LIFI_API_KEY: 'k', ONEINCH_API_KEY: 'k' }), deps)
    expect(config.venues.enabled).toEqual(['lifi', '0x', '1inch'])
  })

  it('reads an optional LIFI_BASE_URL override', () => {
    const config = loadLiquidateConfig(
      baseEnv({ LIFI_API_KEY: 'k', LIFI_BASE_URL: 'https://staging.li.quest/v1' }),
      deps
    )
    expect(config.venues.lifiBaseUrl).toBe('https://staging.li.quest/v1')
  })

  it('enables lifi keyless via ENABLE_LIFI=true (no LIFI_API_KEY)', () => {
    const config = loadLiquidateConfig(baseEnv({ ENABLE_LIFI: 'true' }), deps)
    expect(config.venues.enabled).toEqual(['lifi', '0x'])
  })

  it('boots on ENABLE_LIFI alone with no venue API keys set', () => {
    const config = loadLiquidateConfig(
      baseEnv({ ZEROX_API_KEY: undefined, ENABLE_LIFI: 'true' }),
      deps
    )
    expect(config.venues.enabled).toEqual(['lifi'])
  })

  it('throws when no venue is enabled and bad-debt-only is not opted into', () => {
    expect(() => loadLiquidateConfig(baseEnv({ ZEROX_API_KEY: undefined }), deps)).toThrow(
      /No venues enabled/
    )
  })

  it('boots in bad-debt-only mode (no enabled venues) when ALLOW_BAD_DEBT_ONLY=true', () => {
    const config = loadLiquidateConfig(
      baseEnv({ ZEROX_API_KEY: undefined, ALLOW_BAD_DEBT_ONLY: 'true' }),
      deps
    )
    expect(config.venues.enabled).toEqual([])
  })

  it('throws on a non-boolean ALLOW_BAD_DEBT_ONLY', () => {
    expect(() => loadLiquidateConfig(baseEnv({ ALLOW_BAD_DEBT_ONLY: 'yes' }), deps)).toThrow(
      /ALLOW_BAD_DEBT_ONLY must be "true" or "false"/
    )
  })

  it('parses SLIPPAGE_BPS and rejects an out-of-range value', () => {
    expect(loadLiquidateConfig(baseEnv({ SLIPPAGE_BPS: '250' }), deps).venues.slippageBps).toBe(250)
    expect(() => loadLiquidateConfig(baseEnv({ SLIPPAGE_BPS: '20000' }), deps)).toThrow(
      /SLIPPAGE_BPS must be <= 10000/
    )
  })

  it('parses EXCLUDE_COLLATERALS into checksummed addresses and rejects a malformed entry', () => {
    const config = loadLiquidateConfig(
      baseEnv({ EXCLUDE_COLLATERALS: `${COLLATERAL}, ${MIDNIGHT}` }),
      deps
    )
    expect(config.venues.excludeCollaterals).toEqual([getAddress(COLLATERAL), getAddress(MIDNIGHT)])
    expect(() => loadLiquidateConfig(baseEnv({ EXCLUDE_COLLATERALS: 'nope' }), deps)).toThrow(
      /EXCLUDE_COLLATERALS contains an invalid address/
    )
  })

  it('rejects a malformed ZEROX_BASE_URL', () => {
    expect(() => loadLiquidateConfig(baseEnv({ ZEROX_BASE_URL: 'not a url' }), deps)).toThrow(
      /ZEROX_BASE_URL is not a valid URL/
    )
  })

  it('parses PROBE_LADDER into raw string sizes and rejects a malformed element', () => {
    expect(
      loadLiquidateConfig(baseEnv({ PROBE_LADDER: '0.5, 5, 50' }), deps).probe.ladderWholeTokens
    ).toEqual(['0.5', '5', '50'])
    expect(() => loadLiquidateConfig(baseEnv({ PROBE_LADDER: '1,0,10' }), deps)).toThrow(
      /PROBE_LADDER must be comma-separated positive numbers/
    )
  })

  it('parses probe cadence knobs from env', () => {
    const config = loadLiquidateConfig(
      baseEnv({ PROBE_STALE_MS: '30000', PROBE_HTTP_RPS: '2' }),
      deps
    )
    expect(config.probe.staleMs).toBe(30_000)
    expect(config.probe.httpRps).toBe(2)
  })

  it('parses quoting tunables from env, overriding defaults', () => {
    const config = loadLiquidateConfig(
      baseEnv({
        HTTP_RPS: '1',
        MAX_ROUTE_IMPACT_BPS: '250',
        PENDLE_SLIPPAGE_BPS: '25',
        SEIZE_CAP_MARGIN_BPS: '75'
      }),
      deps
    )
    expect(config.quoting.httpRps).toBe(1)
    expect(config.quoting.maxRouteImpactBps).toBe(250)
    expect(config.quoting.pendleSlippageBps).toBe(25)
    expect(config.quoting.seizeCapMarginBps).toBe(75)
  })

  it('throws on an out-of-range MAX_ROUTE_IMPACT_BPS', () => {
    expect(() => loadLiquidateConfig(baseEnv({ MAX_ROUTE_IMPACT_BPS: '20000' }), deps)).toThrow(
      /MAX_ROUTE_IMPACT_BPS must be <= 10000/
    )
  })

  it('requires LIQUIDATOR_ADDRESS (the transform has no key) and rejects a malformed one', () => {
    expect(() => loadLiquidateConfig(baseEnv({ LIQUIDATOR_ADDRESS: undefined }), deps)).toThrow(
      /LIQUIDATOR_ADDRESS/
    )
    expect(() =>
      loadLiquidateConfig(baseEnv({ LIQUIDATOR_ADDRESS: 'not-an-address' }), deps)
    ).toThrow(/LIQUIDATOR_ADDRESS is not a valid address/)
  })
})
