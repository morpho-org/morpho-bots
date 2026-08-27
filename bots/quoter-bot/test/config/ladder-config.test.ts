import type { Hex } from 'viem'

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { ConfigValidationError } from '../../src/config/config-validation.error'
import { ConfigService } from '../../src/config/config.service'

const marketId: Hex = `0x${'55'.repeat(32)}`
const secondMarketId: Hex = `0x${'66'.repeat(32)}`
const baseEnvironment = {
  CHAIN_ID: '8453',
  RPC_URL: 'https://rpc.example',
  REFERENCE_RPC_URL: 'https://archive.example',
  MAKER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  MAKER_ADDRESS: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
  MIDNIGHT_ADDRESS: '0x2222222222222222222222222222222222222222',
  LOAN_ASSET_ADDRESS: '0x3333333333333333333333333333333333333333',
  RATIFIER_ADDRESS: '0x4444444444444444444444444444444444444444',
  MARKET_IDS: marketId,
  REFERENCE_MARKET_ID: `0x${'77'.repeat(32)}`,
  NATIVE_RESERVE_WEI: '10',
  MAXIMUM_LEND_EXPOSURE_ASSETS: '100',
  MORPHO_API_BASE_URL: 'https://api.example',
  ROUTER_API_BASE_URL: 'https://router.example'
}
const item = (overrides: Record<string, unknown> = {}) => ({
  marketId,
  quotePremiumBps: '0',
  spreadBps: '200',
  stepBps: '100',
  rungCount: '3',
  sizeSkewBps: '0',
  lowerRateBudgetAssets: '10',
  higherRateBudgetAssets: '10',
  targetMarketExposureAssets: '20',
  maximumTotalExposureAssets: '20',
  minimumOfferAssets: '1',
  groupMode: 'shared-rung',
  loopIntervalSeconds: '3600',
  movementToleranceBps: '10',
  minimumRateBps: '200',
  maximumRateBps: '800',
  ...overrides
})
const bootstrapItem = (overrides: Record<string, unknown> = {}) => ({
  marketId,
  creditTarget: '10',
  acceptanceAssets: '1',
  offerSize: '2',
  premiumBps: '0',
  maximumMarketExposure: '20',
  maximumTotalExposure: '20',
  minimumRateBps: '200',
  maximumRateBps: '800',
  autoRefill: false,
  ...overrides
})
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true })))
})

