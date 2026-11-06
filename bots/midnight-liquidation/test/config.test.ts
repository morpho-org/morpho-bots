import type { Address } from 'viem'

import { Executor } from '@repo/contracts'
import {
  BALANCE_EVERY_MS,
  blocksFor,
  blockTimeMs,
  bumpFees,
  feeCeiling,
  initialFees,
  stepCap
} from '@repo/kit'
import { tryCatch } from '@repo/utils'
import { getAddress, parseEther, parseGwei } from 'viem'
import { base, mainnet, optimism } from 'viem/chains'
import { describe, expect, it } from 'vitest'

import type { ChainConfig, Config, TuningConfig } from '../src/config'

import { loadConfig, STUCK_MS } from '../src/config'
import { InvalidConfigError } from '../src/errors'

const MIDNIGHT = '0x1111111111111111111111111111111111111111' as Address
const EXECUTOOOR = '0x3333333333333333333333333333333333333333'
const COLLATERAL = '0x4444444444444444444444444444444444444444'
const PRIVATE_KEY = `0x${'a'.repeat(64)}`

// The fixture chain is deliberately one the real CHAIN_MAP does NOT support (optimism), so these
// cases exercise env parsing in isolation. Keying it on a supported chain would make every "applies
// defaults" assertion below silently assert that chain's production tuning row instead — the real
// rows are covered by their own tests further down.
const FIXTURE_TUNING: TuningConfig = {
  balanceEveryBlocks: 30n
}

const CHAIN_MAP: Record<number, ChainConfig> = {
  [optimism.id]: {
    chain: optimism,
    midnight: MIDNIGHT,
    wrappedNative: getAddress('0x4200000000000000000000000000000000000006'),
    worldValidMs: 30_000,
    sendLifeMs: 40_000,
    tuning: FIXTURE_TUNING,
    defaults: {
      seizeCapMarginBps: 30,
      backoffBaseBlocks: 2n,
      backoffMaxBlocks: 64n
    }
  }
}

const deps = { chainMap: CHAIN_MAP }

// The values every shipped chain row must resolve to, end to end. Mainnet's block counts are Base's
// wall-clock intents at 60x the block time. The fee ceiling is no row's: `MAX_FEE_GWEI` is required.
const SHIPPED_ROWS: Record<
  number,
  {
    midnight: Address
    sendLifeMs: number
    tuning: TuningConfig
    seizeCapMarginBps: number
    backoffBaseBlocks: bigint
    backoffMaxBlocks: bigint
  }
> = {
  [base.id]: {
    midnight: getAddress('0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A'),
    sendLifeMs: 32_800,
    tuning: {
      balanceEveryBlocks: 300n
    },
    seizeCapMarginBps: 30,
    backoffBaseBlocks: 20n,
    backoffMaxBlocks: 640n
  },
  [mainnet.id]: {
    // A DIFFERENT address than Base's, so this must not be shared.
    midnight: getAddress('0x471686c42792F93528B000beF54bC10E3aa2045f'),
    sendLifeMs: 168_000,
    tuning: {
      balanceEveryBlocks: 5n
    },
    seizeCapMarginBps: 60,
    backoffBaseBlocks: 1n,
    backoffMaxBlocks: 11n
  }
}

// A venue API key is present by default so most cases exercise the armed (not bad-debt-only) posture.
function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    CHAIN_ID: String(optimism.id),
    FINALITY_1: 'safe',
    FINALITY_10: 'safe',
    FINALITY_8453: 'safe',
    RPC_URL: 'https://rpc.example',
    LIQUIDATOR_PRIVATE_KEY: PRIVATE_KEY,
    EXECUTOOOR_ADDRESS: EXECUTOOOR,
    KERNEL_STATE_DIR: '/var/lib/kernel',
    KERNEL_ENROLLMENT: 'enrolled',
    MAX_FEE_GWEI: '250',
    MAX_SPEND_ETH: '0.4',
    MAX_GAS_LIMIT: '12000000',
    ZEROX_API_KEY: 'zerox-key',
    MORPHO_API_KEY: 'morpho-key',
    ...overrides
  }
}

