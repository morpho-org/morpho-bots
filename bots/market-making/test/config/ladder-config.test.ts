import type { Hex } from 'viem'

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

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
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true })))
})

describe('ladder configuration loading', () => {
  test('defaults to an empty list and loads a root YAML ladder list', async () => {
    expect(ConfigService.from(baseEnvironment).ladder).toEqual([])
    const directory = await mkdtemp(join(tmpdir(), 'ladder-config-'))
    directories.push(directory)
    const path = join(directory, 'market-making.yaml')
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