describe('ladder configuration loading', () => {
  test('loads variable-rate and hardcoded target strategies independently', () => {
    const config = ConfigService.from({
      ...baseEnvironment,
      BOOTSTRAP_MARKETS: JSON.stringify([
        bootstrapItem({ targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' } })
      ]),
      LADDER_MARKETS: JSON.stringify([item({ targetRate: { strategy: 'variable_rate_avg' } })])
    })

    expect(config.bootstrap[0]?.targetRate).toEqual({
      strategy: 'hardcoded',
      hardcodedRateBps: 400n
    })
    expect(config.ladder[0]?.targetRate).toEqual({ strategy: 'variable_rate_avg' })
  })

  test('defaults each omitted target strategy to variable-rate average', () => {
    const config = ConfigService.from({
      ...baseEnvironment,
      LADDER_MARKETS: JSON.stringify([item({ targetRate: undefined })])
    })

    expect(config.ladder[0]?.targetRate).toEqual({ strategy: 'variable_rate_avg' })
  })

  test('rejects a hardcoded bootstrap target whose premium-adjusted rate exceeds its bounds', () => {
    expect(() =>
      ConfigService.from({
        ...baseEnvironment,
        BOOTSTRAP_MARKETS: JSON.stringify([
          bootstrapItem({
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '801' }
          })
        ])
      })
    ).toThrow('must be at most maximumRateBps')
  })

  test('rejects a hardcoded ladder target whose outer rung exceeds its bounds', () => {
    expect(() =>
      ConfigService.from({
        ...baseEnvironment,
        LADDER_MARKETS: JSON.stringify([
          item({
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '700' }
          })
        ])
      })
    ).toThrow('higher rung is outside the configured hard range')
  })

  test('loads a nested YAML ladder maturity premium with quoted and bare integers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ladder-config-'))
    directories.push(directory)
    const path = join(directory, 'quoter-bot.yaml')
    const yamlItem = Object.entries(item())
      .map(([key, value]) => `    ${key}: '${value}'`)
      .join('\n')
    await writeFile(
      path,
      `ladder:\n  -\n${yamlItem}\n    maturityPremium:\n      shape: linear\n      premiumPerYearBps: '120'\n      maximumPremiumBps: 300\n`
    )

    const config = await ConfigService.load(baseEnvironment, { configPath: path })

    expect(config.ladder[0]?.maturityPremium).toEqual({
      shape: 'linear',
      premiumPerYearBps: 120n,
      maximumPremiumBps: 300n
    })
  })

  test('loads a LADDER_MARKETS maturity premium and omits the absent optional cap', () => {
    const config = ConfigService.from({
      ...baseEnvironment,
      LADDER_MARKETS: JSON.stringify([
        item({ maturityPremium: { shape: 'linear', premiumPerYearBps: '120' } })
      ])
    })

    expect(config.ladder[0]?.maturityPremium).toEqual({
      shape: 'linear',
      premiumPerYearBps: 120n
    })
    expect(config.ladder[0]?.quotePremiumBps).toBe(0n)
  })

  test.each([
    [
      'unsupported nested key',
      { shape: 'linear', premiumPerYearBps: '120', slopeBps: '1' },
      'ladder[0].maturityPremium contains an unsupported key'
    ],
    [
      'unsupported shape',
      { shape: 'quadratic', premiumPerYearBps: '120' },
      'ladder[0].maturityPremium.shape must be linear'
    ],
    [
      'missing slope',
      { shape: 'linear' },
      'ladder[0].maturityPremium.premiumPerYearBps is required'
    ],
    [
      'non-positive slope',
      { shape: 'linear', premiumPerYearBps: '0' },
      'ladder[0].maturityPremium.premiumPerYearBps must be positive'
    ],
    [
      'number token slope',
      { shape: 'linear', premiumPerYearBps: 120 },
      'ladder[0].maturityPremium.premiumPerYearBps must be an integer'
    ],
    [
      'non-positive cap',
      { shape: 'linear', premiumPerYearBps: '120', maximumPremiumBps: '0' },
      'ladder[0].maturityPremium.maximumPremiumBps must be positive'
    ]
  ])(
    'rejects an invalid LADDER_MARKETS maturity premium: %s',
    (_name, maturityPremium, message) => {
      expect(() =>
        ConfigService.from({
          ...baseEnvironment,
          LADDER_MARKETS: JSON.stringify([item({ maturityPremium })])
        })
      ).toThrow(message)
    }
  )

  test.each([
    ['an uncapped maturity premium reaching the minimum at long maturities', undefined],
    ['a capped maturity premium whose highest reachable center fits the shape', '300']
  ])('accepts a hardcoded ladder shape breaching the minimum with %s', (_name, cap) => {
    const config = ConfigService.from({
      ...baseEnvironment,
      LADDER_MARKETS: JSON.stringify([
        item({
          targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' },
          maturityPremium: {
            shape: 'linear',
            premiumPerYearBps: '200',
            ...(cap === undefined ? {} : { maximumPremiumBps: cap })
          }
        })
      ])
    })

    expect(config.ladder[0]?.targetRate).toEqual({ strategy: 'hardcoded', hardcodedRateBps: 400n })
  })

  test.each([
    [
      'a capped premium that can never lift the lower rung inside',
      '400',
      { shape: 'linear', premiumPerYearBps: '200', maximumPremiumBps: '50' },
      'lower rung is outside the configured hard range'
    ],
    [
      'a base higher rung already above the maximum at every maturity',
      '700',
      { shape: 'linear', premiumPerYearBps: '200' },
      'higher rung is outside the configured hard range'
    ],
    [
      'an uncapped slope too shallow to lift the lower rung within the protocol horizon',
      '300',
      { shape: 'linear', premiumPerYearBps: '1' },
      'lower rung is outside the configured hard range'
    ]
  ])(
    'rejects a hardcoded ladder shape pinned outside the bounds at every maturity: %s',
    (_name, hardcodedRateBps, maturityPremium, message) => {
      expect(() =>
        ConfigService.from({
          ...baseEnvironment,
          LADDER_MARKETS: JSON.stringify([
            item({
              targetRate: { strategy: 'hardcoded', hardcodedRateBps },
              maturityPremium
            })
          ])
        })
      ).toThrow(message)
    }
  )

  test.each([
    [
      'BOOTSTRAP_MARKETS',
      bootstrapItem,
      { strategy: 'hardcoded' },
      'bootstrap[0].targetRate.hardcodedRateBps',
      'missing',
      'bootstrap[0].targetRate.hardcodedRateBps is required'
    ],
    [
      'LADDER_MARKETS',
      item,
      { strategy: 'hardcoded', hardcodedRateBps: '1e2' },
      'ladder[0].targetRate.hardcodedRateBps',
      'invalid-integer',
      'ladder[0].targetRate.hardcodedRateBps must be an integer'
    ],
    [
      'BOOTSTRAP_MARKETS',
      bootstrapItem,
      { strategy: 'hardcoded', hardcodedRateBps: 400 },
      'bootstrap[0].targetRate.hardcodedRateBps',
      'invalid-integer',
      'bootstrap[0].targetRate.hardcodedRateBps must be an integer'
    ],
    [
      'LADDER_MARKETS',
      item,
      { strategy: 'hardcoded', hardcodedRateBps: '0' },
      'ladder[0].targetRate.hardcodedRateBps',
      'out-of-range',
      'ladder[0].targetRate.hardcodedRateBps must be positive'
    ],
    [
      'BOOTSTRAP_MARKETS',
      bootstrapItem,
      { strategy: 'hardcoded', hardcodedRateBps: '-1' },
      'bootstrap[0].targetRate.hardcodedRateBps',
      'invalid-integer',
      'bootstrap[0].targetRate.hardcodedRateBps must be an integer'
    ],
    [
      'BOOTSTRAP_MARKETS',
      bootstrapItem,
      { strategy: 'unsupported' },
      'bootstrap[0].targetRate.strategy',
      'invalid-strategy',
      'bootstrap[0].targetRate.strategy must be variable_rate_avg or hardcoded'
    ],
    [
      'LADDER_MARKETS',
      item,
      { strategy: 'variable_rate_avg', hardcodedRateBps: '400' },
      'ladder[0].targetRate',
      'unknown-key',
      'ladder[0].targetRate contains an unsupported key'
    ],
    [
      'BOOTSTRAP_MARKETS',
      bootstrapItem,
      { strategy: 'hardcoded', hardcodedRateBps: '400', unsupported: true },
      'bootstrap[0].targetRate',
      'unknown-key',
      'bootstrap[0].targetRate contains an unsupported key'
    ]
  ])(
    'rejects invalid %s target-rate configuration %#',
    (field, makeItem, targetRate, expectedField, reason, message) => {
      let error: unknown
      try {
        ConfigService.from({
          ...baseEnvironment,
          [field]: JSON.stringify([makeItem({ targetRate })])
        })
      } catch (value) {
        error = value
      }

      expect(error).toBeInstanceOf(ConfigValidationError)
      expect(error).toMatchObject({ field: expectedField, reason })
      expect((error as ConfigValidationError).message).toBe(message)
    }
  )

  test('defaults to an empty list and loads a root YAML ladder list', async () => {
    expect(ConfigService.from(baseEnvironment).ladder).toEqual([])
    const directory = await mkdtemp(join(tmpdir(), 'ladder-config-'))
    directories.push(directory)
    const path = join(directory, 'quoter-bot.yaml')
    const yamlItem = Object.entries(item())
      .map(([key, value]) => `    ${key}: '${value}'`)
      .join('\n')
    await writeFile(path, `ladder:\n  -\n${yamlItem}\n`)
    const config = await ConfigService.load(baseEnvironment, { configPath: path })
    expect(config.ladder).toEqual([
      expect.objectContaining({
        marketId,
        rungCount: 3,
        spreadBps: 200n,
        minimumOfferAssets: 1n,
        groupMode: 'shared-rung'
      })
    ])
  })

  test('LADDER_MARKETS replaces a semantically invalid YAML ladder as a whole', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ladder-config-'))
    directories.push(directory)
    const path = join(directory, 'operator.yaml')
    await writeFile(path, 'ladder:\n  - unsupported: value\n    spreadBps: 1.5\n')
    const config = await ConfigService.load(
      { ...baseEnvironment, LADDER_MARKETS: JSON.stringify([item()]) },
      { configPath: path }
    )
    expect(config.ladder).toHaveLength(1)
  })

  test.each([
    ['malformed', '['],
    ['unknown field', JSON.stringify([item({ unsupported: 'private' })])],
    ['non-allowlisted market', JSON.stringify([item({ marketId: secondMarketId })])],
    ['duplicate market', JSON.stringify([item(), item()])],
    ['number token', JSON.stringify([item({ spreadBps: 200 })])]
  ])('rejects %s LADDER_MARKETS input', (_name, value) => {
    expect(() => ConfigService.from({ ...baseEnvironment, LADDER_MARKETS: value })).toThrow()
  })

  test('rejects malformed integer strings and invalid domain values', () => {
    expect(() =>
      ConfigService.from({
        ...baseEnvironment,
        LADDER_MARKETS: JSON.stringify([item({ stepBps: '1e2' })])
      })
    ).toThrow('must be an integer')
    expect(() =>
      ConfigService.from({
        ...baseEnvironment,
        LADDER_MARKETS: JSON.stringify([item({ spreadBps: '201' })])
      })
    ).toThrow('must be even')
    expect(() =>
      ConfigService.from({
        ...baseEnvironment,
        LADDER_MARKETS: JSON.stringify([
          item({ lowerRateBudgetAssets: '100', minimumOfferAssets: '101' })
        ])
      })
    ).toThrow('must be at least minimumOfferAssets')
  })
})
