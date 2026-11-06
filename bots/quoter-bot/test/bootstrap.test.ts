import type { Entry } from '@repo/kernel'
import type { Address, Hex } from 'viem'

import { MarketUtils, Offer, Tree } from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { midnightPublicationPlan, midnightTreeWitness } from '@repo/validators'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { maxUint256, zeroAddress } from 'viem'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'

import type { MarketReport } from '../src/application/engine/market-report'
import type {
  SetupCheckReport,
  SetupStateService
} from '../src/application/setup/setup-check.service'
import type { ConfigService as RuntimeConfig } from '../src/config/config.service'
import type { BootstrapAdapters } from '../src/infrastructure/bootstrap/production-bootstrap'
import type { WorldReads } from '../src/infrastructure/engine/world-reads'
import type { LadderAdapters } from '../src/infrastructure/ladder/production-ladder'
import type { ReferenceRates } from '../src/infrastructure/reference/reference-rates'

import { createMarketProjection } from '../src/application/monitoring/market-monitoring.utils'
import { createApplication as composeApplication } from '../src/bootstrap'
import { ConfigService } from '../src/config/config.service'
import {
  SetupFailedError,
  ConfigValidationError,
  BootstrapMempoolValidationError,
  StrategyStateVersionError,
  QuoterStartError,
  SetupCheckAbortedError
} from '../src/errors'
import { runQuoterBotEntrypoint } from '../src/infrastructure/cli/quoter-bot-entrypoint'
import { productionReferenceRates } from '../src/infrastructure/reference/reference-rates'
import { dryHosting, quoterKernelConfig } from '../src/kernel'
import { startQuoterEngine, type StartupWithdrawal } from '../src/run'

const CHAIN_ID = 8453
const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const delegatedSigner: Address = '0x1563915e194D8CfBA1943570603F7606A3115508'
const midnight: Address = '0x2222222222222222222222222222222222222222'
const loanAsset: Address = '0x3333333333333333333333333333333333333333'
const ratifier: Address = '0xd6e70365C8E8DDa9a4ca662C07bbE663b017755E'
const market = {
  chainId: BigInt(CHAIN_ID),
  midnight: getChainAddress(CHAIN_ID, 'midnight'),
  loanToken: loanAsset,
  collateralParams: [
    {
      token: '0x4200000000000000000000000000000000000006' as Address,
      lltv: 770_000_000_000_000_000n,
      liquidationCursor: 250_000_000_000_000_000n,
      oracle: '0x0000000000000000000000000000000000008000' as Address
    }
  ],
  maturity: BigInt(Date.UTC(2027, 0, 1, 15) / 1000),
  rcfThreshold: 0n,
  enterGate: zeroAddress,
  liquidatorGate: zeroAddress
}
/** The configured Market is a real Midnight Market, so the kernel's validator admits its offers. */
const marketId = MarketUtils.toId(market)
const referenceMarketId: Hex = `0x${'77'.repeat(32)}`
const environment = {
  CHAIN_ID: String(CHAIN_ID),
  RPC_URL: 'https://rpc.example',
  REFERENCE_RPC_URL: 'https://archive.example',
  MAKER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  MAKER_ADDRESS: maker,
  MIDNIGHT_ADDRESS: midnight,
  LOAN_ASSET_ADDRESS: loanAsset,
  RATIFIER_ADDRESS: ratifier,
  MARKET_IDS: marketId,
  REFERENCE_MARKET_ID: referenceMarketId,
  NATIVE_RESERVE_WEI: '10',
  MAX_FEE_GWEI: '100',
  MAX_TRANSACTION_SPEND_WEI: '100000000000000000',
  MAX_CONTINUOUS_FEE_CAP: '0',
  KERNEL_ENROLLMENT: 'enrolling',
  MAX_PUBLICATION_GAS: '5000000',
  MAX_PUBLICATION_DATA_BYTES: '65536',
  MAX_CANCELLATION_GAS: '100000',
  MAX_BATCH_CANCELLATION_GAS: '1000000',
  MAX_BATCH_CANCELLATION_DATA_BYTES: '65536',
  MAX_RATIFICATION_GAS: '100000',
  MORPHO_API_BASE_URL: 'https://api.example',
  ROUTER_API_BASE_URL: 'https://router.example'
}
const ladderConfiguration = {
  marketId,
  quotePremiumBps: '0',
  spreadBps: '200',
  stepBps: '100',
  rungCount: '2',
  sizeSkewBps: '0',
  lowerRateBudgetAssets: '10',
  higherRateBudgetAssets: '10',
  targetMarketExposureAssets: '20',
  maximumTotalExposureAssets: '20',
  minimumOfferAssets: '1',
  groupMode: 'shared-rung',
  loopIntervalSeconds: '3600',
  movementToleranceBps: '10',
  minimumRateBps: '100',
  maximumRateBps: '1000'
}
const bootstrapConfiguration = {
  marketId,
  creditTarget: '100',
  acceptanceAssets: '0',
  offerSize: '10',
  premiumBps: '0',
  maximumMarketExposure: '100',
  maximumTotalExposure: '100',
  minimumRateBps: '300',
  maximumRateBps: '1000',
  autoRefill: false
}
const ladderEnvironment = { ...environment, LADDER_MARKETS: JSON.stringify([ladderConfiguration]) }
const bootstrapEnvironment = {
  ...environment,
  BOOTSTRAP_MARKETS: JSON.stringify([bootstrapConfiguration])
}
const combinedEnvironment = {
  ...environment,
  BOOTSTRAP_MARKETS: JSON.stringify([bootstrapConfiguration]),
  LADDER_MARKETS: JSON.stringify([ladderConfiguration])
}

const readyState = (): SetupStateService => {
  return {
    getChainId: async () => CHAIN_ID,
    getReferenceChainId: async () => CHAIN_ID,
    getCode: async () => '0x1234',
    getDerivedSigner: async () => maker,
    getAuthorization: async () => true,
    getNativeBalance: async () => 10n,
    getLoanAllowance: async () => ({ spender: midnight, amount: maxUint256 }),
    getRatifier: async () => ({
      listed: true,
      deployed: true,
      midnightMatches: true,
      surfaceMatches: true,
      authorized: true
    }),
    getBook: async id => ({
      id,
      allowlisted: true,
      active: true,
      loanAsset,
      tickSpacing: 4
    }),
    checkReference: async () => ({
      marketId: referenceMarketId,
      referenceReadable: true,
      archiveReadable: true
    }),
    inspectOffers: async () => ({
      unknownNamespaces: [],
      unknownMarketIds: [],
      invertedMarketIds: []
    }),
    getDebt: async () => 0n,
    getLoanCollateral: async () => undefined
  }
}

