import type { Address } from 'viem'

import {
  BALANCE_EVERY_BLOCKS,
  BLOCK_POLL_MS,
  bumpFees,
  initialFees,
  MAX_BUMP_ATTEMPTS,
  RECONCILE_EVERY_BLOCKS,
  STUCK_BLOCKS
} from '@repo/bot-kit'
import { Executor } from '@repo/contracts'
import { getAddress, parseEther, parseGwei } from 'viem'
import { base, mainnet, optimism } from 'viem/chains'
import { describe, expect, it } from 'vitest'

import type { ChainConfig, Config, TuningConfig } from '../src/config'

import { BLOCK_POLL_MS as LOCAL_BLOCK_POLL_MS, loadConfig } from '../src/config'

// EIP-1559 raises the basefee by at most 12.5% per block, when every block is completely full.
const bumped12Point5 = (baseFee: bigint) => (baseFee * 1125n) / 1000n

const MIDNIGHT = '0x1111111111111111111111111111111111111111' as Address
const EXECUTOOOR = '0x3333333333333333333333333333333333333333'
const COLLATERAL = '0x4444444444444444444444444444444444444444'
const PRIVATE_KEY = `0x${'a'.repeat(64)}`

// The fixture chain is deliberately one the real CHAIN_MAP does NOT support (optimism), so these
// cases exercise env parsing in isolation. Keying it on a supported chain would make every "applies
// defaults" assertion below silently assert that chain's production tuning row instead — the real
// rows are covered by their own tests further down.
const FIXTURE_TUNING: TuningConfig = {
  settledCooldownBlocks: 20n,
  stuckBlocks: 4n,
  reconcileEveryBlocks: 3,
  balanceEveryBlocks: 30n,
  maxBumpAttempts: 3
}

const CHAIN_MAP: Record<number, ChainConfig> = {
  [optimism.id]: {
    chain: optimism,
    midnight: MIDNIGHT,
    tuning: FIXTURE_TUNING,
    defaults: {
      priorityFeeGwei: '0.1',
      maxGasLimit: 15_000_000n,
      seizeCapMarginBps: 30,
      backoffBaseBlocks: 2n,
      backoffMaxBlocks: 64n
    }
  }
}

const deps = { chainMap: CHAIN_MAP }

// The values every shipped chain row must resolve to, end to end. Base's are exactly what the bot ran
// with before it was multichain; mainnet's block counts are the same wall-clock intents at ~6x the
// block time. `maxFeeWei` is identical on both — it is the bump ladder's headroom, and bounds the
// price of a gas unit rather than the cost of a transaction, which is `maxSpendWei`.
const SHIPPED_ROWS: Record<
  number,
  {
    midnight: Address
    tuning: TuningConfig
    maxGasLimit: bigint
    maxFeeWei: bigint
    priorityFeeWei: bigint
    seizeCapMarginBps: number
    backoffBaseBlocks: bigint
    backoffMaxBlocks: bigint
  }
> = {
  [base.id]: {
    midnight: getAddress('0xAdedD8ab6dE832766Fedf0FaC4992E5C4D3EA18A'),
    tuning: {
      settledCooldownBlocks: 20n,
      stuckBlocks: 4n,
      reconcileEveryBlocks: 3,
      balanceEveryBlocks: 30n,
      maxBumpAttempts: 3
    },
    maxGasLimit: 15_000_000n,
    maxFeeWei: parseGwei('300'),
    priorityFeeWei: parseGwei('0.1'),
    seizeCapMarginBps: 30,
    backoffBaseBlocks: 2n,
    backoffMaxBlocks: 64n
  },
  [mainnet.id]: {
    // A DIFFERENT address than Base's, so this must not be shared.
    midnight: getAddress('0x471686c42792F93528B000beF54bC10E3aa2045f'),
    tuning: {
      settledCooldownBlocks: 3n,
      stuckBlocks: 1n,
      reconcileEveryBlocks: 1,
      balanceEveryBlocks: 5n,
      maxBumpAttempts: 6
    },
    maxGasLimit: 3_000_000n,
    maxFeeWei: parseGwei('300'),
    priorityFeeWei: parseGwei('2'),
    seizeCapMarginBps: 60,
    backoffBaseBlocks: 1n,
    backoffMaxBlocks: 11n
  }
}