describe('loadConfig', () => {
  it('parses a complete env into a typed config, applying defaults', () => {
    const config: Config = loadConfig(baseEnv(), deps)

    expect(config.chainId).toBe(optimism.id)
    expect(config.chain).toBe(optimism)
    expect(config.midnight).toBe(MIDNIGHT)
    expect(config.rpcUrl).toBe('https://rpc.example')
    expect(config.rpcUrlFallback).toBeUndefined()
    expect(config.executooorAddress).toBe(getAddress(EXECUTOOOR))
    expect(config.discovery.apiUrl).toBe(
      'https://api.morpho.org/markets/midnight/liquidation-candidates'
    )
    expect(config.discovery.healthFactorLte).toBe(1.02)
    expect(config.maxFeePerGasWei).toBe(parseGwei('250'))
    expect(config.maxSpendWei).toBe(parseEther('0.4'))
    expect(config.maxGasLimit).toBe(12_000_000n)
    expect(config.logLevel).toBe('info')

    // Venue enablement is inferred from the present API key; global routing knobs take their defaults.
    expect(config.venues.enabled).toEqual(['0x'])
    expect(config.venues.excludeCollaterals).toEqual([])
    expect(config.venues.zeroxBaseUrl).toBeUndefined()

    // Market whitelist + probe defaults.
    expect(config.markets.apiUrls).toEqual(['https://api.morpho.org/v0/midnight/markets'])
    expect(config.markets.refreshMs).toBe(60_000)
    expect(config.probe.staleMs).toBe(45_000)
    expect(config.probe.httpRps).toBe(1)
    expect(config.probe.ladderSizes).toEqual([
      '0.01',
      '0.1',
      '1',
      '10',
      '100',
      '1000',
      '10000',
      '100000'
    ])

    // Quoting tunables apply their defaults.
    expect(config.quoting.quoteTimeoutMs).toBe(2500)
    expect(config.quoting.httpRps).toBe(2)
    expect(config.quoting.maxRouteImpactBps).toBe(500)
    expect(config.quoting.pendleSlippageBps).toBe(50)
    expect(config.quoting.seizeCapMarginBps).toBe(30)
    expect(config.quoting.minSurplusBps).toBe(0)
    expect(config.quoting.headroomFloorBps).toBe(3)
    expect(config.quoting.backoffBaseBlocks).toBe(2n)
  })

  it('honors optional overrides', () => {
    const config = loadConfig(
      baseEnv({
        RPC_URL_FALLBACK: 'https://rpc.fallback',
        MAX_FEE_GWEI: '42',
        LOG_LEVEL: 'debug'
      }),
      deps
    )

    expect(config.rpcUrlFallback).toBe('https://rpc.fallback')
    expect(config.maxFeePerGasWei).toBe(parseGwei('42'))
    expect(config.logLevel).toBe('debug')
  })

  // Every shipped chain row, asserted whole. `toStrictEqual` on `tuning` means a retune has to be
  // restated rather than silently absorbed, which is what keeps Base byte-identical to the values the
  // bot ran with before per-chain tuning existed. A chain missing from this table is caught
  // separately, by the supported-set test below.
  it.each(Object.entries(SHIPPED_ROWS))(
    'resolves chain %s to its shipped row',
    (chainId, expected) => {
      const config = loadConfig(baseEnv({ CHAIN_ID: chainId }))

      expect(config.chainId).toBe(Number(chainId))
      expect(config.chain.id).toBe(Number(chainId))
      expect(config.midnight).toBe(expected.midnight)
      expect(config.sendLifeMs).toBe(expected.sendLifeMs)
      expect(config.tuning).toStrictEqual(expected.tuning)
      expect(config.quoting.seizeCapMarginBps).toBe(expected.seizeCapMarginBps)
      expect(config.quoting.backoffBaseBlocks).toBe(expected.backoffBaseBlocks)
      expect(config.quoting.backoffMaxBlocks).toBe(expected.backoffMaxBlocks)
    }
  )

  // Base is the chain kit's default was calibrated for, so it is where the two must agree.
  it("matches kit's balance cadence on the chain it was calibrated for", () => {
    const { tuning } = loadConfig(baseEnv({ CHAIN_ID: '8453' }))

    expect(tuning.balanceEveryBlocks).toBe(BigInt(blocksFor(BALANCE_EVERY_MS, base)))
  })

  it.each([
    [{ KERNEL_STATE_DIR: undefined }, 'Missing required env var: KERNEL_STATE_DIR'],
    [{ KERNEL_ENROLLMENT: undefined }, 'Missing required env var: KERNEL_ENROLLMENT'],
    [{ KERNEL_ENROLLMENT: 'yes' }, 'KERNEL_ENROLLMENT must be "enrolling" or "enrolled"'],
    [
      { POSITION_LIQUIDATION_COOLDOWN_MS: '0' },
      'POSITION_LIQUIDATION_COOLDOWN_MS is no longer supported'
    ],
    [{ PRIORITY_FEE_GWEI: '0.2' }, 'PRIORITY_FEE_GWEI is no longer supported']
  ])('refuses kernel settings %o', (overrides, message) => {
    expect(() => loadConfig(baseEnv(overrides), deps)).toThrow(message)
  })

  it('refuses a chain whose finality is missing or malformed', () => {
    expect(() => loadConfig(baseEnv({ FINALITY_10: undefined }), deps)).toThrow(/FINALITY_10/)
    expect(() => loadConfig(baseEnv({ FINALITY_10: '0' }), deps)).toThrow(/FINALITY_10/)
    expect(loadConfig(baseEnv({ FINALITY_10: '64' }), deps).finality).toStrictEqual({ depth: 64 })
  })

  it('reads where the kernel keeps its ledger', () => {
    expect(loadConfig(baseEnv(), deps).kernel).toStrictEqual({
      stateDirectory: '/var/lib/kernel',
      enrollment: 'enrolled'
    })
  })

  // `SHIPPED_ROWS` is iterated, so on its own it cannot notice a chain added to CHAIN_MAP without an
  // expectation here. Pin the supported set against the error `loadConfig` raises for an unknown id.
  it('has an expectation for every chain the bot supports', () => {
    expect(() => loadConfig(baseEnv({ CHAIN_ID: '999999' }))).toThrow(
      `supported chain ids: ${Object.keys(SHIPPED_ROWS).join(', ')}`
    )
  })

  it('lets an env var override the chain default', () => {
    const config = loadConfig(baseEnv({ CHAIN_ID: '1', BACKOFF_MAX_BLOCKS: '7' }))
    expect(config.quoting.backoffMaxBlocks).toBe(7n)
    // Unset knobs still come from the chain row.
    expect(config.quoting.seizeCapMarginBps).toBe(60)
  })

  // A gas ceiling under the intrinsic cost of any transaction denies every send at the signing
  // policy while the process stays up — the bot looks healthy and liquidates nothing.
  it.each(['0', '20999'])('rejects a MAX_GAS_LIMIT of %s as unspendable', gasLimit => {
    expect(() => loadConfig(baseEnv({ MAX_GAS_LIMIT: gasLimit }), deps)).toThrow(
      'MAX_GAS_LIMIT must be at least 21000'
    )
  })

  it('accepts a MAX_GAS_LIMIT at the intrinsic-gas floor', () => {
    expect(loadConfig(baseEnv({ MAX_GAS_LIMIT: '21000' }), deps).maxGasLimit).toBe(21_000n)
  })

  // The bound an operator actually cares about is the product; assert it is derived and enforced.
  it('resolves MAX_SPEND_ETH to wei', () => {
    expect(loadConfig(baseEnv({ MAX_SPEND_ETH: '0.05' }), deps).maxSpendWei).toBe(
      parseEther('0.05')
    )
  })

  it.each(['0', '-1', 'abc'])('rejects a MAX_SPEND_ETH of %s', spend => {
    expect(() => loadConfig(baseEnv({ MAX_SPEND_ETH: spend }), deps)).toThrow(
      'MAX_SPEND_ETH must be a positive decimal'
    )
  })

  it.each([
    { MAX_SPEND_ETH: '0.000000000000021' },
    { MAX_FEE_GWEI: '0.000000001' },
    { MAX_FEE_GWEI: '0.0000000001' }
  ])('refuses fee bounds that cannot fund a fill and a step below it: %o', overrides => {
    expect(() => loadConfig(baseEnv(overrides), deps)).toThrow(/cannot fund a nonce fill/)
  })

  it('throws when a required var is missing', () => {
    expect(() => loadConfig(baseEnv({ RPC_URL: undefined }), deps)).toThrow(
      /Missing required env var: RPC_URL/
    )
  })

  it('throws on an unknown CHAIN_ID', () => {
    expect(() => loadConfig(baseEnv({ CHAIN_ID: '999999' }), deps)).toThrow(
      /Unsupported CHAIN_ID 999999/
    )
  })

  it('throws on a non-decimal CHAIN_ID', () => {
    expect(() => loadConfig(baseEnv({ CHAIN_ID: '0x1' }), deps)).toThrow(
      /CHAIN_ID must be a positive integer/
    )
  })

  it('normalizes EXECUTOOOR_ADDRESS to its EIP-55 checksum', () => {
    const lower = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
    const config = loadConfig(baseEnv({ EXECUTOOOR_ADDRESS: lower }), deps)
    expect(config.executooorAddress).toBe(getAddress(lower))
    expect(config.executooorAddress).not.toBe(lower) // proved normalization happened
  })

  it('defaults to the Executor deterministic CREATE2 address when EXECUTOOOR_ADDRESS is unset', () => {
    const config = loadConfig(baseEnv({ EXECUTOOOR_ADDRESS: undefined }), deps)
    expect(config.executooorAddress).toBe(getAddress(Executor.with().address))
  })

  it('throws on a too-short private key', () => {
    expect(() => loadConfig(baseEnv({ LIQUIDATOR_PRIVATE_KEY: '0xabc' }), deps)).toThrow(
      /32-byte hex/
    )
  })

  it('throws on a correct-length private key with a non-hex character', () => {
    const badKey = `0x${'a'.repeat(63)}g` // 66 chars, but 'g' is not hex → isHex branch must fire
    expect(() => loadConfig(baseEnv({ LIQUIDATOR_PRIVATE_KEY: badKey }), deps)).toThrow(
      /32-byte hex/
    )
  })

  it('throws on an invalid EXECUTOOOR_ADDRESS', () => {
    expect(() => loadConfig(baseEnv({ EXECUTOOOR_ADDRESS: 'not-an-address' }), deps)).toThrow(
      /not a valid address/
    )
  })

  it('throws on an unknown LOG_LEVEL', () => {
    expect(() => loadConfig(baseEnv({ LOG_LEVEL: 'verbose' }), deps)).toThrow(
      /LOG_LEVEL must be one of/
    )
  })

  it.each(
    ['MAX_FEE_GWEI', 'MAX_SPEND_ETH', 'MAX_GAS_LIMIT'].flatMap(name =>
      [undefined, '', '  '].map(value => [name, value] as const)
    )
  )('refuses to start without %s (%j)', (name, value) => {
    expect(() => loadConfig(baseEnv({ [name]: value }), deps)).toThrow(
      `Missing required env var: ${name}`
    )
  })

  it('throws on a non-numeric MAX_FEE_GWEI', () => {
    expect(() => loadConfig(baseEnv({ MAX_FEE_GWEI: 'abc' }), deps)).toThrow(
      /MAX_FEE_GWEI must be a positive number/
    )
  })

  it('enables 1inch when only ONEINCH_API_KEY is set', () => {
    const config = loadConfig(baseEnv({ ZEROX_API_KEY: undefined, ONEINCH_API_KEY: 'k' }), deps)
    expect(config.venues.enabled).toEqual(['1inch'])
  })

  it('enables both venues when both keys are set', () => {
    const config = loadConfig(baseEnv({ ONEINCH_API_KEY: 'k' }), deps)
    expect(config.venues.enabled).toEqual(['0x', '1inch'])
  })

  it('puts lifi first in the default order when LIFI_API_KEY is set', () => {
    const config = loadConfig(baseEnv({ LIFI_API_KEY: 'k', ONEINCH_API_KEY: 'k' }), deps)
    expect(config.venues.enabled).toEqual(['lifi', '0x', '1inch'])
  })

  it('reads an optional LIFI_BASE_URL override', () => {
    const config = loadConfig(
      baseEnv({ LIFI_API_KEY: 'k', LIFI_BASE_URL: 'https://staging.li.quest/v1' }),
      deps
    )
    expect(config.venues.lifiBaseUrl).toBe('https://staging.li.quest/v1')
  })

  it('enables lifi keyless via ENABLE_LIFI=true (no LIFI_API_KEY)', () => {
    const config = loadConfig(baseEnv({ ENABLE_LIFI: 'true' }), deps)
    expect(config.venues.enabled).toEqual(['lifi', '0x'])
  })

  it('boots on ENABLE_LIFI alone with no venue API keys set', () => {
    const config = loadConfig(baseEnv({ ZEROX_API_KEY: undefined, ENABLE_LIFI: 'true' }), deps)
    expect(config.venues.enabled).toEqual(['lifi'])
  })

  it('throws when no venue is enabled and bad-debt-only is not opted into', () => {
    expect(() => loadConfig(baseEnv({ ZEROX_API_KEY: undefined }), deps)).toThrow(
      /No venues enabled/
    )
  })

  it('boots in bad-debt-only mode (no enabled venues) when ALLOW_BAD_DEBT_ONLY=true', () => {
    const config = loadConfig(
      baseEnv({ ZEROX_API_KEY: undefined, ALLOW_BAD_DEBT_ONLY: 'true' }),
      deps
    )
    expect(config.venues.enabled).toEqual([])
  })

  it('throws on a non-boolean ALLOW_BAD_DEBT_ONLY', () => {
    expect(() => loadConfig(baseEnv({ ALLOW_BAD_DEBT_ONLY: 'yes' }), deps)).toThrow(
      /ALLOW_BAD_DEBT_ONLY must be "true" or "false"/
    )
  })

  it('ignores a stale SLIPPAGE_BPS rather than failing loud on it', () => {
    // The knob was removed when the min-out floor became break-even-derived. A deployment that still
    // sets it must keep starting — an unknown env var is not a misconfiguration.
    expect(loadConfig(baseEnv({ SLIPPAGE_BPS: '250' }), deps)).toEqual(loadConfig(baseEnv(), deps))
  })

  it('parses EXCLUDE_COLLATERALS into checksummed addresses and rejects a malformed entry', () => {
    const config = loadConfig(baseEnv({ EXCLUDE_COLLATERALS: `${COLLATERAL}, ${MIDNIGHT}` }), deps)
    expect(config.venues.excludeCollaterals).toEqual([getAddress(COLLATERAL), getAddress(MIDNIGHT)])
    expect(() => loadConfig(baseEnv({ EXCLUDE_COLLATERALS: 'nope' }), deps)).toThrow(
      /EXCLUDE_COLLATERALS contains an invalid address/
    )
  })

  it('rejects a malformed ZEROX_BASE_URL', () => {
    expect(() => loadConfig(baseEnv({ ZEROX_BASE_URL: 'not a url' }), deps)).toThrow(
      /ZEROX_BASE_URL is not a valid http\(s\) URL/
    )
  })

  it('overrides the markets API URL and refresh interval from env', () => {
    const config = loadConfig(
      baseEnv({ MARKETS_API_URL: 'https://custom.example/markets', MARKETS_REFRESH_MS: '5000' }),
      deps
    )
    expect(config.markets.apiUrls).toEqual(['https://custom.example/markets'])
    expect(config.markets.refreshMs).toBe(5000)
  })

  it('parses a comma-separated MARKETS_API_URL into ordered, de-duplicated sources', () => {
    const config = loadConfig(
      baseEnv({
        MARKETS_API_URL:
          'https://a.example/v0/midnight/markets, https://b.example/v0/midnight/markets ,https://a.example/v0/midnight/markets'
      }),
      deps
    )
    expect(config.markets.apiUrls).toEqual([
      'https://a.example/v0/midnight/markets',
      'https://b.example/v0/midnight/markets'
    ])
  })

  // Two spellings of one endpoint must collapse — otherwise the same source is polled twice and
  // counted twice in the union's freshness bookkeeping.
  it('de-duplicates MARKETS_API_URL entries that differ only in spelling', () => {
    const config = loadConfig(
      baseEnv({ MARKETS_API_URL: 'https://a.example/markets,https://a.example:443/markets' }),
      deps
    )
    expect(config.markets.apiUrls).toEqual(['https://a.example/markets'])
  })

  it('de-duplicates MARKETS_API_URL entries that differ only by a trailing slash', () => {
    const config = loadConfig(
      baseEnv({ MARKETS_API_URL: 'https://a.example/markets,https://a.example/markets/' }),
      deps
    )
    expect(config.markets.apiUrls).toEqual(['https://a.example/markets'])
  })

  // A trailing/leading/repeated comma usually means a misinterpolated env var — an intended source
  // silently missing — so it must fail loud rather than start with a narrowed whitelist.
  it('throws when a MARKETS_API_URL list contains an empty entry', () => {
    expect(() =>
      loadConfig(baseEnv({ MARKETS_API_URL: 'https://a.example/markets,' }), deps)
    ).toThrow(/MARKETS_API_URL must not contain empty entries/)
  })

  it('throws on a malformed MARKETS_API_URL', () => {
    expect(() => loadConfig(baseEnv({ MARKETS_API_URL: 'not a url' }), deps)).toThrow(
      /MARKETS_API_URL entry 1 is not a valid http\(s\) URL/
    )
  })

  // A malformed entry must fail loud rather than leaving the valid sources behind: silently dropping
  // one would narrow the whitelist with no signal.
  it('throws when any entry of a MARKETS_API_URL list is malformed', () => {
    expect(() =>
      loadConfig(baseEnv({ MARKETS_API_URL: 'https://a.example/markets,not a url' }), deps)
    ).toThrow(/MARKETS_API_URL entry 2 is not a valid http\(s\) URL/)
  })

  it('throws when MARKETS_API_URL holds only separators', () => {
    expect(() => loadConfig(baseEnv({ MARKETS_API_URL: ' , ' }), deps)).toThrow(
      /MARKETS_API_URL must not contain empty entries/
    )
  })

  it('parses PROBE_LADDER into raw string sizes and rejects a malformed element', () => {
    expect(loadConfig(baseEnv({ PROBE_LADDER: '0.5, 5, 50' }), deps).probe.ladderSizes).toEqual([
      '0.5',
      '5',
      '50'
    ])
    expect(() => loadConfig(baseEnv({ PROBE_LADDER: '1,0,10' }), deps)).toThrow(
      /PROBE_LADDER must be comma-separated positive numbers/
    )
  })

  it('parses probe cadence knobs from env', () => {
    const config = loadConfig(baseEnv({ PROBE_STALE_MS: '30000', PROBE_HTTP_RPS: '2' }), deps)
    expect(config.probe.staleMs).toBe(30_000)
    expect(config.probe.httpRps).toBe(2)
  })

  it('parses quoting tunables from env, overriding defaults', () => {
    const config = loadConfig(
      baseEnv({
        HTTP_RPS: '1',
        MAX_ROUTE_IMPACT_BPS: '250',
        SEIZE_CAP_MARGIN_BPS: '75',
        MIN_SURPLUS_BPS: '25',
        HEADROOM_FLOOR_BPS: '7'
      }),
      deps
    )
    expect(config.quoting.httpRps).toBe(1)
    expect(config.quoting.maxRouteImpactBps).toBe(250)
    expect(config.quoting.seizeCapMarginBps).toBe(75)
    expect(config.quoting.minSurplusBps).toBe(25)
    expect(config.quoting.headroomFloorBps).toBe(7)
  })

  it.each(['MIN_SURPLUS_BPS', 'HEADROOM_FLOOR_BPS', 'SEIZE_CAP_MARGIN_BPS'])(
    'throws on an out-of-range %s',
    name => {
      expect(() => loadConfig(baseEnv({ [name]: '10001' }), deps)).toThrow(name)
      expect(() => loadConfig(baseEnv({ [name]: '-1' }), deps)).toThrow(name)
    }
  )

  it('throws on an out-of-range MAX_ROUTE_IMPACT_BPS', () => {
    expect(() => loadConfig(baseEnv({ MAX_ROUTE_IMPACT_BPS: '20000' }), deps)).toThrow(
      /MAX_ROUTE_IMPACT_BPS must be <= 10000/
    )
  })

  it('overrides the discovery endpoint and health-factor cutoff from env', () => {
    const config = loadConfig(
      baseEnv({
        LIQUIDATION_CANDIDATES_API_URL: 'https://custom.example/candidates',
        HEALTH_FACTOR_LTE: '1.1'
      }),
      deps
    )
    expect(config.discovery.apiUrl).toBe('https://custom.example/candidates')
    expect(config.discovery.healthFactorLte).toBe(1.1)
  })

  it('reads MORPHO_API_KEY, and leaves it unset when blank', () => {
    expect(loadConfig(baseEnv(), deps).morphoApiKey).toBe('morpho-key')
    expect(loadConfig(baseEnv({ MORPHO_API_KEY: ' ' }), deps).morphoApiKey).toBeUndefined()
  })

  it.each(['LIQUIDATION_CANDIDATES_API_URL', 'MARKETS_API_URL'])(
    'refuses a plain-http %s, which would send MORPHO_API_KEY in the clear',
    name => {
      expect(() => loadConfig(baseEnv({ [name]: 'http://api.example/x' }), deps)).toThrow(
        new RegExp(`${name} must use https`)
      )
    }
  )

  it('throws on a malformed LIQUIDATION_CANDIDATES_API_URL (fail loud at startup)', () => {
    expect(() =>
      loadConfig(baseEnv({ LIQUIDATION_CANDIDATES_API_URL: 'not a url' }), deps)
    ).toThrow(/LIQUIDATION_CANDIDATES_API_URL is not a valid http\(s\) URL/)
  })

  it.each([
    'ZEROX_BASE_URL',
    'ONEINCH_BASE_URL',
    'LIFI_BASE_URL',
    'MARKETS_API_URL',
    'LIQUIDATION_CANDIDATES_API_URL'
  ])('never echoes a credentialed %s without a scheme', name => {
    for (const value of ['user:s3cret@rpc.example/v2', 's3cret@rpc.example/v2/k3y']) {
      const { error } = tryCatch(() => loadConfig(baseEnv({ [name]: value }), deps))
      expect(error).toBeInstanceOf(InvalidConfigError)
      expect(String(error)).not.toContain('s3cret')
    }
  })

  it('throws on a HEALTH_FACTOR_LTE below the 1.0 floor', () => {
    expect(() => loadConfig(baseEnv({ HEALTH_FACTOR_LTE: '0.9' }), deps)).toThrow(
      /HEALTH_FACTOR_LTE must be >= 1/
    )
  })
})

