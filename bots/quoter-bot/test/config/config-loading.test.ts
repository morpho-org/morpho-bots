import type { Hex } from 'viem'

import { $ } from 'execa'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { ConfigFileError } from '../../src/config/config-file.error'
import {
  configurationFromEnvironment,
  loadConfigurationSources
} from '../../src/config/config-source.utils'
import { ConfigValidationError } from '../../src/config/config-validation.error'
import { ConfigService } from '../../src/config/config.service'

const marketId: Hex = `0x${'55'.repeat(32)}`
const secondMarketId: Hex = `0x${'66'.repeat(32)}`
const referenceMarketId: Hex = `0x${'77'.repeat(32)}`
const environment = {
  CHAIN_ID: '8453',
  RPC_URL: 'https://rpc.env.example',
  REFERENCE_RPC_URL: 'https://archive.env.example',
  MAKER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  MAKER_ADDRESS: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
  MIDNIGHT_ADDRESS: '0x2222222222222222222222222222222222222222',
  LOAN_ASSET_ADDRESS: '0x3333333333333333333333333333333333333333',
  RATIFIER_ADDRESS: '0x4444444444444444444444444444444444444444',
  MARKET_IDS: marketId,
  REFERENCE_MARKET_ID: referenceMarketId,
  NATIVE_RESERVE_WEI: '10',
  MAXIMUM_LEND_EXPOSURE_ASSETS: '100',
  MORPHO_API_BASE_URL: 'https://api.env.example',
  ROUTER_API_BASE_URL: 'https://router.env.example'
}
const directories: string[] = []

const temporaryDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quoter-bot-config-'))
  directories.push(directory)
  return directory
}

const createFifo = async (path: string) => {
  const { failed } = await $({ reject: false })`mkfifo ${path}`
  if (failed) throw new Error('Unable to create FIFO test fixture')
}

const loadInBoundedSubprocess = async (options: { configPath?: string; cwd: string }) => {
  const moduleUrl = new URL('../../src/config/config.service.ts', import.meta.url).href
  const script = `
    import { ConfigService } from ${JSON.stringify(moduleUrl)}
    try {
      await ConfigService.load(${JSON.stringify(environment)}, ${JSON.stringify(options)})
      console.log(JSON.stringify({ reason: 'loaded' }))
    } catch (error) {
      console.log(JSON.stringify({ reason: error?.reason ?? 'unexpected' }))
    }
  `
  // `node -e` cannot import TypeScript, so tsx is registered as a loader for the inline module. That
  // specifier resolves from the workspace root, which is why `tsx` stays a root devDependency (knip
  // cannot see a usage inside `--import`, so the root workspace ignores it explicitly). execa's own
  // timeout enforces the bound instead of a manual kill. The bound is what this suite is
  // really asserting: reading a FIFO would block forever, so any finite completion proves the loader
  // fails closed. It is 10s rather than the 1s bun used because a tsx cold start alone costs ~1.3s —
  // well under the bound, but not under one sized for bun's interpreter startup.
  const result = await $({
    reject: false,
    timeout: 10_000
  })`node --import tsx --input-type=module -e ${script}`
  return {
    exitCode: result.exitCode ?? null,
    timedOut: result.timedOut,
    stdout: result.stdout
  }
}

const yaml = (overrides = '') => `
chain:
  id: 8453
  rpcUrl: https://rpc.yaml.example
  archiveRpcUrl: https://archive.yaml.example
identity:
  makerAddress: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A"
  makerPrivateKey: "0x${'11'.repeat(32)}"
contracts:
  midnightAddress: "0x2222222222222222222222222222222222222222"
  loanAssetAddress: "0x3333333333333333333333333333333333333333"
  ratifierAddress: "0x4444444444444444444444444444444444444444"
apis:
  morphoBaseUrl: https://api.yaml.example
  routerBaseUrl: https://router.yaml.example
markets:
  allowlist:
    - "${marketId}"
  referenceMarketId: "${referenceMarketId}"
  v0OfferGroupIds: []
setup:
  nativeReserveWei: "10"
  maximumLendExposureAssets: "100"
  requestTimeoutMs: 10000
  transactionReceiptTimeoutMs: 180000
bootstrap:
  - marketId: "${marketId}"
    creditTarget: "10000000000000000001"
    acceptanceAssets: "1"
    offerSize: "2"
    premiumBps: -50
    maximumMarketExposure: "10000000000000000002"
    maximumTotalExposure: "10000000000000000003"
    minimumRateBps: 200
    maximumRateBps: 800
    autoRefill: false
${overrides}`

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true })))
})