// A venue API key is present by default so most cases exercise the armed (not bad-debt-only) posture.
function baseEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    CHAIN_ID: String(optimism.id),
    RPC_URL: 'https://rpc.example',
    LIQUIDATOR_PRIVATE_KEY: PRIVATE_KEY,
    EXECUTOOOR_ADDRESS: EXECUTOOOR,
    ZEROX_API_KEY: 'zerox-key',
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
    expect(config.maxFeeWei).toBe(parseGwei('300'))
    expect(config.priorityFeeWei).toBe(parseGwei('0.1'))
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
    expect(config.quoting.backoffBaseBlocks).toBe(2n)
  })

  it('honors optional overrides', () => {
    const config = loadConfig(
      baseEnv({
        RPC_URL_FALLBACK: 'https://rpc.fallback',
        MAX_FEE_GWEI: '42',
        PRIORITY_FEE_GWEI: '0.005',
        LOG_LEVEL: 'debug'
      }),
      deps
    )

    expect(config.rpcUrlFallback).toBe('https://rpc.fallback')
    expect(config.maxFeeWei).toBe(parseGwei('42'))
    expect(config.priorityFeeWei).toBe(parseGwei('0.005'))
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
      expect(config.tuning).toStrictEqual(expected.tuning)
      expect(config.maxGasLimit).toBe(expected.maxGasLimit)
      expect(config.maxFeeWei).toBe(expected.maxFeeWei)
      expect(config.priorityFeeWei).toBe(expected.priorityFeeWei)
      expect(config.quoting.seizeCapMarginBps).toBe(expected.seizeCapMarginBps)
      expect(config.quoting.backoffBaseBlocks).toBe(expected.backoffBaseBlocks)
      expect(config.quoting.backoffMaxBlocks).toBe(expected.backoffMaxBlocks)
    }
  )

  // Passing these explicitly decouples the bot from bot-kit's own defaults, so a change there would
  // otherwise silently apply to blue-liquidation and not to this bot. Base is the chain those
  // defaults were written for, so it is where the two must agree.
  it("matches bot-kit's own defaults on the chain they were calibrated for", () => {
    const { tuning } = loadConfig(baseEnv({ CHAIN_ID: '8453' }))

    expect(tuning.stuckBlocks).toBe(STUCK_BLOCKS)
    expect(tuning.maxBumpAttempts).toBe(MAX_BUMP_ATTEMPTS)
    expect(tuning.reconcileEveryBlocks).toBe(RECONCILE_EVERY_BLOCKS)
    expect(tuning.balanceEveryBlocks).toBe(BALANCE_EVERY_BLOCKS)
    // Chain-independent, so it is asserted against the module constant `index.ts` actually passes.
    expect(LOCAL_BLOCK_POLL_MS).toBe(BLOCK_POLL_MS)
  })

  // Replays the ladder that actually runs, through bot-kit's own fee functions rather than a
  // restatement of them, and returns how many bumps land before the queue drops the tx.
  const ladderBumps = (config: Config, startBaseFee: bigint, risingPerBlock: boolean): number => {
    // A tx is replaced once it has sat MORE than `stuckBlocks` blocks, so one extra block of basefee
    // growth compounds between bumps.
    const blocksBetweenBumps = Number(config.tuning.stuckBlocks) + 1
    let baseFee = startBaseFee
    let fees = initialFees(baseFee, config.maxFeeWei, config.priorityFeeWei)

    for (let bumps = 0; ; bumps += 1) {
      if (risingPerBlock) {
        for (let block = 0; block < blocksBetweenBumps; block += 1)
          baseFee = bumped12Point5(baseFee)
      }
      const next = bumpFees({ ...fees, baseFee, maxFeeWei: config.maxFeeWei })
      if (next.kind === 'drop') return bumps
      fees = next.fees
    }
  }

  // `bumpFees` reads the LIVE basefee — a replacement's max is `max(prev * 1.125, 2*baseFee + tip)` —
  // so how deep the ladder gets depends on what the basefee does while the tx sits, not only on
  // `maxBumpAttempts`. Exceeding `maxFeeWei` DROPS the tx and latches a nonce hole, so a row whose
  // ladder truncates early stops sending entirely. Two regimes bound it:
  //
  //   flat      the basefee holds and the `prev * 1.125` term binds
  //   max-rise  every block is full (+12.5%/block, the EIP-1559 ceiling) and `2*baseFee` binds
  //
  // Base is the tighter row under a rise despite its shallower ladder, because it waits 5 blocks
  // between bumps to mainnet's 2: the basefee compounds ~1.80x per bump against mainnet's ~1.27x.
  // Neither bound is near either chain's real basefee; they are pinned exactly so that retuning a fee
  // knob, `stuckBlocks`, or `maxBumpAttempts` has to restate the ladder rather than quietly shorten it.
  it.each([
    [base.id, 105n, 25n],
    [mainnet.id, 72n, 36n]
  ])(
    'chain %i completes its ladder to %i gwei flat and %i gwei rising',
    (chainId, flat, rising) => {
      const config = loadConfig(baseEnv({ CHAIN_ID: String(chainId) }))
      const attempts = config.tuning.maxBumpAttempts

      for (const [limit, isRising] of [
        [flat, false],
        [rising, true]
      ] as const) {
        expect(ladderBumps(config, parseGwei(String(limit)), isRising)).toBeGreaterThanOrEqual(
          attempts
        )
        // One gwei higher truncates the ladder — which is what makes the bound exact rather than a
        // value that merely happens to pass.
        expect(ladderBumps(config, parseGwei(String(limit + 1n)), isRising)).toBeLessThan(attempts)
      }
    }
  )

  // `SHIPPED_ROWS` is iterated, so on its own it cannot notice a chain added to CHAIN_MAP without an
  // expectation here. Pin the supported set against the error `loadConfig` raises for an unknown id.
  it('has an expectation for every chain the bot supports', () => {
    expect(() => loadConfig(baseEnv({ CHAIN_ID: '999999' }))).toThrow(
      `supported chain ids: ${Object.keys(SHIPPED_ROWS).join(', ')}`
    )
  })

  it('lets an env var override the chain default', () => {
    const config = loadConfig(
      baseEnv({ CHAIN_ID: '1', MAX_GAS_LIMIT: '123456', BACKOFF_MAX_BLOCKS: '7' })
    )
    expect(config.maxGasLimit).toBe(123_456n)
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
  it('resolves MAX_SPEND_ETH to wei and defaults it chain-independently', () => {
    expect(loadConfig(baseEnv({ CHAIN_ID: '8453' })).maxSpendWei).toBe(parseEther('0.5'))
    expect(loadConfig(baseEnv({ CHAIN_ID: '1' })).maxSpendWei).toBe(parseEther('0.5'))
    expect(loadConfig(baseEnv({ MAX_SPEND_ETH: '0.05' }), deps).maxSpendWei).toBe(
      parseEther('0.05')
    )
  })

  it.each(['0', '-1', 'abc'])('rejects a MAX_SPEND_ETH of %s', spend => {
    expect(() => loadConfig(baseEnv({ MAX_SPEND_ETH: spend }), deps)).toThrow(
      'MAX_SPEND_ETH must be a positive decimal'
    )
  })

  // A budget too small to pay for the cheapest possible transaction denies every send, the same
  // silent do-nothing failure MIN_GAS_LIMIT guards from the other side.
  it('rejects a MAX_SPEND_ETH that cannot cover minimum gas at the configured tip', () => {
    expect(() => loadConfig(baseEnv({ CHAIN_ID: '1', MAX_SPEND_ETH: '0.00000000001' }))).toThrow(
      /cannot pay for 21000 gas/
    )
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

  it('throws on a non-numeric MAX_FEE_GWEI', () => {
    expect(() => loadConfig(baseEnv({ MAX_FEE_GWEI: 'abc' }), deps)).toThrow(
      /MAX_FEE_GWEI must be a positive number/
    )
  })

  it('throws on a non-numeric or zero PRIORITY_FEE_GWEI', () => {
    expect(() => loadConfig(baseEnv({ PRIORITY_FEE_GWEI: 'abc' }), deps)).toThrow(
      /PRIORITY_FEE_GWEI must be a positive number/
    )
    expect(() => loadConfig(baseEnv({ PRIORITY_FEE_GWEI: '0' }), deps)).toThrow(
      /PRIORITY_FEE_GWEI must be a positive number/
    )
  })

  // A valid decimal under 1 wei: parseGwei rounds it to 0, which would send an untipped tx.
  it('throws on a PRIORITY_FEE_GWEI that rounds to zero wei', () => {
    expect(() => loadConfig(baseEnv({ PRIORITY_FEE_GWEI: '0.0000000001' }), deps)).toThrow(
      /PRIORITY_FEE_GWEI must be at least 1 wei/
    )
  })

  // Within one bump of the ceiling, the first replacement exceeds it and drops, wedging the nonce.
  it('throws when PRIORITY_FEE_GWEI leaves no bump headroom under MAX_FEE_GWEI', () => {
    expect(() => loadConfig(baseEnv({ MAX_FEE_GWEI: '1', PRIORITY_FEE_GWEI: '2' }), deps)).toThrow(
      /PRIORITY_FEE_GWEI \(2, from env\) leaves no room to bump under MAX_FEE_GWEI \(1, from env\)/
    )
    expect(() => loadConfig(baseEnv({ MAX_FEE_GWEI: '1', PRIORITY_FEE_GWEI: '1' }), deps)).toThrow(
      /PRIORITY_FEE_GWEI \(1, from env\) leaves no room to bump under MAX_FEE_GWEI \(1, from env\)/
    )
  })

  // The pair is resolved from two independent fallbacks, so an operator who set only one of them
  // would otherwise see an error quoting a value they never configured anywhere.
  it('names which side came from env and which from the chain default', () => {
    // Only the ceiling is set, and set below the chain's own tip → the tip side is a chain default.
    expect(() => loadConfig(baseEnv({ CHAIN_ID: '1', MAX_FEE_GWEI: '1' }))).toThrow(
      /PRIORITY_FEE_GWEI \(2, from chain 1 default\) leaves no room to bump under MAX_FEE_GWEI \(1, from env\)/
    )
  })

  // --- Venue enablement -----------------------------------------------------

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
    expect(() => loadConfig(baseEnv({ SLIPPAGE_BPS: '250' }), deps)).not.toThrow()
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
      /ZEROX_BASE_URL is not a valid URL/
    )
  })

  // --- Markets whitelist + probe --------------------------------------------

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
      /MARKETS_API_URL is not a valid URL/
    )
  })

  // A malformed entry must fail loud rather than leaving the valid sources behind: silently dropping
  // one would narrow the whitelist with no signal.
  it('throws when any entry of a MARKETS_API_URL list is malformed', () => {
    expect(() =>
      loadConfig(baseEnv({ MARKETS_API_URL: 'https://a.example/markets,not a url' }), deps)
    ).toThrow(/MARKETS_API_URL is not a valid URL: not a url/)
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

  // --- Quoting + discovery (unchanged) --------------------------------------

  it('parses quoting tunables from env, overriding defaults', () => {
    const config = loadConfig(
      baseEnv({ HTTP_RPS: '1', MAX_ROUTE_IMPACT_BPS: '250', SEIZE_CAP_MARGIN_BPS: '75' }),
      deps
    )
    expect(config.quoting.httpRps).toBe(1)
    expect(config.quoting.maxRouteImpactBps).toBe(250)
    expect(config.quoting.seizeCapMarginBps).toBe(75)
  })

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

  it('throws on a malformed LIQUIDATION_CANDIDATES_API_URL (fail loud at startup)', () => {
    expect(() =>
      loadConfig(baseEnv({ LIQUIDATION_CANDIDATES_API_URL: 'not a url' }), deps)
    ).toThrow(/LIQUIDATION_CANDIDATES_API_URL is not a valid URL/)
  })

  it('throws on a HEALTH_FACTOR_LTE below the 1.0 floor', () => {
    expect(() => loadConfig(baseEnv({ HEALTH_FACTOR_LTE: '0.9' }), deps)).toThrow(
      /HEALTH_FACTOR_LTE must be >= 1/
    )
  })
})