const failingReadiness = () => {
  const state = readyState()
  state.getChainId = async () => 1
  return state
}

const offerTree = (buy: boolean, start = 1n) =>
  Tree.create([
    Offer.create({
      market,
      buy,
      maker,
      start,
      expiry: market.maturity,
      ratifier: getChainAddress(CHAIN_ID, 'ecrecoverRatifier'),
      tick: 6_000n,
      maxUnits: 10n,
      continuousFeeCap: 0n
    } as Parameters<typeof Offer.create>[0])
  ])

const noCrossing = { crossed: false, clearable: false } as const
const NOW = BigInt(Date.UTC(2026, 9, 1) / 1000)

/** A world with `cash` and no credit on the configured market, and nothing indexed or on its book. */
const worldReads = (cash = 0n): WorldReads => ({
  readLatestBlock: async () => ({ number: 1n, hash: `0x${'01'.repeat(32)}`, timestamp: NOW }),
  readMarket: async () => {
    throw new Error('these reads prepare nothing')
  },
  readGroups: async () => [],
  readBook: async () => [],
  readPosition: async id => ({
    marketId: id,
    credit: 0n,
    debt: 0n,
    lossFactor: 0n,
    maturity: market.maturity,
    tickSpacing: 4,
    continuousFee: 0
  }),
  readCash: async () => ({ cashBalance: cash, allowance: cash }),
  readConsumed: async groupIds => groupIds.map(() => 0n)
})

/** Enough cash for either strategy to publish. */
const fundedWorld = () => worldReads(100n)

const staticRates =
  (rateBps = 500n): ReferenceRates =>
  async markets =>
    markets.map(() => ({
      ok: true,
      value: { mode: 'static', rateBps, observationId: `static:${rateBps}` }
    }))

/** Ladder preparation that never proves a publication safe. */
const ladderAdapters = (overrides: Partial<LadderAdapters> = {}): LadderAdapters => ({
  prepareReplacement: async () => {
    throw new Error('these readers prepare nothing')
  },
  validateRatified: async () => {},
  ...overrides
})

/** Ladder preparation that publishes the desired buys; its kept publication reads back as active. */
const publishingLadderAdapters = (onPrepare?: () => void): LadderAdapters => {
  const tree = offerTree(true, 2n)
  return ladderAdapters({
    prepareReplacement: vi.fn<LadderAdapters['prepareReplacement']>(async ({ desired }) => {
      onPrepare?.()
      return {
        reconciliation: {
          preparedAtTimestamp: 1n,
          applied: true,
          bookCrossing: { lower: noCrossing, higher: noCrossing }
        },
        publication: {
          quote: desired,
          groups: [
            {
              groupId: tree.offers[0]!.group,
              side: 'higher',
              rungIndexes: desired.higher.map(rung => rung.index),
              ticks: [6_000n]
            }
          ],
          witness: midnightTreeWitness(tree)
        }
      }
    })
  })
}

/** Bootstrap preparation that never proves a publication safe. */
const bootstrapAdapters = (overrides: Partial<BootstrapAdapters> = {}): BootstrapAdapters => ({
  prepareReplacement: async () => {
    throw new Error('a position without cash prepares nothing')
  },
  validateRatified: async () => {},
  ...overrides
})

/** Bootstrap preparation that publishes the desired offer; its kept intent reads back as active. */
const publishingBootstrapAdapters = (onPrepare?: () => void): BootstrapAdapters => {
  const tree = offerTree(true)
  return bootstrapAdapters({
    prepareReplacement: vi.fn<BootstrapAdapters['prepareReplacement']>(async ({ desiredOffer }) => {
      onPrepare?.()
      return {
        offer: desiredOffer,
        publication: {
          groupId: tree.offers[0]!.group,
          tick: 6_000n,
          continuousFeeCap: 0n,
          witness: midnightTreeWitness(tree)
        }
      }
    })
  })
}

const dryKernel = (config: RuntimeConfig) => dryHosting(config)

/**
 * A dry kernel for `--readonly` built from the writer configuration, since `quoterKernelConfig`
 * reads the write policy a read-only configuration lacks; the pinned failure below tracks that.
 */
const readOnlyKernel = async (readOnlyEnvironment: Record<string, string | undefined>) => {
  const writer = await ConfigService.load({
    ...readOnlyEnvironment,
    MAKER_PRIVATE_KEY: environment.MAKER_PRIVATE_KEY
  })
  return () => dryHosting(writer)
}

/** One live publication an earlier run left in the kernel's ledger, as the dry kernel records it. */
const earlierRunEntries = (config: RuntimeConfig): Record<string, Entry> => {
  const kernelConfig = quoterKernelConfig(config, maker)
  const [step] = midnightPublicationPlan({
    chainId: CHAIN_ID,
    maker,
    signer: maker,
    tree: offerTree(true),
    ratifier: 'ecrecover'
  }).steps
  const validator = kernelConfig.validators[0]!
  const reading = validator.read(step!.payload!, step!.witness, {
    account: maker,
    chainId: CHAIN_ID
  })
  if (!reading.ok) throw new Error(reading.reason)
  return Object.fromEntries(
    reading.creates.map(spec => [
      spec.id,
      {
        spec,
        state: 'live',
        intentId: 'earlier-run',
        validator: `${validator.id}@${validator.version}`,
        creators: [],
        deadCreators: [],
        origin: { payload: step!.payload!, witness: step!.witness },
        consumedFinal: 0n,
        recoveryAttempts: 0,
        stuck: false,
        compensate: false,
        affirmedAt: Date.now()
      } satisfies Entry
    ])
  )
}

const createApplication: typeof composeApplication = (environment, dependencies) =>
  composeApplication(environment, {
    kernel: dryKernel,
    createWorldReads: () => worldReads(),
    createReferenceRates: () => staticRates(),
    ...dependencies
  })

type Written = { event: string; notice?: string; [field: string]: unknown }

const recorder = () => {
  const written: Written[] = []
  return { written, writeEvent: (value: unknown) => void written.push(value as Written) }
}