describe('ConfigService YAML and environment loading', () => {
  test('loads complete YAML-only configuration through the shared typed path', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yml')
    await writeFile(path, yaml())

    const config = await ConfigService.load({}, { configPath: path, cwd: directory })

    expect(config.rpcUrl).toBe('https://rpc.yaml.example')
    expect(config.transactionReceiptTimeoutMs).toBe(180_000)
    expect(config.setup.marketIds).toEqual([marketId])
    expect(config.bootstrap).toEqual([
      {
        marketId,
        targetRate: { strategy: 'variable_rate_avg' },
        creditTarget: 10_000_000_000_000_000_001n,
        acceptanceAssets: 1n,
        offerSize: 2n,
        premiumBps: -50n,
        maximumMarketExposure: 10_000_000_000_000_000_002n,
        maximumTotalExposure: 10_000_000_000_000_000_003n,
        minimumRateBps: 200n,
        maximumRateBps: 800n,
        autoRefill: false
      }
    ])
  })

  test('loads independent explicit bootstrap and ladder target-rate strategies from YAML', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    const contents = yaml(`ladder:
  - marketId: "${marketId}"
    targetRate:
      strategy: variable_rate_avg
    quotePremiumBps: "0"
    spreadBps: "200"
    stepBps: "100"
    rungCount: "1"
    sizeSkewBps: "0"
    lowerRateBudgetAssets: "10"
    higherRateBudgetAssets: "10"
    targetMarketExposureAssets: "20"
    maximumTotalExposureAssets: "20"
    minimumOfferAssets: "1"
    groupMode: shared-rung
    loopIntervalSeconds: "60"
    movementToleranceBps: "10"
    minimumRateBps: "200"
    maximumRateBps: "800"
  - marketId: "${secondMarketId}"
    targetRate:
      strategy: hardcoded
      hardcodedRateBps: "400"
    quotePremiumBps: "0"
    spreadBps: "200"
    stepBps: "100"
    rungCount: "1"
    sizeSkewBps: "0"
    lowerRateBudgetAssets: "10"
    higherRateBudgetAssets: "10"
    targetMarketExposureAssets: "20"
    maximumTotalExposureAssets: "20"
    minimumOfferAssets: "1"
    groupMode: shared-rung
    loopIntervalSeconds: "60"
    movementToleranceBps: "10"
    minimumRateBps: "200"
    maximumRateBps: "800"
`)
      .replace(`    - "${marketId}"`, `    - "${marketId}"\n    - "${secondMarketId}"`)
      .replace(
        '    premiumBps: -50',
        '    targetRate:\n      strategy: hardcoded\n      hardcodedRateBps: "400"\n    premiumBps: -50'
      )
    await writeFile(path, contents)

    const config = await ConfigService.load({}, { configPath: path })

    expect(config.bootstrap[0]?.targetRate).toEqual({
      strategy: 'hardcoded',
      hardcodedRateBps: 400n
    })
    expect(config.ladder.map(item => item.targetRate)).toEqual([
      { strategy: 'variable_rate_avg' },
      { strategy: 'hardcoded', hardcodedRateBps: 400n }
    ])
  })

  test('rejects an invalid nested YAML target-rate with an exact validation failure', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    await writeFile(
      path,
      yaml().replace(
        '    premiumBps: -50',
        '    targetRate:\n      strategy: hardcoded\n    premiumBps: -50'
      )
    )

    const error = await ConfigService.load({}, { configPath: path }).catch(error => error)

    expect(error).toBeInstanceOf(ConfigValidationError)
    expect(error.field).toBe('bootstrap[0].targetRate.hardcodedRateBps')
    expect(error.reason).toBe('missing')
    expect(error.message).toBe('bootstrap[0].targetRate.hardcodedRateBps is required')
  })

  test('loads a nested YAML bootstrap maturity premium with quoted and bare integers', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    await writeFile(
      path,
      yaml().replace(
        '    premiumBps: -50',
        '    premiumBps: -50\n    maturityPremium:\n      shape: linear\n      premiumPerYearBps: "120"\n      maximumPremiumBps: 300'
      )
    )

    const config = await ConfigService.load({}, { configPath: path })

    expect(config.bootstrap[0]?.maturityPremium).toEqual({
      shape: 'linear',
      premiumPerYearBps: 120n,
      maximumPremiumBps: 300n
    })
  })

  test('loads a YAML bootstrap maturity premium without the optional cap', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    await writeFile(
      path,
      yaml().replace(
        '    premiumBps: -50',
        '    premiumBps: -50\n    maturityPremium:\n      shape: linear\n      premiumPerYearBps: "120"'
      )
    )

    const config = await ConfigService.load({}, { configPath: path })

    expect(config.bootstrap[0]?.maturityPremium).toEqual({
      shape: 'linear',
      premiumPerYearBps: 120n
    })
    expect(config.bootstrap[0]?.premiumBps).toBe(-50n)
  })

  test.each([
    [
      'unsupported nested key',
      'shape: linear\n      premiumPerYearBps: "120"\n      slopeBps: "1"',
      'bootstrap[0].maturityPremium contains an unsupported key'
    ],
    [
      'unsupported shape',
      'shape: quadratic\n      premiumPerYearBps: "120"',
      'bootstrap[0].maturityPremium.shape must be linear'
    ],
    [
      'missing slope',
      'shape: linear',
      'bootstrap[0].maturityPremium.premiumPerYearBps is required'
    ],
    [
      'non-positive slope',
      'shape: linear\n      premiumPerYearBps: "0"',
      'bootstrap[0].maturityPremium.premiumPerYearBps must be positive'
    ],
    [
      'negative slope syntax',
      'shape: linear\n      premiumPerYearBps: "-120"',
      'bootstrap[0].maturityPremium.premiumPerYearBps must be an integer'
    ],
    [
      'non-positive cap',
      'shape: linear\n      premiumPerYearBps: "120"\n      maximumPremiumBps: "0"',
      'bootstrap[0].maturityPremium.maximumPremiumBps must be positive'
    ]
  ])('rejects an invalid YAML maturity premium: %s', async (_name, block, message) => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    await writeFile(
      path,
      yaml().replace(
        '    premiumBps: -50',
        `    premiumBps: -50\n    maturityPremium:\n      ${block}`
      )
    )

    await expect(ConfigService.load({}, { configPath: path })).rejects.toThrow(message)
  })

  test('loads env-only configuration when no default file exists', async () => {
    const directory = await temporaryDirectory()
    const config = await ConfigService.load(environment, { cwd: directory })
    expect(config.rpcUrl).toBe(environment.RPC_URL)
    expect(config.bootstrap).toEqual([])
  })

  test('omits YAML and environment private keys from read-only configuration sources', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    const yamlSecret = 'yaml-private-key-marker'
    const environmentSecret = 'environment-private-key-marker'
    await writeFile(path, yaml().replace(`0x${'11'.repeat(32)}`, yamlSecret))

    const yamlSource = await loadConfigurationSources({}, { configPath: path, readOnly: true })
    const environmentSource = configurationFromEnvironment(
      { ...environment, MAKER_PRIVATE_KEY: environmentSecret },
      { readOnly: true }
    )

    expect(yamlSource.values).not.toHaveProperty('MAKER_PRIVATE_KEY')
    expect(environmentSource.values).not.toHaveProperty('MAKER_PRIVATE_KEY')
    expect(JSON.stringify(yamlSource)).not.toContain(yamlSecret)
    expect(JSON.stringify(environmentSource)).not.toContain(environmentSecret)
  })

  test('environment values override YAML scalars, endpoints, keys, and the bootstrap list', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    await writeFile(path, yaml())
    const replacement = [
      {
        marketId,
        creditTarget: '90071992547409930001',
        acceptanceAssets: '2',
        offerSize: '3',
        premiumBps: '-25',
        maximumMarketExposure: '90071992547409930002',
        maximumTotalExposure: '90071992547409930003',
        minimumRateBps: '300',
        maximumRateBps: '700',
        autoRefill: true
      }
    ]
    const config = await ConfigService.load(
      {
        RPC_URL: environment.RPC_URL,
        MAKER_PRIVATE_KEY: `0x${'22'.repeat(32)}`,
        NATIVE_RESERVE_WEI: '42',
        BOOTSTRAP_MARKETS: JSON.stringify(replacement)
      },
      { configPath: path, cwd: directory }
    )
    expect(config.rpcUrl).toBe(environment.RPC_URL)
    expect(config.privateKey).toBe(`0x${'22'.repeat(32)}`)
    expect(config.setup.nativeReserve).toBe(42n)
    expect(config.bootstrap[0]).toMatchObject({
      creditTarget: 90_071_992_547_409_930_001n,
      premiumBps: -25n,
      autoRefill: true
    })
  })

  test('loads a bootstrap maturity premium from a BOOTSTRAP_MARKETS replacement', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    await writeFile(path, yaml())
    const replacement = [
      {
        marketId,
        creditTarget: '10',
        acceptanceAssets: '1',
        offerSize: '2',
        premiumBps: '-25',
        maturityPremium: {
          shape: 'linear',
          premiumPerYearBps: '120',
          maximumPremiumBps: '300'
        },
        maximumMarketExposure: '20',
        maximumTotalExposure: '30',
        minimumRateBps: '300',
        maximumRateBps: '700',
        autoRefill: false
      }
    ]

    const config = await ConfigService.load(
      { BOOTSTRAP_MARKETS: JSON.stringify(replacement) },
      { configPath: path, cwd: directory }
    )

    expect(config.bootstrap[0]?.maturityPremium).toEqual({
      shape: 'linear',
      premiumPerYearBps: 120n,
      maximumPremiumBps: 300n
    })
  })

  test('rejects a JSON number token inside a BOOTSTRAP_MARKETS maturity premium', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    await writeFile(path, yaml())
    const replacement =
      `[{"marketId":"${marketId}","creditTarget":"10","acceptanceAssets":"1","offerSize":"2",` +
      '"premiumBps":"-25","maturityPremium":{"shape":"linear","premiumPerYearBps":120},' +
      '"maximumMarketExposure":"20","maximumTotalExposure":"30","minimumRateBps":"300",' +
      '"maximumRateBps":"700","autoRefill":false}]'

    await expect(
      ConfigService.load({ BOOTSTRAP_MARKETS: replacement }, { configPath: path, cwd: directory })
    ).rejects.toThrow('bootstrap[0].maturityPremium.premiumPerYearBps must be an integer')
  })

  test.each([
    ['CHAIN_ID', 'chain:\n  id: 8.453e3', 'chainId', 8453],
    ['NATIVE_RESERVE_WEI', 'setup:\n  nativeReserveWei: 1.5', 'nativeReserve', 42n],
    ['REQUEST_TIMEOUT_MS', 'setup:\n  requestTimeoutMs: 1e4', 'requestTimeoutMs', 1234],
    [
      'TRANSACTION_RECEIPT_TIMEOUT_MS',
      'setup:\n  transactionReceiptTimeoutMs: 1e4',
      'transactionReceiptTimeoutMs',
      1234
    ]
  ])(
    'valid %s overrides an invalid YAML scalar before semantic validation',
    async (key, contents, property, expected) => {
      const directory = await temporaryDirectory()
      const path = join(directory, 'operator.yaml')
      await writeFile(path, contents)

      const config = await ConfigService.load(
        { ...environment, [key]: String(expected) },
        { configPath: path }
      )

      const actual =
        property === 'chainId'
          ? config.setup.chainId
          : property === 'nativeReserve'
            ? config.setup.nativeReserve
            : property === 'requestTimeoutMs'
              ? config.requestTimeoutMs
              : config.transactionReceiptTimeoutMs
      expect(actual).toBe(expected)
    }
  )

  test('environment collections replace semantically invalid YAML collections before validation', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    await writeFile(
      path,
      `markets:\n  allowlist: invalid-scalar\n  v0OfferGroupIds:\n    unsupported: value\nbootstrap:\n  - unsupported: value\n    creditTarget: 1.5\n`
    )

    const config = await ConfigService.load(
      {
        ...environment,
        MARKET_IDS: secondMarketId,
        V0_OFFER_GROUP_IDS: '',
        BOOTSTRAP_MARKETS: '[]'
      },
      { configPath: path }
    )

    expect(config.setup.marketIds).toEqual([secondMarketId])
    expect(config.v0OfferGroupIds).toEqual([])
    expect(config.bootstrap).toEqual([])
  })

  test('BOOTSTRAP_MARKETS replaces unsupported and invalid YAML bootstrap items', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    await writeFile(path, `bootstrap:\n  - unsupported: value\n    creditTarget: 1.5\n`)

    const config = await ConfigService.load(
      { ...environment, BOOTSTRAP_MARKETS: '[]' },
      { configPath: path }
    )

    expect(config.bootstrap).toEqual([])
  })

  test('discovers .yaml first when both default filenames exist', async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'quoter-bot.yaml'), yaml())
    await writeFile(
      join(directory, 'quoter-bot.yml'),
      yaml().replace('https://rpc.yaml.example', 'https://rpc.fallback.example')
    )
    expect((await ConfigService.load({}, { cwd: directory })).rpcUrl).toBe(
      'https://rpc.yaml.example'
    )
  })

  test('falls back to quoter-bot.yml when quoter-bot.yaml is absent', async () => {
    const directory = await temporaryDirectory()
    await writeFile(
      join(directory, 'quoter-bot.yml'),
      yaml().replace('https://rpc.yaml.example', 'https://rpc.fallback.example')
    )
    expect((await ConfigService.load({}, { cwd: directory })).rpcUrl).toBe(
      'https://rpc.fallback.example'
    )
  })

  test('an explicit FIFO fails closed without blocking', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    await createFifo(path)

    const result = await loadInBoundedSubprocess({ configPath: path, cwd: directory })

    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"reason":"unreadable-explicit"')
  })

  test('a discovered quoter-bot.yaml FIFO fails closed without falling back', async () => {
    const directory = await temporaryDirectory()
    await createFifo(join(directory, 'quoter-bot.yaml'))
    await writeFile(join(directory, 'quoter-bot.yml'), yaml())

    const result = await loadInBoundedSubprocess({ cwd: directory })

    expect(result.timedOut).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('"reason":"unreadable-discovered"')
  })

  test('an explicit .yml path wins over default discovery', async () => {
    const directory = await temporaryDirectory()
    await writeFile(join(directory, 'quoter-bot.yaml'), yaml())
    await writeFile(
      join(directory, 'chosen.yml'),
      yaml().replace('https://rpc.yaml.example', 'https://rpc.explicit.example')
    )
    expect(
      (await ConfigService.load({}, { configPath: 'chosen.yml', cwd: directory })).rpcUrl
    ).toBe('https://rpc.explicit.example')
  })

  test('fails loudly for a missing or unreadable explicit path', async () => {
    const directory = await temporaryDirectory()
    const unreadablePath = join(directory, 'unreadable.yaml')
    await mkdir(unreadablePath)
    await expect(
      ConfigService.load(environment, { configPath: 'missing.yaml', cwd: directory })
    ).rejects.toThrow('Explicit configuration file does not exist')
    await expect(
      ConfigService.load(environment, { configPath: unreadablePath, cwd: directory })
    ).rejects.toThrow('Explicit configuration file is unreadable')
  })

  test('rejects explicit and discovered YAML symlinks to an existing regular file', async () => {
    const directory = await temporaryDirectory()
    const target = join(directory, 'target.yaml')
    const explicitLink = join(directory, 'operator.yaml')
    const discoveredLink = join(directory, 'quoter-bot.yaml')
    await writeFile(target, yaml())
    await symlink(target, explicitLink)
    await symlink(target, discoveredLink)

    await expect(ConfigService.load(environment, { configPath: explicitLink })).rejects.toThrow(
      'Explicit configuration file is unreadable'
    )
    await expect(ConfigService.load(environment, { cwd: directory })).rejects.toThrow(
      'Discovered configuration file is unreadable'
    )
  })

  test('rejects a dangling explicit YAML symlink', async () => {
    const directory = await temporaryDirectory()
    const link = join(directory, 'operator.yaml')
    await symlink(join(directory, 'missing-target.yaml'), link)

    const error = await ConfigService.load(environment, { configPath: link }).catch(error => error)

    expect(error).toBeInstanceOf(ConfigFileError)
    expect(error.reason).toBe('unreadable-explicit')
  })

  test('rejects a dangling discovered YAML symlink without .yml or env-only fallback', async () => {
    const directory = await temporaryDirectory()
    await symlink(join(directory, 'missing-target.yaml'), join(directory, 'quoter-bot.yaml'))
    await writeFile(join(directory, 'quoter-bot.yml'), yaml())

    const error = await ConfigService.load(environment, { cwd: directory }).catch(error => error)

    expect(error).toBeInstanceOf(ConfigFileError)
    expect(error.reason).toBe('unreadable-discovered')
  })

  test('rejects a directory through the opened-handle regular-file check', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'directory.yaml')
    await mkdir(path)

    await expect(ConfigService.load(environment, { configPath: path })).rejects.toThrow(
      'Explicit configuration file is unreadable'
    )
  })

  test('bounded same-handle reads reject growth beyond 1 MiB after fstat', async () => {
    let closed = false
    let reads = 0
    const fileSystem = {
      async open() {
        return {
          async stat() {
            return { isFile: () => true, size: 1 }
          },
          async read(buffer: Uint8Array, _offset: number, length: number) {
            reads += 1
            buffer.fill(120, 0, length)
            return { bytesRead: length }
          },
          async close() {
            closed = true
          }
        }
      }
    }

    const error = await ConfigService.load(environment, {
      configPath: '/virtual/operator.yaml',
      fileSystem
    }).catch(error => error)

    expect(error).toBeInstanceOf(ConfigFileError)
    expect(error.reason).toBe('too-large')
    expect(reads).toBe(1)
    expect(closed).toBe(true)
  })

  test.each([
    [
      'fstat',
      () => ({
        async stat() {
          throw Object.assign(new Error('injected fstat failure'), { code: 'ENOENT' })
        },
        async read() {
          throw new Error('read must not be reached')
        }
      })
    ],
    [
      'read',
      () => ({
        async stat() {
          return { isFile: () => true, size: 2 }
        },
        async read() {
          throw Object.assign(new Error('injected read failure'), { code: 'ENOENT' })
        }
      })
    ]
  ])(
    'a discovered post-open %s ENOENT fails closed without fallback',
    async (_operation, handle) => {
      const opened: string[] = []
      let closed = false
      const fileSystem = {
        async open(path: string) {
          opened.push(path)
          if (opened.length > 1) throw new Error('fallback must not be inspected')
          return {
            ...handle(),
            async close() {
              closed = true
            }
          }
        }
      }

      const error = await ConfigService.load(environment, {
        cwd: '/virtual',
        fileSystem
      }).catch(error => error)

      expect(error).toBeInstanceOf(ConfigFileError)
      expect(error.reason).toBe('unreadable-discovered')
      expect(opened).toEqual(['/virtual/quoter-bot.yaml'])
      expect(closed).toBe(true)
    }
  )

  test('a discovered close ENOENT fails closed without fallback', async () => {
    const opened: string[] = []
    let reads = 0
    const fileSystem = {
      async open(path: string) {
        opened.push(path)
        if (opened.length > 1) throw new Error('fallback must not be inspected')
        return {
          async stat() {
            return { isFile: () => true, size: 2 }
          },
          async read(buffer: Uint8Array) {
            if (reads++ === 0) {
              buffer.set(Buffer.from('{}'))
              return { bytesRead: 2 }
            }
            return { bytesRead: 0 }
          },
          async close() {
            throw Object.assign(new Error('injected close failure'), { code: 'ENOENT' })
          }
        }
      }
    }

    const error = await ConfigService.load(environment, {
      cwd: '/virtual',
      fileSystem
    }).catch(error => error)

    expect(error).toBeInstanceOf(ConfigFileError)
    expect(error.reason).toBe('unreadable-discovered')
    expect(opened).toEqual(['/virtual/quoter-bot.yaml'])
  })

  test('rejects an explicit configuration path without a .yaml or .yml extension', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.json')
    await writeFile(path, yaml())

    const error = await ConfigService.load({}, { configPath: path }).catch(error => error)

    expect(error).toBeInstanceOf(ConfigFileError)
    expect(error.reason).toBe('unsupported-extension')
    expect(error.message).toBe('Explicit configuration file must use a .yaml or .yml extension')
  })

  test('rejects an oversized YAML source before parsing it', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    await writeFile(path, `# private-oversized-yaml-marker\n${'x'.repeat(1_048_576)}`)

    const error = await ConfigService.load({}, { configPath: path }).catch(error => error)

    expect(error).toBeInstanceOf(ConfigFileError)
    expect(error.reason).toBe('too-large')
    expect(error.message).toBe('Configuration file exceeds the maximum supported size')
    expect(JSON.stringify(error)).not.toContain('private-oversized-yaml-marker')
  })

  test('sanitizes YAML alias conversion failures', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    const secret = 'private-yaml-alias-marker'
    await writeFile(path, `identity: &${secret}\n  makerPrivateKey: value\ncopy: *${secret}\n`)

    const error = await ConfigService.load({}, { configPath: path }).catch(error => error)

    expect(error).toBeInstanceOf(ConfigFileError)
    expect(error.reason).toBe('malformed')
    expect(error.message).toBe('Configuration file contains malformed YAML')
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  test.each([
    ['malformed YAML', 'chain: [', 'malformed YAML'],
    ['unknown YAML key', `${yaml()}\nunsupportedSecret: value`, 'unsupported key'],
    [
      'wrong YAML type',
      yaml().replace(
        'chain:\n  id: 8453\n  rpcUrl: https://rpc.yaml.example\n  archiveRpcUrl: https://archive.yaml.example',
        'chain: []'
      ),
      'chain must be a mapping'
    ],
    ['empty explicit YAML', '   \n', 'must not be empty'],
    [
      'floating-point asset amount',
      yaml().replace('creditTarget: "10000000000000000001"', 'creditTarget: 1.5'),
      'must be an integer'
    ],
    [
      'invalid bootstrap domain bounds',
      yaml().replace('premiumBps: -50', 'premiumBps: 1'),
      'bootstrap[0].premiumBps must be zero or negative'
    ]
  ])('rejects %s', async (_name, contents, message) => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    await writeFile(path, contents)
    await expect(ConfigService.load({}, { configPath: path, cwd: directory })).rejects.toThrow(
      message
    )
  })

  test('preserves bigint precision from YAML integer values', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    await writeFile(
      path,
      yaml().replace('creditTarget: "10000000000000000001"', 'creditTarget: 10000000000000000001')
    )
    expect((await ConfigService.load({}, { configPath: path })).bootstrap[0]?.creditTarget).toBe(
      10_000_000_000_000_000_001n
    )
  })

  test.each([
    ['double-quoted false', '"false"'],
    ['single-quoted true', "'true'"],
    ['uppercase true', 'TRUE'],
    ['uppercase false string', '"FALSE"'],
    ['numeric substitute', '1'],
    ['other string substitute', 'yes']
  ])('rejects %s for YAML bootstrap autoRefill', async (_name, spelling) => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    await writeFile(path, yaml().replace('autoRefill: false', `autoRefill: ${spelling}`))

    await expect(ConfigService.load({}, { configPath: path })).rejects.toThrow(
      'bootstrap[0].autoRefill must be a boolean'
    )
  })

  test.each(['true', 'false'])('accepts plain lowercase YAML boolean %s', async spelling => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    await writeFile(path, yaml().replace('autoRefill: false', `autoRefill: ${spelling}`))

    expect((await ConfigService.load({}, { configPath: path })).bootstrap[0]?.autoRefill).toBe(
      spelling === 'true'
    )
  })

  test('BOOTSTRAP_MARKETS replacement bypasses invalid YAML bootstrap boolean style', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    await writeFile(path, yaml().replace('autoRefill: false', 'autoRefill: "false"'))

    const config = await ConfigService.load({ BOOTSTRAP_MARKETS: '[]' }, { configPath: path })

    expect(config.bootstrap).toEqual([])
  })

  test.each([
    ['creditTarget', '1.0'],
    ['creditTarget', '1e1'],
    ['creditTarget', '1E+1'],
    ['creditTarget', '+10'],
    ['creditTarget', "' 10 '"],
    ['premiumBps', '-5.0'],
    ['premiumBps', '-5e1'],
    ['requestTimeoutMs', '10000.0'],
    ['requestTimeoutMs', '1e4'],
    ['requestTimeoutMs', '1E+4'],
    ['requestTimeoutMs', '+10000'],
    ['requestTimeoutMs', "' 10000 '"],
    ['transactionReceiptTimeoutMs', '180000.0'],
    ['transactionReceiptTimeoutMs', '1.8e5'],
    ['transactionReceiptTimeoutMs', '+180000'],
    ['transactionReceiptTimeoutMs', "' 180000 '"]
  ])('rejects non-decimal YAML integer syntax for %s: %s', async (field, spelling) => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    const original =
      field === 'requestTimeoutMs'
        ? '10000'
        : field === 'transactionReceiptTimeoutMs'
          ? '180000'
          : field === 'premiumBps'
            ? '-50'
            : '"10000000000000000001"'
    await writeFile(path, yaml().replace(`${field}: ${original}`, `${field}: ${spelling}`))

    await expect(ConfigService.load({}, { configPath: path })).rejects.toThrow()
  })

  test('accepts canonical decimal integer strings and bare YAML integers', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    await writeFile(
      path,
      yaml()
        .replace('creditTarget: "10000000000000000001"', 'creditTarget: 10000000000000000001')
        .replace('acceptanceAssets: "1"', "acceptanceAssets: '1'")
    )

    const config = await ConfigService.load({}, { configPath: path })
    expect(config.bootstrap[0]?.creditTarget).toBe(10_000_000_000_000_000_001n)
    expect(config.bootstrap[0]?.acceptanceAssets).toBe(1n)
    expect(config.requestTimeoutMs).toBe(10_000)
  })

  test.each([
    ['duplicate key', yaml().replace('  id: 8453', '  id: 8453\n  id: 8453')],
    [
      'alias',
      yaml()
        .replace('chain:', 'chain: &shared')
        .replace('identity:', 'identity: *shared\nunusedIdentity:')
    ],
    ['custom tag', yaml().replace('id: 8453', 'id: !integer 8453')],
    ['prototype key', `${yaml()}\n__proto__: secret`],
    ['constructor key', `${yaml()}\nconstructor: secret`]
  ])('rejects YAML %s with a sanitized parser error', async (_name, contents) => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    await writeFile(path, contents)

    const error = await ConfigService.load({}, { configPath: path }).catch(error => error)
    expect(error).toBeInstanceOf(ConfigFileError)
    expect(error.message).not.toContain('secret')
    expect(JSON.stringify(error)).not.toContain(path)
  })

  test.each([
    ['duplicate key', 'bootstrap:\n  - marketId: first\n    marketId: second\n'],
    ['alias', 'bootstrap: &items\n  - marketId: value\ncopy: *items\n'],
    ['custom tag', 'bootstrap: !custom []\n'],
    ['prototype key', 'bootstrap:\n  - __proto__: secret\n'],
    ['malformed syntax', 'bootstrap: [\n']
  ])(
    'rejects source-level YAML %s even when environment replaces bootstrap',
    async (_name, contents) => {
      const directory = await temporaryDirectory()
      const path = join(directory, 'operator.yaml')
      await writeFile(path, contents)

      const error = await ConfigService.load(
        { ...environment, BOOTSTRAP_MARKETS: '[]' },
        { configPath: path }
      ).catch(error => error)

      expect(error).toBeInstanceOf(ConfigFileError)
      expect(error.reason).toBe('malformed')
    }
  )

  test('rejects unsafe YAML nesting even when environment replaces the nested value', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    const deeplyNested = `${Array.from(
      { length: 70 },
      (_, index) => `${'  '.repeat(index)}level${index}:\n`
    ).join('')}${'  '.repeat(70)}bootstrap: []\n`
    await writeFile(path, deeplyNested)

    const error = await ConfigService.load(
      { ...environment, BOOTSTRAP_MARKETS: '[]' },
      { configPath: path }
    ).catch(error => error)

    expect(error).toBeInstanceOf(ConfigFileError)
    expect(error.reason).toBe('malformed')
  })

  test('parses multiple allowlisted bootstrap markets', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    const second = yaml()
      .replace(`    - "${marketId}"`, `    - "${marketId}"\n    - "${secondMarketId}"`)
      .replace(
        'bootstrap:\n',
        `bootstrap:\n  - marketId: "${secondMarketId}"\n    creditTarget: "9"\n    acceptanceAssets: "1"\n    offerSize: "2"\n    premiumBps: -10\n    maximumMarketExposure: "10"\n    maximumTotalExposure: "20"\n    minimumRateBps: 100\n    maximumRateBps: 900\n    autoRefill: true\n`
      )
    await writeFile(path, second)
    const config = await ConfigService.load({}, { configPath: path })
    expect(config.setup.marketIds).toEqual([marketId, secondMarketId])
    expect(config.bootstrap.map(item => item.marketId)).toEqual([secondMarketId, marketId])
  })

  test('BOOTSTRAP_MARKETS has deterministic whole-list replacement semantics', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    await writeFile(path, yaml())
    const config = await ConfigService.load(
      {
        BOOTSTRAP_MARKETS: JSON.stringify([
          {
            marketId,
            creditTarget: '9',
            acceptanceAssets: '1',
            offerSize: '2',
            premiumBps: '0',
            maximumMarketExposure: '10',
            maximumTotalExposure: '20',
            minimumRateBps: '100',
            maximumRateBps: '900',
            autoRefill: true
          }
        ])
      },
      { configPath: path }
    )
    expect(config.bootstrap).toHaveLength(1)
    expect(config.bootstrap[0]?.creditTarget).toBe(9n)
  })

  test('rejects duplicate BOOTSTRAP_MARKETS object keys', async () => {
    const duplicate = `[{"marketId":"${marketId}","creditTarget":"9","creditTarget":"10"}]`

    const error = await ConfigService.load(
      { ...environment, BOOTSTRAP_MARKETS: duplicate },
      { cwd: await temporaryDirectory() }
    ).catch(error => error)

    expect(error).toBeInstanceOf(ConfigValidationError)
    expect(error.field).toBe('BOOTSTRAP_MARKETS')
    expect(error.reason).toBe('malformed-json')
    expect(error.message).toBe('BOOTSTRAP_MARKETS must be a JSON array with unique object keys')
  })

  test('preserves bigint precision from quoted BOOTSTRAP_MARKETS decimal integer values', async () => {
    const raw = `[{"marketId":"${marketId}","creditTarget":"10000000000000000001","acceptanceAssets":"1","offerSize":"2","premiumBps":"-50","maximumMarketExposure":"10000000000000000002","maximumTotalExposure":"10000000000000000003","minimumRateBps":"200","maximumRateBps":"800","autoRefill":false}]`

    const config = await ConfigService.load(
      { ...environment, BOOTSTRAP_MARKETS: raw },
      { cwd: await temporaryDirectory() }
    )

    expect(config.bootstrap[0]?.creditTarget).toBe(10_000_000_000_000_000_001n)
    expect(config.bootstrap[0]?.maximumTotalExposure).toBe(10_000_000_000_000_000_003n)
  })

  test.each(['1.0', '1e1', '1E+1', '10'])(
    'rejects BOOTSTRAP_MARKETS JSON number token %s for integer fields',
    async numberToken => {
      const raw = `[{"marketId":"${marketId}","creditTarget":${numberToken},"acceptanceAssets":"1","offerSize":"2","premiumBps":"-50","maximumMarketExposure":"10","maximumTotalExposure":"20","minimumRateBps":"200","maximumRateBps":"800","autoRefill":false}]`
      await expect(
        ConfigService.load(
          { ...environment, BOOTSTRAP_MARKETS: raw },
          { cwd: await temporaryDirectory() }
        )
      ).rejects.toThrow('must be an integer')
    }
  )

  test.each(['__proto__', 'constructor'])(
    'rejects BOOTSTRAP_MARKETS prototype key %s without exposing input',
    async key => {
      const raw = `[{"${key}":"private-json-marker"}]`
      const error = await ConfigService.load(
        { ...environment, BOOTSTRAP_MARKETS: raw },
        { cwd: await temporaryDirectory() }
      ).catch(error => error)
      expect(error).toBeInstanceOf(ConfigValidationError)
      expect(JSON.stringify(error)).not.toContain('private-json-marker')
    }
  )

  test('environment market and offer-group lists completely replace YAML lists', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    await writeFile(
      path,
      yaml()
        .replace(`    - "${marketId}"`, `    - "${marketId}"\n    - "${secondMarketId}"`)
        .replace('  v0OfferGroupIds: []', `  v0OfferGroupIds:\n    - "${marketId}"`)
        .replace(/bootstrap:[\s\S]*/, 'bootstrap: []\n')
    )

    const replaced = await ConfigService.load(
      { MARKET_IDS: secondMarketId, V0_OFFER_GROUP_IDS: secondMarketId },
      { configPath: path }
    )
    const emptied = await ConfigService.load(
      { MARKET_IDS: secondMarketId, V0_OFFER_GROUP_IDS: '' },
      { configPath: path }
    )

    expect(replaced.setup.marketIds).toEqual([secondMarketId])
    expect(replaced.v0OfferGroupIds).toEqual([secondMarketId])
    expect(emptied.setup.marketIds).toEqual([secondMarketId])
    expect(emptied.v0OfferGroupIds).toEqual([])
  })

  test('rejects oversized BOOTSTRAP_MARKETS before parsing without exposing input', async () => {
    const secret = 'private-oversized-bootstrap-marker'
    const raw = `["${secret}${'x'.repeat(1_048_576)}"]`

    const error = await ConfigService.load(
      { ...environment, BOOTSTRAP_MARKETS: raw },
      { cwd: await temporaryDirectory() }
    ).catch(error => error)

    expect(error).toBeInstanceOf(ConfigValidationError)
    expect(error.field).toBe('BOOTSTRAP_MARKETS')
    expect(error.reason).toBe('too-large')
    expect(error.message).toBe('BOOTSTRAP_MARKETS exceeds the maximum supported size')
    expect(JSON.stringify(error)).not.toContain(secret)
  })

  test('sanitizes BOOTSTRAP_MARKETS parser failures and rejects YAML syntax', async () => {
    const secret = 'private-bootstrap-parser-marker'

    const malformedError = await ConfigService.load(
      { ...environment, BOOTSTRAP_MARKETS: `[{"marketId":"${secret}"` },
      { cwd: await temporaryDirectory() }
    ).catch(error => error)
    const yamlSyntaxError = await ConfigService.load(
      { ...environment, BOOTSTRAP_MARKETS: `- marketId: ${marketId}` },
      { cwd: await temporaryDirectory() }
    ).catch(error => error)

    for (const error of [malformedError, yamlSyntaxError]) {
      expect(error).toBeInstanceOf(ConfigValidationError)
      expect(error.reason).toBe('malformed-json')
      expect(error.message).toBe('BOOTSTRAP_MARKETS must be a JSON array with unique object keys')
    }
    expect(JSON.stringify(malformedError)).not.toContain(secret)
  })

  test('never includes secret YAML or environment values in errors', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'operator.yaml')
    const yamlSecret = 'yaml-private-secret-marker'
    const envSecret = 'env-private-secret-marker'
    await writeFile(path, yaml().replace(`0x${'11'.repeat(32)}`, yamlSecret))
    const yamlError = await ConfigService.load({}, { configPath: path }).catch(error => error)
    const envError = await ConfigService.load(
      { MAKER_PRIVATE_KEY: envSecret },
      { configPath: path }
    ).catch(error => error)
    expect(JSON.stringify(yamlError)).not.toContain(yamlSecret)
    expect(yamlError.message).not.toContain(yamlSecret)
    expect(JSON.stringify(envError)).not.toContain(envSecret)
    expect(envError.message).not.toContain(envSecret)
  })
})