/** The re-bids a send life spans, each a stuck threshold apart, at a flat `baseFee`, before one drops. */
const rebidsUnder = (config: Config, baseFee: bigint) => {
  const cap = stepCap(feeCeiling(config.maxFeePerGasWei, config.maxSpendWei))
  const rebids = Math.floor(
    config.sendLifeMs / (blocksFor(STUCK_MS, config.chain) * blockTimeMs(config.chain.id))
  )
  let fees = initialFees(baseFee, cap)
  for (let bid = 0; bid < rebids; bid++) {
    const next = bumpFees({ ...fees, baseFee, maxFeePerGasWei: cap })
    if (next.kind === 'drop') return { first: initialFees(baseFee, cap), rebids, bumped: bid }
    fees = next.fees
  }
  return { first: initialFees(baseFee, cap), rebids, bumped: rebids }
}

describe('the release fee values', () => {
  it.each([
    { chainId: '8453', maxFeeGwei: '0.5', tip: 111_111_112n, edgeGwei: '0.0831', over: '0.0832' },
    { chainId: '1', maxFeeGwei: '50', tip: parseGwei('1'), edgeGwei: '3.772', over: '3.773' }
  ])(
    'tips and re-bids a whole send life for chain $chainId up to a $edgeGwei gwei base fee',
    ({ chainId, maxFeeGwei, tip, edgeGwei, over }) => {
      const config = loadConfig(
        baseEnv({ CHAIN_ID: chainId, MAX_FEE_GWEI: maxFeeGwei, MAX_SPEND_ETH: '0.5' })
      )
      const atEdge = rebidsUnder(config, parseGwei(edgeGwei))
      expect(atEdge.first.maxPriorityFeePerGas).toBe(tip)
      expect(atEdge.bumped).toBe(atEdge.rebids)
      const past = rebidsUnder(config, parseGwei(over))
      expect(past.bumped).toBe(past.rebids - 1)
    }
  )
})