describe('createApplication', () => {
  const originalStateHome = process.env.XDG_STATE_HOME
  let stateHome: string | undefined

  beforeAll(async () => {
    stateHome = await mkdtemp(join(tmpdir(), 'quoter-bot-composition-state-'))
    process.env.XDG_STATE_HOME = stateHome
  })

  afterAll(async () => {
    if (originalStateHome === undefined) delete process.env.XDG_STATE_HOME
    else process.env.XDG_STATE_HOME = originalStateHome
    if (stateHome) await rm(stateHome, { recursive: true, force: true })
  })

  test('wires configuration, setup service, and operator CLI through the composition root', async () => {
    const application = createApplication(environment, { createState: readyState })

    const output = await application.run(['setup-check'])

    expect(output).toMatchObject({ ready: true })
    expect(
      (output as { checks: { name: string; status: string }[] }).checks.map(check => [
        check.name,
        check.status
      ])
    ).toEqual([
      ['chain', 'passed'],
      ['signer', 'passed'],
      ['native-balance', 'passed'],
      ['signer-native-balance', 'not-required'],
      ['signer-authorization', 'not-required'],
      ['loan-allowance', 'passed'],
      ['ratifier', 'passed'],
      ['books', 'passed'],
      ['reference', 'not-required'],
      ['offers', 'passed'],
      ['position-health', 'not-required']
    ])
  })

  test('refuses to start on strategy state an earlier version wrote, naming the procedure', async () => {
    const stateHome = await mkdtemp(join(tmpdir(), 'quoter-bot-state-home-'))
    vi.stubEnv('XDG_STATE_HOME', stateHome)
    try {
      await mkdir(join(stateHome, 'morpho-quoter-bot'), { mode: 0o700 })
      await writeFile(
        join(stateHome, 'morpho-quoter-bot', `0x${'ab'.repeat(32)}.json`),
        JSON.stringify({ version: 6, offers: [] }),
        { mode: 0o600 }
      )
      const createState = vi.fn(readyState)
      const stderr: string[] = []

      const exitCode = await runQuoterBotEntrypoint(
        createApplication(environment, { createState }),
        ['setup-check'],
        { writeOut: () => undefined, writeError: value => stderr.push(value) }
      )

      expect(exitCode).toBe(1)
      expect(stderr.join('')).toContain(new StrategyStateVersionError().message)
      expect(createState).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
      await rm(stateHome, { recursive: true, force: true })
    }
  })

  test('applies CLI signer selection over environment configuration', async () => {
    let method: string | undefined
    const application = createApplication(
      {
        ...environment,
        AWS_KMS_KEY_ID: 'alias/cli-selected',
        AWS_REGION: 'eu-west-1',
        SIGNER_NATIVE_RESERVE_WEI: '10'
      },
      {
        createState: config => {
          method = config.keyStorageMethod
          return { ...readyState(), getDerivedSigner: async () => delegatedSigner }
        }
      }
    )

    await application.run(['--aws', 'setup-check'])

    expect(method).toBe('aws')
  })

  test('CLI --interactive clears an environment keystore password', async () => {
    let password: string | undefined
    const application = createApplication(
      {
        ...environment,
        MAKER_PRIVATE_KEY: undefined,
        KEY_STORAGE_METHOD: 'keystore',
        KEYSTORE_PATH: '/environment/maker.json',
        KEYSTORE_PASSWORD: 'environment-password'
      },
      {
        readPassword: async () => ' interactive-password ',
        createState: config => {
          password =
            !config.identity.readOnly && config.identity.method === 'keystore'
              ? config.identity.password
              : undefined
          return readyState()
        }
      }
    )

    await application.run(['--keystore', '/cli/maker.json', '--interactive', 'setup-check'])

    expect(password).toBe(' interactive-password ')
  })

  test('CLI --password clears environment interactive mode', async () => {
    let password: string | undefined
    const application = createApplication(
      {
        ...environment,
        MAKER_PRIVATE_KEY: undefined,
        KEY_STORAGE_METHOD: 'keystore',
        KEYSTORE_PATH: '/environment/maker.json',
        KEYSTORE_INTERACTIVE: 'true'
      },
      {
        readPassword: async () => {
          throw new Error('interactive reader must not be called')
        },
        createState: config => {
          password =
            !config.identity.readOnly && config.identity.method === 'keystore'
              ? config.identity.password
              : undefined
          return readyState()
        }
      }
    )

    await application.run([
      '--keystore',
      '/cli/maker.json',
      '--password',
      ' cli-password ',
      'setup-check'
    ])

    expect(password).toBe(' cli-password ')
  })

  test.each([
    ['interactive', 'keystorePassword: yaml-password', ['--interactive'], ' prompted-password '],
    ['password', 'keystoreInteractive: true', ['--password', ' cli-password '], ' cli-password ']
  ])(
    'CLI --%s clears the opposite YAML keystore password mode',
    async (_mode, yamlPasswordMode, cliPasswordMode, expectedPassword) => {
      const directory = await mkdtemp(join(tmpdir(), 'quoter-bot-cli-precedence-'))
      const configPath = join(directory, 'operator.yaml')
      await writeFile(
        configPath,
        `chain:\n  id: 8453\n  rpcUrl: https://rpc.example\n  archiveRpcUrl: https://archive.example\nidentity:\n  makerAddress: ${maker}\n  keyStorageMethod: keystore\n  keystorePath: /yaml/maker.json\n  ${yamlPasswordMode}\ncontracts:\n  midnightAddress: ${midnight}\n  loanAssetAddress: ${loanAsset}\n  ratifierAddress: ${ratifier}\napis:\n  morphoBaseUrl: https://api.example\n  routerBaseUrl: https://router.example\nmarkets:\n  allowlist: [${marketId}]\n  referenceMarketId: ${referenceMarketId}\nsetup:\n  nativeReserveWei: 10\n  maxFeeGwei: 100\n  maxTransactionSpendWei: 100000000000000000\n  maxContinuousFeeCap: 0\n  kernelEnrollment: enrolling\n  maxPublicationGas: 5000000\n  maxPublicationDataBytes: 65536\n  maxCancellationGas: 100000\n  maxBatchCancellationGas: 1000000\n  maxBatchCancellationDataBytes: 65536\n  maxRatificationGas: 100000\n`
      )
      let password: string | undefined
      try {
        const application = createApplication(
          {},
          {
            readPassword: async () => ' prompted-password ',
            createState: config => {
              password =
                !config.identity.readOnly && config.identity.method === 'keystore'
                  ? config.identity.password
                  : undefined
              return readyState()
            }
          }
        )
        await application.run([
          '--config',
          configPath,
          '--keystore',
          '/cli/maker.json',
          ...cliPasswordMode,
          'setup-check'
        ])
        expect(password).toBe(expectedPassword)
      } finally {
        await rm(directory, { recursive: true })
      }
    }
  )

  test('rejects conflicting CLI signer selections', async () => {
    const application = createApplication(environment, { createState: readyState })
    await expect(
      application.run(['--private-key', `0x${'11'.repeat(32)}`, '--aws', 'setup-check'])
    ).rejects.toMatchObject({ field: 'KEY_STORAGE_METHOD', reason: 'conflicting-sources' })
  })

  test('rejects a CLI password without an explicit keystore path', async () => {
    const application = createApplication(environment, { createState: readyState })

    await expect(application.run(['--password', 'secret', 'setup-check'])).rejects.toMatchObject({
      code: 'INVALID_USAGE'
    })
  })

  test('composes explicit invalidation without the offer-readiness gate', async () => {
    const groupId: Hex = `0x${'12'.repeat(32)}`
    const txHash: Hex = `0x${'ab'.repeat(32)}`
    const events: string[] = []
    const application = createApplication(environment, {
      createState: () => {
        throw new Error('setup state must not be constructed')
      },
      createInvalidation: () => ({
        run: async () => {
          events.push('run')
          return {
            status: 'applied',
            scope: 'all',
            matchedGroups: 1,
            invalidatedGroups: [{ groupId, txHash }]
          }
        }
      })
    })

    expect(await application.run(['invalidate'])).toEqual({
      status: 'applied',
      scope: 'all',
      matchedGroups: 1,
      invalidatedGroups: [{ groupId, txHash }]
    })
    expect(events).toEqual(['run'])
  })

  test('quoter-bot bootstrap passes readiness before the kernel admits its publication', async () => {
    const events: string[] = []
    const state = readyState()
    state.getChainId = async () => {
      events.push('readiness')
      return CHAIN_ID
    }
    const application = createApplication(bootstrapEnvironment, {
      createState: () => state,
      createWorldReads: fundedWorld,
      createBootstrapAdapters: () => publishingBootstrapAdapters(() => events.push('prepare'))
    })

    expect(
      await application.run(['bootstrap'], {
        writeEvent: value =>
          void events.push(`${(value as Written).event}:${(value as Written).notice}`)
      })
    ).toEqual([
      {
        workflow: 'bootstrap',
        marketId,
        status: 'applied',
        action: 'publish',
        transactions: [{ operation: 'publish', txHash: 'dry-tx-0-1' }]
      }
    ])
    expect(events.indexOf('readiness')).toBe(0)
    expect(events.indexOf('kernel.notice:admitted')).toBeGreaterThan(events.indexOf('prepare'))
  })

  test('withholds a cash-bound bootstrap buy below the Router minimum, and halts on any other cap', async () => {
    const belowMinimum = () =>
      bootstrapAdapters({
        prepareReplacement: async () => {
          throw new BootstrapMempoolValidationError([
            { rule: 'min_offer_assets_usd', minimumAssets: 100n }
          ])
        }
      })
    const cashBound = createApplication(bootstrapEnvironment, {
      createState: readyState,
      createWorldReads: () => worldReads(5n),
      createBootstrapAdapters: belowMinimum
    })
    const { written, writeEvent } = recorder()

    const reports = (await cashBound.run(['bootstrap'], { writeEvent })) as MarketReport[]
    expect(reports).toEqual([
      {
        workflow: 'bootstrap',
        marketId,
        status: 'observed',
        action: 'publication-withheld',
        reason: 'below-minimum-offer',
        minimumAssets: '100'
      }
    ])
    expect(written).toEqual(expect.arrayContaining([...createMarketProjection()(reports)]))

    const sizeBound = createApplication(bootstrapEnvironment, {
      createState: readyState,
      createWorldReads: fundedWorld,
      createBootstrapAdapters: belowMinimum
    })
    await expect(sizeBound.run(['bootstrap'])).rejects.toMatchObject({
      name: 'QuoterRunFailedError',
      report: { status: 'halted', halt: 'bootstrap-decision-failed' }
    })
  })

  test('quoter-bot ladder passes readiness before the kernel admits its publication', async () => {
    const events: string[] = []
    const state = readyState()
    state.getChainId = async () => {
      events.push('readiness')
      return CHAIN_ID
    }
    const application = createApplication(ladderEnvironment, {
      kernel: dryKernel,
      createState: () => state,
      createWorldReads: fundedWorld,
      createLadderAdapters: () => publishingLadderAdapters(() => events.push('prepare'))
    })

    expect(
      await application.run(['ladder'], {
        writeEvent: value =>
          void events.push(`${(value as Written).event}:${(value as Written).notice}`)
      })
    ).toEqual([
      {
        workflow: 'ladder',
        marketId,
        status: 'applied',
        action: 'publish',
        reason: 'publish',
        transactions: [{ operation: 'publish', txHash: 'dry-tx-0-1' }]
      }
    ])
    expect(events.indexOf('readiness')).toBe(0)
    expect(events.indexOf('kernel.notice:admitted')).toBeGreaterThan(events.indexOf('prepare'))
  })

  test('reports a one-shot cycle whose readings arrive before readiness completes', async () => {
    const application = createApplication(bootstrapEnvironment, {
      createState: readyState,
      createBootstrapAdapters: () => bootstrapAdapters()
    })

    expect(await application.run(['bootstrap'])).toEqual([
      { workflow: 'bootstrap', marketId, status: 'observed', action: 'no-capacity' }
    ])
  })

  test('does not run a bootstrap cycle when shutdown arrives during bootstrap adapter composition', async () => {
    const controller = new AbortController()
    const adapters = publishingBootstrapAdapters()
    const application = createApplication(combinedEnvironment, {
      createState: readyState,
      createLadderAdapters: () => ladderAdapters(),
      createBootstrapAdapters: () => {
        controller.abort()
        return adapters
      }
    })

    await expect(
      application.run(['bootstrap'], { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(adapters.prepareReplacement).not.toHaveBeenCalled()
  })

  test('rejects a bootstrap command with no bootstrap market before composing any reader', async () => {
    const createLadderAdapters = vi.fn(() => ladderAdapters())
    const application = createApplication(
      {
        ...environment,
        BOOTSTRAP_MARKETS: '[]',
        LADDER_MARKETS: JSON.stringify([ladderConfiguration])
      },
      { createState: readyState, createLadderAdapters }
    )

    await expect(application.run(['bootstrap'])).rejects.toMatchObject({
      name: 'BootstrapConfigurationError'
    })
    expect(createLadderAdapters).not.toHaveBeenCalled()
  })

  test('starts a hardcoded-only bootstrap workflow without Blue reference readiness', async () => {
    const state = readyState()
    const checkReference = vi.fn(async () => {
      throw new Error('Blue archive unavailable')
    })
    state.checkReference = checkReference
    const application = createApplication(
      {
        ...environment,
        REFERENCE_RPC_URL: undefined,
        REFERENCE_MARKET_ID: undefined,
        BOOTSTRAP_MARKETS: JSON.stringify([
          {
            ...bootstrapConfiguration,
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
          }
        ]),
        LADDER_MARKETS: JSON.stringify([
          {
            ...ladderConfiguration,
            targetRate: { strategy: 'variable_rate_avg' }
          }
        ])
      },
      {
        createState: () => state,
        createBootstrapAdapters: () => bootstrapAdapters(),
        createReferenceRates: productionReferenceRates
      }
    )

    await expect(application.run(['bootstrap'])).resolves.toEqual([
      { workflow: 'bootstrap', marketId, status: 'observed', action: 'no-capacity' }
    ])
    expect(checkReference).not.toHaveBeenCalled()
    await expect(application.run(['ladder'])).rejects.toBeInstanceOf(ConfigValidationError)
  })

  test('keeps Blue reference readiness fail-closed for variable-rate bootstrap workflows', async () => {
    const state = readyState()
    const checkReference = vi.fn(async () => {
      throw new Error('Blue archive unavailable')
    })
    state.checkReference = checkReference
    const application = createApplication(
      {
        ...environment,
        BOOTSTRAP_MARKETS: JSON.stringify([
          {
            ...bootstrapConfiguration,
            targetRate: { strategy: 'variable_rate_avg' }
          }
        ])
      },
      { createState: () => state, createBootstrapAdapters: () => bootstrapAdapters() }
    )

    await expect(application.run(['bootstrap'])).rejects.toBeInstanceOf(SetupFailedError)
    expect(checkReference).toHaveBeenCalledTimes(1)
  })

  test('keeps Blue reference readiness fail-closed for a variable-rate ladder', async () => {
    const state = readyState()
    const checkReference = vi.fn(async () => {
      throw new Error('Blue archive unavailable')
    })
    const createLadderAdapters = vi.fn(() => ladderAdapters())
    state.checkReference = checkReference
    const application = createApplication(
      {
        ...environment,
        BOOTSTRAP_MARKETS: '[]',
        LADDER_MARKETS: JSON.stringify([
          {
            ...ladderConfiguration,
            targetRate: { strategy: 'variable_rate_avg' }
          }
        ])
      },
      { createState: () => state, createLadderAdapters }
    )

    await expect(application.run(['ladder'])).rejects.toBeInstanceOf(SetupFailedError)
    expect(checkReference).toHaveBeenCalledTimes(1)
    expect(createLadderAdapters).toHaveBeenCalledTimes(1)
  })

  test('starts a hardcoded-only ladder workflow without Blue reference readiness', async () => {
    const state = readyState()
    const checkReference = vi.fn(async () => {
      throw new Error('Blue archive unavailable')
    })
    state.checkReference = checkReference
    const application = createApplication(
      {
        ...environment,
        REFERENCE_RPC_URL: undefined,
        REFERENCE_MARKET_ID: undefined,
        BOOTSTRAP_MARKETS: JSON.stringify([
          {
            ...bootstrapConfiguration,
            targetRate: { strategy: 'variable_rate_avg' }
          }
        ]),
        LADDER_MARKETS: JSON.stringify([
          {
            ...ladderConfiguration,
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '475' }
          }
        ])
      },
      {
        createState: () => state,
        createLadderAdapters: () => ladderAdapters(),
        createWorldReads: fundedWorld,
        createReferenceRates: productionReferenceRates
      }
    )

    // These readers prepare nothing, so the run ends on that failure rather than on the reference.
    await expect(application.run(['ladder'])).rejects.toMatchObject({
      name: 'QuoterRunFailedError',
      report: { markets: [{ workflow: 'ladder', marketId, status: 'failed', stage: 'reconcile' }] }
    })
    expect(checkReference).not.toHaveBeenCalled()
    await expect(application.run(['bootstrap'])).rejects.toBeInstanceOf(ConfigValidationError)
  })

  test('setup-check composes hardcoded bootstrap and ladder strategies without Blue reference readiness', async () => {
    const state = readyState()
    const checkReference = vi.fn(async () => {
      throw new Error('Blue archive unavailable')
    })
    state.checkReference = checkReference
    const application = createApplication(
      {
        ...environment,
        REFERENCE_RPC_URL: undefined,
        REFERENCE_MARKET_ID: undefined,
        BOOTSTRAP_MARKETS: JSON.stringify([
          {
            ...bootstrapConfiguration,
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
          }
        ]),
        LADDER_MARKETS: JSON.stringify([
          {
            ...ladderConfiguration,
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '475' }
          }
        ])
      },
      { createState: () => state }
    )

    const report = (await application.run(['setup-check'])) as SetupCheckReport

    expect(report.ready).toBe(true)
    expect(report.checks.find(check => check.name === 'reference')).toMatchObject({
      status: 'not-required',
      observed: { reason: 'no variable_rate_avg target-rate strategy is active' }
    })
    expect(checkReference).not.toHaveBeenCalled()
  })

  test('setup-check fails closed when the bootstrap and ladder strategy union requires Blue', async () => {
    const application = createApplication(
      {
        ...environment,
        REFERENCE_RPC_URL: undefined,
        REFERENCE_MARKET_ID: undefined,
        BOOTSTRAP_MARKETS: JSON.stringify([
          {
            ...bootstrapConfiguration,
            targetRate: { strategy: 'variable_rate_avg' }
          }
        ]),
        LADDER_MARKETS: JSON.stringify([
          {
            ...ladderConfiguration,
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '475' }
          }
        ])
      },
      { createState: readyState }
    )

    await expect(application.run(['setup-check'])).rejects.toBeInstanceOf(ConfigValidationError)
  })

  describe('writer startup failure', () => {
    const withdrawnEvent = {
      event: 'startup.owned-offers-cancelled',
      errorName: 'SetupFailedError',
      ladder: { status: 'succeeded', transactions: [] },
      bootstrap: { status: 'succeeded', transactions: [] }
    }

    const earlierRunKernel = (config: RuntimeConfig) =>
      dryHosting(config, earlierRunEntries(config))

    test.each(['bootstrap', 'ladder'])(
      'withdraws what an earlier run left before %s surfaces a failed readiness check',
      async command => {
        const { written, writeEvent } = recorder()
        const application = createApplication(combinedEnvironment, {
          createState: failingReadiness,
          kernel: earlierRunKernel,
          createLadderAdapters: () => publishingLadderAdapters(),
          createBootstrapAdapters: () => publishingBootstrapAdapters()
        })

        await expect(application.run([command], { writeEvent })).rejects.toBeInstanceOf(
          SetupFailedError
        )
        const notices = written.filter(event => event.event === 'kernel.notice')
        expect(notices.map(event => event.notice)).toEqual(['admitted', 'settled'])
        expect(new Set(notices.map(event => event.intentId)).size).toBe(1)
        expect(written.at(-1)).toEqual(withdrawnEvent)
      }
    )

    test('start reports the startup withdrawal before surfacing a failed readiness check', async () => {
      const { written, writeEvent } = recorder()
      const application = createApplication(combinedEnvironment, {
        createState: failingReadiness,
        createLadderAdapters: () => ladderAdapters(),
        createBootstrapAdapters: () => bootstrapAdapters()
      })

      await expect(application.run(['start'], { writeEvent })).rejects.toBeInstanceOf(
        SetupFailedError
      )
      expect(written).toContainEqual(withdrawnEvent)
    })

    test('never acts in read-only mode when readiness fails', async () => {
      const readOnlyEnvironment = { ...combinedEnvironment, MAKER_PRIVATE_KEY: undefined }
      const { written, writeEvent } = recorder()
      const ladder = publishingLadderAdapters()
      const bootstrap = publishingBootstrapAdapters()
      const application = createApplication(readOnlyEnvironment, {
        createState: failingReadiness,
        kernel: await readOnlyKernel(readOnlyEnvironment),
        createLadderAdapters: () => ladder,
        createBootstrapAdapters: () => bootstrap
      })

      await expect(application.run(['--readonly', 'start'], { writeEvent })).rejects.toBeInstanceOf(
        SetupFailedError
      )
      expect(written.map(event => event.event)).not.toContain('readonly.make')
      expect(written.map(event => event.event)).not.toContain('kernel.notice')
    })

    test('surfaces an operator abort during readiness as an abort', async () => {
      const controller = new AbortController()
      const state = readyState()
      state.getChainId = async () => {
        controller.abort()
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      }
      const application = createApplication(combinedEnvironment, {
        createState: () => state,
        createLadderAdapters: () => ladderAdapters(),
        createBootstrapAdapters: () => bootstrapAdapters()
      })

      await expect(application.run(['start'], { signal: controller.signal })).rejects.toMatchObject(
        { name: 'AbortError' }
      )
    })

    test('does not start a kernel on a configuration error before the signer is available', async () => {
      const kernel = vi.fn(dryKernel)
      const application = createApplication(
        {
          ...combinedEnvironment,
          REFERENCE_MARKET_ID: undefined,
          LADDER_MARKETS: JSON.stringify([
            { ...ladderConfiguration, targetRate: { strategy: 'variable_rate_avg' } }
          ])
        },
        { createState: readyState, kernel }
      )

      await expect(application.run(['start'])).rejects.toBeInstanceOf(ConfigValidationError)
      expect(kernel).not.toHaveBeenCalled()
    })
  })

  test('rejects an empty ladder config before composing a writer', async () => {
    const kernel = vi.fn(dryKernel)
    const application = createApplication(environment, {
      createState: readyState,
      kernel,
      createLadderAdapters: () => ladderAdapters()
    })

    await expect(application.run(['ladder'])).rejects.toMatchObject({
      name: 'LadderConfigurationError',
      field: 'ladder'
    })
    expect(kernel).not.toHaveBeenCalled()
  })

  test('rejects empty ladder monitoring before composing a writer', async () => {
    const kernel = vi.fn(dryKernel)
    const application = createApplication(environment, {
      createState: readyState,
      kernel,
      createLadderAdapters: () => ladderAdapters()
    })

    await expect(
      application.run(['ladder', '--monitor'], { signal: AbortSignal.timeout(100) })
    ).rejects.toMatchObject({ name: 'LadderConfigurationError', field: 'ladder' })
    expect(kernel).not.toHaveBeenCalled()
  })

  test('accepts a ladder-only combined writer through its readiness gate', async () => {
    const createLadderAdapters = vi.fn(() => ladderAdapters())
    const createBootstrapAdapters = vi.fn(() => bootstrapAdapters())
    const controller = new AbortController()
    const state = readyState()
    state.getChainId = async () => {
      controller.abort()
      return CHAIN_ID
    }
    const application = createApplication(ladderEnvironment, {
      kernel: dryKernel,
      createState: () => state,
      createLadderAdapters,
      createBootstrapAdapters
    })

    await expect(
      application.run(['--readonly', 'start'], { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(createLadderAdapters).toHaveBeenCalledTimes(1)
    expect(createBootstrapAdapters).not.toHaveBeenCalled()
  })

  test.each([
    ['no market', environment],
    ['only a bootstrap market', bootstrapEnvironment]
  ])('refuses a combined writer with %s before composing it', async (_name, configured) => {
    const kernel = vi.fn(dryKernel)
    const application = createApplication(configured, {
      kernel,
      createLadderAdapters: () => ladderAdapters()
    })

    await expect(application.run(['start'])).rejects.toMatchObject({
      name: 'LadderConfigurationError',
      field: 'ladder'
    })
    expect(kernel).not.toHaveBeenCalled()
  })

  test('wires --readonly without loading a maker private key', async () => {
    const observedModes: boolean[] = []
    const application = createApplication(
      { ...environment, MAKER_PRIVATE_KEY: undefined },
      {
        createState: config => {
          observedModes.push(config.readOnly)
          return readyState()
        }
      }
    )

    const output = await application.run(['--readonly', 'setup-check'])

    expect(observedModes).toEqual([true])
    expect(output).toMatchObject({ ready: true })
    expect(
      (output as { checks: { status: string }[] }).checks.slice(1, 5).map(check => check.status)
    ).toEqual(['not-required', 'passed', 'not-required', 'not-required'])
  })

  test('runs a read-only writer command over a dry kernel', async () => {
    const application = composeApplication(
      { ...bootstrapEnvironment, MAKER_PRIVATE_KEY: undefined },
      {
        kernel: dryKernel,
        createState: readyState,
        createWorldReads: () => worldReads(),
        createReferenceRates: () => staticRates(),
        createBootstrapAdapters: () => bootstrapAdapters()
      }
    )

    expect(await application.run(['--readonly', 'bootstrap'])).toEqual([
      { workflow: 'bootstrap', marketId, status: 'observed', action: 'no-capacity' }
    ])
  })

  test('logs a --readonly bootstrap publication over a dry kernel that follows a moving chain', async () => {
    const readOnlyEnvironment = { ...bootstrapEnvironment, MAKER_PRIVATE_KEY: undefined }
    const config = await ConfigService.load(readOnlyEnvironment, { readOnly: true })
    const block = (number: number) => ({
      number,
      hash: `0x${number.toString(16).padStart(64, 'b')}`,
      parentHash: `0x${(number - 1).toString(16).padStart(64, 'b')}`,
      timestamp: 1_000_000n + BigInt(number)
    })
    let head = 1_000
    const miner = setInterval(() => (head += 1), 1_500)
    const follow = {
      latest: async () => ({
        head: block(head),
        finalized: { number: head - 1, timestamp: block(head - 1).timestamp }
      }),
      block: async (number: number) => block(number),
      safe: async () => block(head - 1)
    }
    const application = createApplication(readOnlyEnvironment, {
      createState: readyState,
      kernel: () => dryHosting(config, {}, undefined, follow),
      createWorldReads: fundedWorld,
      createBootstrapAdapters: () => publishingBootstrapAdapters()
    })
    try {
      expect(await application.run(['--readonly', 'bootstrap'])).toMatchObject([
        { marketId, action: 'publish' }
      ])
    } finally {
      clearInterval(miner)
    }
  })

  test('reports --readonly bootstrap acts as logged, with the condition it would sign', async () => {
    const readOnlyEnvironment = { ...bootstrapEnvironment, MAKER_PRIVATE_KEY: undefined }
    const { written, writeEvent } = recorder()
    const adapters = publishingBootstrapAdapters()
    const application = createApplication(readOnlyEnvironment, {
      createState: readyState,
      kernel: await readOnlyKernel(readOnlyEnvironment),
      createWorldReads: fundedWorld,
      createBootstrapAdapters: () => adapters
    })

    const results = await application.run(['--readonly', 'bootstrap'], { writeEvent })

    expect(results).toMatchObject([{ marketId, action: 'publish' }])
    expect(adapters.prepareReplacement).toHaveBeenCalledTimes(1)
    expect(written).toContainEqual(
      expect.objectContaining({
        event: 'cycle.completed',
        workflow: 'bootstrap',
        status: 'logged',
        condition: expect.any(String)
      })
    )
  })

  test('reports --readonly ladder acts as logged after preparing the publication', async () => {
    const readOnlyEnvironment = { ...ladderEnvironment, MAKER_PRIVATE_KEY: undefined }
    const { written, writeEvent } = recorder()
    const adapters = publishingLadderAdapters()
    const application = createApplication(readOnlyEnvironment, {
      createState: readyState,
      kernel: await readOnlyKernel(readOnlyEnvironment),
      createWorldReads: fundedWorld,
      createLadderAdapters: () => adapters
    })

    const results = await application.run(['--readonly', 'ladder'], { writeEvent })

    expect(results).toMatchObject([{ marketId, action: 'publish', reason: 'publish' }])
    expect(adapters.prepareReplacement).toHaveBeenCalledWith(
      expect.objectContaining({ marketId, reason: 'publish' })
    )
    expect(written).toContainEqual(
      expect.objectContaining({
        event: 'cycle.completed',
        workflow: 'ladder',
        status: 'logged',
        condition: expect.any(String)
      })
    )
  })

  test('does not start the read-only ladder monitor after an aborted setup check', async () => {
    const createLadderAdapters = vi.fn(() => ladderAdapters())
    const kernel = vi.fn(dryKernel)
    const terminal = vi.spyOn(console, 'log').mockImplementation(() => {})
    const controller = new AbortController()
    controller.abort()
    const application = createApplication(
      { ...ladderEnvironment, MAKER_PRIVATE_KEY: undefined },
      { createState: readyState, kernel, createLadderAdapters }
    )

    try {
      await expect(
        application.run(['ladder', '--monitor', '--verbose', '--readonly'], {
          signal: controller.signal
        })
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(createLadderAdapters).not.toHaveBeenCalled()
      expect(kernel).not.toHaveBeenCalled()
      expect(terminal).not.toHaveBeenCalled()
    } finally {
      terminal.mockRestore()
    }
  })

  test('does not compose combined writers after an aborted setup check', async () => {
    const createBootstrapAdapters = vi.fn(() => bootstrapAdapters())
    const createLadderAdapters = vi.fn(() => ladderAdapters())
    const kernel = vi.fn(dryKernel)
    const controller = new AbortController()
    controller.abort()
    const application = createApplication(combinedEnvironment, {
      createState: readyState,
      kernel,
      createBootstrapAdapters,
      createLadderAdapters
    })

    await expect(application.run(['start'], { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(createBootstrapAdapters).not.toHaveBeenCalled()
    expect(createLadderAdapters).not.toHaveBeenCalled()
    expect(kernel).not.toHaveBeenCalled()
  })

  test('surfaces a shutdown during adapter composition as an abort, before any cycle', async () => {
    const controller = new AbortController()
    const bootstrap = publishingBootstrapAdapters()
    const ladder = publishingLadderAdapters()
    const application = createApplication(combinedEnvironment, {
      createState: readyState,
      createBootstrapAdapters: () => {
        controller.abort()
        return bootstrap
      },
      createLadderAdapters: () => ladder
    })

    await expect(application.run(['start'], { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
  })

  test('rejects an empty ladder before composing the combined writer', async () => {
    const kernel = vi.fn(dryKernel)
    const application = createApplication(
      { ...bootstrapEnvironment, LADDER_MARKETS: '[]' },
      { kernel, createLadderAdapters: () => ladderAdapters() }
    )

    await expect(application.run(['start'])).rejects.toMatchObject({
      name: 'LadderConfigurationError'
    })
    expect(kernel).not.toHaveBeenCalled()
  })

  test('aborted combined start skips Blue reference readiness and writer composition', async () => {
    const checkReference = vi.fn(async () => {
      throw new Error('Blue archive unavailable')
    })
    const state = readyState()
    state.checkReference = checkReference
    const started: string[] = []
    const controller = new AbortController()
    controller.abort()
    const application = createApplication(
      {
        ...environment,
        REFERENCE_RPC_URL: undefined,
        REFERENCE_MARKET_ID: undefined,
        BOOTSTRAP_MARKETS: JSON.stringify([
          {
            ...bootstrapConfiguration,
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
          }
        ]),
        LADDER_MARKETS: JSON.stringify([
          {
            ...ladderConfiguration,
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '475' }
          }
        ])
      },
      {
        createState: () => state,
        createBootstrapAdapters: () => {
          started.push('bootstrap')
          return bootstrapAdapters()
        },
        createLadderAdapters: () => {
          started.push('ladder')
          return ladderAdapters()
        }
      }
    )

    await expect(application.run(['start'], { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(started).toEqual([])
    expect(checkReference).not.toHaveBeenCalled()
  })

  test('combined start fails closed when the bootstrap and ladder strategy union requires Blue', async () => {
    const started: string[] = []
    const application = createApplication(
      {
        ...environment,
        REFERENCE_RPC_URL: undefined,
        REFERENCE_MARKET_ID: undefined,
        BOOTSTRAP_MARKETS: JSON.stringify([
          {
            ...bootstrapConfiguration,
            targetRate: { strategy: 'hardcoded', hardcodedRateBps: '400' }
          }
        ]),
        LADDER_MARKETS: JSON.stringify([
          {
            ...ladderConfiguration,
            targetRate: { strategy: 'variable_rate_avg' }
          }
        ])
      },
      {
        createState: readyState,
        createBootstrapAdapters: () => {
          started.push('bootstrap')
          throw new Error('bootstrap must not start')
        },
        createLadderAdapters: () => {
          started.push('ladder')
          throw new Error('ladder must not start')
        }
      }
    )

    await expect(application.run(['start'])).rejects.toBeInstanceOf(ConfigValidationError)
    expect(started).toEqual([])
  })

  test('wires explicit --config and default working-directory discovery into startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'quoter-bot-bootstrap-'))
    const configuration = `
chain:
  id: 8453
  rpcUrl: https://yaml-rpc.example
  archiveRpcUrl: https://archive.example
identity:
  makerAddress: "${maker}"
  makerPrivateKey: "${environment.MAKER_PRIVATE_KEY}"
contracts:
  midnightAddress: "${midnight}"
  loanAssetAddress: "${loanAsset}"
  ratifierAddress: "${ratifier}"
apis:
  morphoBaseUrl: https://api.example
  routerBaseUrl: https://router.example
markets:
  allowlist: ["${marketId}"]
  referenceMarketId: "${referenceMarketId}"
setup:
  nativeReserveWei: "10"
  maxFeeGwei: "100"
  maxTransactionSpendWei: "100000000000000000"
  maxContinuousFeeCap: "0"
  kernelEnrollment: enrolling
  maxPublicationGas: "5000000"
  maxPublicationDataBytes: "65536"
  maxCancellationGas: "100000"
  maxBatchCancellationGas: "1000000"
  maxBatchCancellationDataBytes: "65536"
  maxRatificationGas: "100000"
`
    try {
      await writeFile(join(directory, 'quoter-bot.yml'), configuration)
      await writeFile(
        join(directory, 'explicit.yaml'),
        configuration.replace('yaml-rpc', 'explicit-rpc')
      )
      const observed: string[] = []
      const application = createApplication(
        {},
        {
          cwd: directory,
          createState: config => {
            observed.push(config.rpcUrl)
            return readyState()
          }
        }
      )

      await application.run(['setup-check'])
      await application.run(['--config', 'explicit.yaml', 'setup-check'])

      expect(observed).toEqual(['https://yaml-rpc.example', 'https://explicit-rpc.example'])
    } finally {
      await rm(directory, { recursive: true })
    }
  })

  test('rejects setup-check readiness before any writer workflow can start', async () => {
    const application = createApplication(environment, { createState: failingReadiness })

    await expect(application.run(['setup-check'])).rejects.toBeInstanceOf(SetupFailedError)
  })
})

describe('startup cancellation through the kernel', () => {
  const unheld: Hex = `0x${'99'.repeat(32)}`
  const memoryJournal = {
    sink: { append: async () => {}, finalize: async () => {} },
    capacityBytes: 100_000_000
  }

  const start = async (entries: Record<string, Entry>, cancel: readonly Hex[]) => {
    const config = ConfigService.from(combinedEnvironment)
    const { written, writeEvent } = recorder()
    let startup: StartupWithdrawal | undefined
    const engine = await startQuoterEngine({
      config,
      strategies: { ladder: false, bootstrap: false },
      kernel: dryHosting(config, entries),
      journal: memoryJournal,
      cancel,
      writeEvent,
      onStartup: withdrawal => (startup = withdrawal)
    })
    return { engine, written, startup: () => startup, config }
  }

  test('cancels a group no ledger holds as cancel-only, in the same transaction as the held ones', async () => {
    const config = ConfigService.from(combinedEnvironment)
    const entries = earlierRunEntries(config)
    const run = await start(entries, [unheld])

    expect(run.startup()?.notice).toBe('settled')
    expect(run.startup()?.included).toHaveLength(1)
    expect(run.engine.held()).toEqual([])
    const notices = run.written.filter(event => event.event === 'kernel.notice')
    expect(notices.map(event => event.notice)).toEqual(['admitted', 'settled'])
    run.engine.stop()
    expect((await run.engine.stopped).outcome).toBe('clean')
  })

  test('cancels only unheld groups when the ledger holds none', async () => {
    const run = await start({}, [unheld])

    expect(run.startup()?.notice).toBe('settled')
    expect(run.startup()?.included).toHaveLength(1)
    run.engine.stop()
    expect((await run.engine.stopped).outcome).toBe('clean')
  })

  test('stops cleanly once its journal file reaches the run cap', async () => {
    const config = ConfigService.from(combinedEnvironment)
    const stateDirectory = await mkdtemp(join(tmpdir(), 'quoter-bot-journal-cap-'))
    const { written, writeEvent } = recorder()
    try {
      const engine = await startQuoterEngine({
        config,
        strategies: { ladder: false, bootstrap: false },
        kernel: dryHosting(config, {}),
        journal: { build: { revision: 'abcdef0123456789', imageTag: 'test' }, runCapBytes: 1 },
        stateDirectory,
        writeEvent
      })
      expect(await engine.stopped).toEqual({ outcome: 'clean', reason: 'stop requested' })
      expect(written).toContainEqual({
        event: 'journal.capped',
        bytes: expect.any(Number),
        runCapBytes: 1
      })
    } finally {
      await rm(stateDirectory, { recursive: true, force: true })
    }
  })

  test('stops the kernel when shutdown is requested while it is still starting', async () => {
    const config = ConfigService.from(combinedEnvironment)
    const operator = new AbortController()
    const unreachable = () => Promise.reject(new Error('unreachable'))
    const error = await startQuoterEngine({
      config,
      strategies: { ladder: false, bootstrap: false },
      kernel: dryHosting(config, {}, () => operator.abort(), {
        latest: unreachable,
        block: unreachable,
        safe: unreachable
      }),
      journal: memoryJournal,
      signal: operator.signal
    }).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(QuoterStartError)
    expect((error as QuoterStartError).cause).toBeInstanceOf(SetupCheckAbortedError)
    expect((error as QuoterStartError).report.outcome).toBe('clean')
  })

  test('submits nothing at startup without held or requested groups', async () => {
    const run = await start({}, [])

    expect(run.startup()).toBeUndefined()
    expect(run.written.filter(event => event.event === 'kernel.notice')).toEqual([])
    run.engine.stop()
    expect((await run.engine.stopped).outcome).toBe('clean')
  })
})
