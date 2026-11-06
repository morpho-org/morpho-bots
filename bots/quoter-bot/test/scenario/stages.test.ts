import type { JournalEntry, KeyRecord } from '@repo/engine'
import type { Block, KernelChain, KernelState, LedgerStore, TxPayload } from '@repo/kernel'
import type { Address, Hex } from 'viem'

import { MarketUtils, Offer, Tree } from '@morpho-org/midnight-sdk'
import { getChainAddress } from '@morpho-org/morpho-ts'
import { createGraph, createRunner, keyRecord } from '@repo/engine'
import { replay } from '@repo/engine/replay'
import { available, createKernel } from '@repo/kernel'
import { midnightCommitmentId, midnightTreeWitness } from '@repo/validators'
import { setTimeout as sleep } from 'node:timers/promises'
import { zeroAddress } from 'viem'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { WorldOwnership } from '../../src/application/engine/world'
import type { MonitoringEvent } from '../../src/application/monitoring/monitoring-event'
import type { SetupCheckReport } from '../../src/application/setup/setup-check.service'
import type { LadderQuoteSet } from '../../src/domain/ladder'
import type { ActEvent, Decided } from '../../src/infrastructure/engine/quoter-acts'
import type { QuoterReport } from '../../src/infrastructure/engine/quoter-polls'
import type { WorldReads } from '../../src/infrastructure/engine/world-reads'
import type { LadderAdapters } from '../../src/infrastructure/ladder/production-ladder'
import type {
  BlueReferenceReader,
  ReferenceRates
} from '../../src/infrastructure/reference/reference-rates'
import type { QuoterEngine } from '../../src/run'

import { exposureSnapshot } from '../../src/application/engine/exposure'
import { SETUP_CHECK_MONITOR_INTERVAL_MS } from '../../src/application/setup/setup-check.service'
import { readinessVerdict } from '../../src/application/setup/setup-check.utils'
import { ConfigService } from '../../src/config/config.service'
import { MARKET_FAILURE_BUDGET_CYCLES } from '../../src/domain/market-failure-budget'
import { LadderAdapterError } from '../../src/errors'
import { declareQuoter } from '../../src/graph'
import { VALID_FOR_READS } from '../../src/infrastructure/engine/quoter-sources'
import { holdingsOf, liveViewOf } from '../../src/infrastructure/kernel/quoter-holdings'
import { createReferenceRates } from '../../src/infrastructure/reference/reference-rates'
import { dryHosting, quoterKernelConfig, quoterReceiptLogs } from '../../src/kernel'
import { startQuoterEngine } from '../../src/run'

const CHAIN_ID = 8453
const maker: Address = '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A'
const loanAsset: Address = '0x3333333333333333333333333333333333333333'
const setter = getChainAddress(CHAIN_ID, 'setterRatifier')
const market = {
  chainId: BigInt(CHAIN_ID),
  midnight: getChainAddress(CHAIN_ID, 'midnight'),
  loanToken: loanAsset,
  collateralParams: [
    {
      token: loanAsset,
      lltv: 1_000_000_000_000_000_000n,
      liquidationCursor: 250_000_000_000_000_000n,
      oracle: '0x0000000000000000000000000000000000008000' as Address
    }
  ],
  maturity: BigInt(Date.UTC(2027, 0, 1, 15) / 1000),
  rcfThreshold: 0n,
  enterGate: zeroAddress,
  liquidatorGate: zeroAddress
}
const marketId = MarketUtils.toId(market)
const KEY = `ladder:${marketId.toLowerCase()}`
const NOW = BigInt(Date.UTC(2026, 9, 1) / 1000)
/** Past the world read's validity: three polls of the ladder's one-second cadence. */
const PAST_A_READ = 5_000
/** Less than a read holds, so each step finds the last read still valid. */
const A_READ_APART = 500

const environment = {
  CHAIN_ID: String(CHAIN_ID),
  RPC_URL: 'https://rpc.example',
  REFERENCE_RPC_URL: 'https://archive.example',
  MAKER_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  MAKER_ADDRESS: maker,
  MIDNIGHT_ADDRESS: getChainAddress(CHAIN_ID, 'midnight'),
  LOAN_ASSET_ADDRESS: loanAsset,
  RATIFIER_ADDRESS: setter,
  MARKET_IDS: marketId,
  REFERENCE_MARKET_ID: `0x${'77'.repeat(32)}`,
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
  ROUTER_API_BASE_URL: 'https://router.example',
  TRANSACTION_RECEIPT_TIMEOUT_MS: '900000',
  LADDER_MARKETS: JSON.stringify([
    {
      marketId,
      quotePremiumBps: '0',
      spreadBps: '200',
      stepBps: '100',
      rungCount: '1',
      sizeSkewBps: '0',
      lowerRateBudgetAssets: '10',
      higherRateBudgetAssets: '10',
      targetMarketExposureAssets: '20',
      maximumTotalExposureAssets: '20',
      minimumOfferAssets: '1',
      groupMode: 'shared-rung',
      loopIntervalSeconds: '1',
      movementToleranceBps: '10',
      minimumRateBps: '100',
      maximumRateBps: '1000',
      targetRate: { strategy: 'hardcoded', hardcodedRateBps: '500' }
    }
  ])
}

/** A Setter tree of one buy, a distinct group per `start`. */
const setterTree = (start: bigint, desired?: LadderQuoteSet) =>
  Tree.create([
    Offer.create({
      market,
      buy: true,
      maker,
      start,
      expiry: market.maturity,
      ratifier: setter,
      tick: 6_000n,
      maxUnits: 10n,
      continuousFeeCap: 0n
    } as Parameters<typeof Offer.create>[0]),
    ...(desired?.debtCapable && desired.lower.length > 0
      ? [
          Offer.create({
            market,
            buy: false,
            maker,
            start,
            expiry: market.maturity,
            ratifier: setter,
            tick: 5_800n,
            maxUnits: desired.lower.reduce((sum, rung) => sum + rung.assets, 0n),
            continuousFeeCap: 0n,
            reduceOnly: false,
            receiverIfMakerIsSeller: maker
          } as Parameters<typeof Offer.create>[0])
        ]
      : [])
  ])

/** A chain whose transactions are included only when a trace mines them. */
class HeldChain implements KernelChain {
  height = 1
  finalized = 0
  readonly payloads = new Map<string, TxPayload>()
  readonly sent: string[] = []
  readonly mined = new Map<string, { block: number; nonce: number }>()
  private readonly nonces = new Map<string, number>()

  /** The height from which blocks belong to the fork {@link reorgHead} last switched to. */
  private forkedAt = Number.POSITIVE_INFINITY
  private forks = 0
  private hashOf(number: number) {
    const fork = number >= this.forkedAt ? this.forks : 0
    return `0x${fork.toString(16).padStart(8, '0')}${number.toString(16).padStart(56, '0')}`
  }
  blockAt(number: number): Block {
    return {
      number,
      hash: this.hashOf(number),
      parentHash: this.hashOf(number - 1),
      timestamp: NOW + BigInt(number)
    }
  }
  /** Replaces the head with another block at the same height. */
  reorgHead() {
    this.forkedAt = this.height
    this.forks += 1
  }
  latest = async () => ({
    head: this.blockAt(this.height),
    finalized: { number: this.finalized, timestamp: NOW + BigInt(this.finalized) }
  })
  block = async (number: number) => {
    if (number > this.height) throw new Error(`no block ${number}`)
    return this.blockAt(number)
  }
  safe = async () => this.blockAt(this.finalized)
  nonceAt = async () => ({ latest: this.mined.size, pending: this.mined.size })
  accountCode = async () => '0x'
  private evidence(hash: string) {
    const found = this.mined.get(hash)
    if (!found) return null
    return {
      block: found.block,
      blockHash: this.blockAt(found.block).hash,
      status: 'success' as const,
      logs: quoterReceiptLogs(maker)(this.payloads.get(hash)!)
    }
  }
  receipt = async (hash: string) => this.evidence(hash)
  nonceTx = async (nonce: number) => {
    const hash = [...this.mined].find(([, at]) => at.nonce === nonce)?.[0]
    const found = hash === undefined ? null : this.evidence(hash)
    return hash === undefined || found === null ? null : { hash, ...found }
  }
  commitment = async () => ({ consumed: 0n, neutralized: false })
  capacity = () => Promise.reject(new Error('the quoter observes no resource'))

  signed(payload: TxPayload, nonce: number, level: number) {
    const hash = `0x${nonce.toString(16).padStart(62, '0')}${level.toString(16).padStart(2, '0')}`
    this.payloads.set(hash, payload)
    this.nonces.set(hash, nonce)
    return hash
  }
  /** Includes every transaction sent and not yet mined, in one new block, and makes it final. */
  mine() {
    this.height += 1
    for (const hash of this.sent)
      if (!this.mined.has(hash))
        this.mined.set(hash, { block: this.height, nonce: this.nonces.get(hash)! })
  }
  finalize() {
    this.height += 1
    this.finalized = this.height
  }
  sentTo(target: string) {
    return this.sent.filter(
      hash => this.payloads.get(hash)?.to.toLowerCase() === target.toLowerCase()
    )
  }
}

class MemoryStore implements LedgerStore {
  text: string | null = null
  read = () =>
    Promise.resolve(this.text === null ? null : (JSON.parse(this.text, reviver) as unknown))
  write = (ledger: unknown) => {
    this.text = JSON.stringify(ledger, (_k, v: unknown) =>
      typeof v === 'bigint' ? { $bigint: v.toString() } : v
    )
    return Promise.resolve()
  }
}

const reviver = (_key: string, value: unknown) =>
  typeof value === 'object' && value !== null && '$bigint' in value
    ? BigInt((value as { $bigint: string }).$bigint)
    : value

const until = async (done: () => boolean, what: string) => {
  const deadline = Date.now() + 10_000
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(5)
  }
}

/** World reads that hang once `held`, until it is released, counting each cash read. */
const reads = (
  held: {
    gate?: Promise<void>
    cashFails?: boolean
    cashReads?: number
    positionsRead?: number
    debt?: bigint
    collateral?: bigint
  } = {}
): WorldReads => ({
  readLatestBlock: async () => ({ number: 1n, hash: `0x${'01'.repeat(32)}`, timestamp: NOW }),
  readMarket: async () => {
    throw new Error('these reads prepare nothing')
  },
  readGroups: async () => [],
  readBook: async () => [],
  readPosition: async id => {
    await held.gate
    held.positionsRead = (held.positionsRead ?? 0) + 1
    return {
      marketId: id,
      credit: 0n,
      debt: held.debt ?? 0n,
      loanCollateral: { assets: held.collateral ?? 10n, lltv: 1_000_000_000_000_000_000n },
      lossFactor: 0n,
      maturity: market.maturity,
      tickSpacing: 4,
      continuousFee: 0
    }
  },
  readCash: async () => {
    held.cashReads = (held.cashReads ?? 0) + 1
    if (held.cashFails) throw new TypeError('fetch failed')
    return { cashBalance: 100n, allowance: 100n }
  },
  readConsumed: async groupIds => groupIds.map(() => 0n)
})

/** Every preparation's tree start, shared across restarts so no two quoters prepare one group. */
let prepared = 0

/** The quoter on a held chain, with a reference the trace moves and a tree per preparation. */
const quoter = async (
  overrides: Readonly<{
    store?: MemoryStore
    chain?: HeldChain
    clock?: { at: number }
    held?: {
      gate?: Promise<void>
      cashFails?: boolean
      referenceFails?: boolean
      cashReads?: number
      positionsRead?: number
      debt?: bigint
      collateral?: bigint
    }
    borrowing?: boolean
    onEvent?: (event: ActEvent) => void
    onStartupSent?: (hash: Hex) => void
    setup?: Parameters<typeof startQuoterEngine>[0]['setup']
    /** How often the world is polled, in seconds; one by default. */
    pollSeconds?: number
    /** Awaited by each preparation before it answers. */
    preparing?: (marketId: Hex) => Promise<void>
    /** Further ladder markets beside the default one, each a copy of it under another id. */
    others?: readonly Hex[]
    references?: ReferenceRates
  }> = {}
) => {
  const ladder = environment.LADDER_MARKETS.replace(
    '"loopIntervalSeconds":"1"',
    `"loopIntervalSeconds":"${overrides.pollSeconds ?? 1}"`
  )
  const markets = [
    JSON.parse(ladder)[0],
    ...(overrides.others ?? []).map(id => ({
      ...JSON.parse(ladder)[0],
      marketId: id
    }))
  ].map(item =>
    overrides.borrowing
      ? { ...item, debt: { maximumDebtUnits: '10', stopBorrowingBeforeMaturitySeconds: '0' } }
      : item
  )
  const config = await ConfigService.load({
    ...environment,
    MARKET_IDS: [marketId, ...(overrides.others ?? [])].join(','),
    LADDER_MARKETS: JSON.stringify(markets)
  })
  const chain = overrides.chain ?? new HeldChain()
  const store = overrides.store ?? new MemoryStore()
  const clock = overrides.clock ?? { at: Date.now() }
  let rate = 500n
  const fixedReferences: ReferenceRates = async markets => {
    if (overrides.held?.referenceFails) throw new Error('reference unavailable')
    return markets.map(() => ({
      ok: true,
      value: { mode: 'static', rateBps: rate, observationId: 'hour:1' }
    }))
  }
  const references = overrides.references ?? fixedReferences
  const prepare = vi.fn<LadderAdapters['prepareReplacement']>(async ({ desired, marketId: id }) => {
    await overrides.preparing?.(id)
    const tree = setterTree(BigInt(++prepared), overrides.borrowing ? desired : undefined)
    return {
      reconciliation: {
        preparedAtTimestamp: NOW,
        applied: true,
        bookCrossing: {
          lower: { crossed: false, clearable: false },
          higher: { crossed: false, clearable: false }
        }
      },
      publication: {
        quote: desired,
        groups: tree.offers.map(offer => ({
          groupId: offer.group,
          side: offer.buy ? ('higher' as const) : ('lower' as const),
          rungIndexes: desired[offer.buy ? 'higher' : 'lower'].map(rung => rung.index),
          ticks: [offer.tick]
        })),
        witness: midnightTreeWitness(tree)
      }
    }
  })
  const validated = vi.fn(async () => {})
  const notices: { intentId: string; notice: string; reason?: string }[] = []
  const advances: { intentId: string; stage: number; block: number }[] = []
  const stops: MonitoringEvent[] = []
  const setups: MonitoringEvent[] = []
  const engine: QuoterEngine = await startQuoterEngine({
    config,
    journal: {
      sink: { append: async () => {}, finalize: async () => {} },
      capacityBytes: 100_000_000
    },
    strategies: { ladder: true, bootstrap: false },
    kernel: {
      config: quoterKernelConfig(config, maker),
      store,
      chain,
      effects: {
        materialize: () => Promise.reject(new LadderAdapterError('unsupported-ratifier')),
        simulate: async () => true,
        signTx: async (payload, { nonce, level, fee }) => {
          const hash = chain.signed(payload, nonce, level)
          return {
            hash,
            raw: hash,
            bid: { maxFeePerGas: fee, maxPriorityFeePerGas: fee, gas: 1n }
          }
        },
        signTyped: () => Promise.reject(new LadderAdapterError('unsupported-ratifier')),
        broadcast: async raw => {
          chain.sent.push(raw)
          return 'accepted'
        },
        release: () => Promise.reject(new LadderAdapterError('unsupported-ratifier'))
      },
      enrollment: store.text === null ? 'enrolling' : 'enrolled',
      pollMs: 5,
      effectTimeoutMs: 1_000,
      reorgDepth: 16,
      onError: () => {}
    },
    world: reads(overrides.held),
    references,
    adapters: {
      ladder: () => ({ prepareReplacement: prepare, validateRatified: validated })
    },
    ...(overrides.onEvent && { onEvent: overrides.onEvent }),
    ...(overrides.onStartupSent && { onStartupSent: overrides.onStartupSent }),
    ...(overrides.setup && { setup: overrides.setup }),
    writeEvent: event => {
      if (event.event === 'kernel.notice') notices.push(event)
      if (event.event === 'kernel.advance') advances.push(event)
      if (event.event === 'kernel.stopped') stops.push(event)
      if (event.event.startsWith('setup.')) setups.push(event)
    },
    now: () => clock.at
  })
  return {
    config,
    chain,
    store,
    clock,
    engine,
    prepare,
    validated,
    notices,
    advances,
    stops,
    setups,
    setRate: (next: bigint) => {
      rate = next
    }
  }
}

const noticesOf = (run: Awaited<ReturnType<typeof quoter>>, intentId: string) =>
  run.notices.filter(notice => notice.intentId === intentId).map(notice => notice.notice)

let running: QuoterEngine[] = []
afterEach(async () => {
  await Promise.all(running.map(engine => engine.abandon()))
  running = []
})

/** A Setter workflow whose ratification is broadcast and held, not yet included. */
const ratifying = async (overrides: Parameters<typeof quoter>[0] = {}) => {
  const run = await quoter(overrides)
  running.push(run.engine)
  await until(() => run.chain.sentTo(setter).length === 1, 'the ratification')
  const kernel = () => run.engine.kernelState()!
  const plan = () =>
    Object.values(kernel().plans).find(p => p.recovery === undefined && p.intentId.startsWith(KEY))!
  return { ...run, kernel, plan }
}

describe('a Setter workflow across its stages', () => {
  test('survives its own ratification, and publishes only on fresh publication-stage evidence', async () => {
    const run = await ratifying()
    const intentId = run.plan().intentId
    expect(run.chain.sentTo(getChainAddress(CHAIN_ID, 'midnightMempool'))).toHaveLength(0)
    run.chain.mine()
    const ratifiedAt = run.chain.height
    await published(run)
    const advance = run.advances.find(a => a.intentId === intentId)!
    expect(advance.stage).toBe(1)
    expect(advance.block).toBeGreaterThanOrEqual(ratifiedAt)
    expect(noticesOf(run, intentId)).toEqual(['admitted', 'advanced', 'settled'])
    expect(run.validated).toHaveBeenCalledTimes(1)
  })

  test('advances when its inclusion lands before its first stage deadline', async () => {
    const run = await ratifying()
    const intentId = run.plan().intentId
    run.clock.at = run.plan().notAfter - 1
    await sleep(50)
    run.chain.mine()
    await published(run)
    await until(() => noticesOf(run, intentId).includes('settled'), 'the publication')
    expect(noticesOf(run, intentId)).toEqual(['admitted', 'advanced', 'settled'])
  })

  test('advances on fresh evidence after its inclusion outlasts the first stage read', async () => {
    const held: { cashReads?: number } = {}
    const run = await ratifying({ held })
    const intentId = run.plan().intentId
    const stageOne = run.plan().notAfter
    while (run.clock.at < stageOne + PAST_A_READ) {
      const reads = held.cashReads ?? 0
      run.clock.at += A_READ_APART
      await until(() => (held.cashReads ?? 0) > reads, 'a world read at the advanced clock')
    }
    expect(run.plan().notAfter).toBeGreaterThan(run.clock.at)
    run.chain.mine()
    await published(run)
    await until(() => noticesOf(run, intentId).includes('settled'), 'the publication')
    expect(noticesOf(run, intentId)).toEqual(['admitted', 'advanced', 'settled'])
  })

  test('ends when no read lands for longer than the first stage read holds during its inclusion', async () => {
    const run = await ratifying()
    const ratified = run.plan()
    run.clock.at = ratified.notAfter + PAST_A_READ
    await sleep(50)
    run.chain.mine()
    await until(() => noticesOf(run, ratified.intentId).includes('compensating'), 'the deadline')
    expect(
      run.notices.find(n => n.intentId === ratified.intentId && n.notice === 'compensating')?.reason
    ).toBe('evidence expired')
    expect(run.chain.sentTo(getChainAddress(CHAIN_ID, 'midnightMempool'))).toHaveLength(0)
  })

  test('publishes when the reference moves within the band between the stages', async () => {
    const run = await ratifying()
    const intentId = run.plan().intentId
    run.setRate(505n)
    run.chain.mine()
    await published(run)
    expect(noticesOf(run, intentId)).toEqual(['admitted', 'advanced', 'settled'])
    expect(new Set(run.notices.map(notice => notice.intentId))).toEqual(new Set([intentId]))
  })

  test('never publishes once the reference moves past the band, and its obligations stay held until cancelled', async () => {
    const run = await ratifying()
    const ratified = run.plan()
    const group = midnightCommitmentId(groupOf(ratified))
    run.setRate(600n)
    run.chain.mine()
    await until(
      () => noticesOf(run, ratified.intentId).includes('compensating'),
      'the supersession'
    )
    const compensating = run.notices.find(
      n => n.intentId === ratified.intentId && n.notice === 'compensating'
    )
    expect(compensating?.reason).toMatch(/^superseded by /)
    expect(run.kernel().entries[group]).toMatchObject({ compensate: true })
    expect(['live', 'revoking']).toContain(run.kernel().entries[group]?.state)
    expect(Object.values(run.kernel().plans).filter(p => p.recovery?.entry === group)).toHaveLength(
      0
    )
    const config = quoterKernelConfig(run.config, maker)
    const loan = `loan:${loanAsset.toLowerCase()}`
    expect(available(config, run.kernel(), loan)).toBeLessThan(config.caps[loan]! - 10n)

    await until(
      () => run.chain.sentTo(getChainAddress(CHAIN_ID, 'midnight')).length === 1,
      'the cancel'
    )
    run.chain.mine()
    await until(() => run.kernel().entries[group]?.state !== 'live', 'the cancel landing')
    run.chain.finalize()
    await until(() => noticesOf(run, ratified.intentId).includes('compensated'), 'the compensation')
    expect(run.advances.filter(a => a.intentId === ratified.intentId)).toHaveLength(0)
    expect(run.chain.sentTo(getChainAddress(CHAIN_ID, 'midnightMempool'))).toHaveLength(0)
  })

  test('prepares a replacement against the publication its run still holds', async () => {
    const run = await ratifying()
    const group = groupOf(run.plan()).toLowerCase()
    run.setRate(600n)
    run.chain.mine()
    await until(() => run.prepare.mock.calls.length > 1, 'the replacement preparation')
    const [{ ownership }] = run.prepare.mock.calls.at(-1)!
    const held = ownership.ladderPublications.flatMap(publication =>
      publication.groups.map(reference => reference.groupId.toLowerCase())
    )
    expect(held).toContain(group)
  })

  test('withdraws a ratified tree once its read stays unusable past its deadline between the stages', async () => {
    const held: { gate?: Promise<void> } = {}
    const run = await ratifying({ held })
    const ratified = run.plan()
    const group = midnightCommitmentId(groupOf(ratified))
    let release = () => {}
    held.gate = new Promise(resolve => {
      release = resolve
    })
    run.chain.mine()
    await until(() => run.plan()?.phase === 'awaiting-advance', 'the parked stage')
    await sleep(50)
    expect(run.chain.sentTo(getChainAddress(CHAIN_ID, 'midnight'))).toHaveLength(0)
    run.clock.at = run.plan().notAfter
    await until(
      () => run.chain.sentTo(getChainAddress(CHAIN_ID, 'midnight')).length > 0,
      'the withdrawal'
    )
    const ended = run.notices.find(
      n => n.intentId === ratified.intentId && n.notice === 'compensating'
    )
    expect(ended?.reason).toBe('evidence expired')
    run.chain.mine()
    run.chain.finalize()
    await until(() => run.kernel().entries[group]?.state === 'retired', 'the cancel landing')
    expect(run.advances).toHaveLength(0)
    expect(run.chain.sentTo(getChainAddress(CHAIN_ID, 'midnightMempool'))).toHaveLength(0)
    release()
  })

  test('a restart between the stages withdraws the ratified tree instead of publishing it', async () => {
    const held: { gate?: Promise<void> } = {}
    const run = await ratifying({ held })
    const ratified = run.plan()
    const group = midnightCommitmentId(groupOf(ratified))
    let release = () => {}
    held.gate = new Promise(resolve => {
      release = resolve
    })
    run.chain.mine()
    await until(() => run.plan()?.phase === 'awaiting-advance', 'the parked publication')
    const abandoned = run.engine.abandon()
    release()
    await abandoned
    running = []

    const broadcast: Hex[] = []
    const restarting = quoter({
      store: run.store,
      chain: run.chain,
      clock: run.clock,
      onStartupSent: hash => void broadcast.push(hash)
    })
    const midnight = getChainAddress(CHAIN_ID, 'midnight')
    await until(() => broadcast.length === 1, 'the startup withdrawal')
    expect(broadcast).toEqual(run.chain.sentTo(midnight))
    run.chain.mine()
    const restarted = await restarting
    running.push(restarted.engine)
    const adopted = restarted.engine.kernelState()!.entries[group]
    expect(adopted).toMatchObject({ adopted: true, state: 'revoking' })
    expect(liveViewOf(restarted.engine.kernelState(), KEY).live).toHaveLength(0)
    expect(restarted.notices.filter(n => n.intentId.startsWith('startup#'))).toMatchObject([
      { notice: 'admitted' },
      { notice: 'settled' }
    ])
    expect(run.chain.sentTo(getChainAddress(CHAIN_ID, 'midnightMempool'))).toHaveLength(0)
  })

  test('submits nothing before the startup withdrawal settles, then acts under a new run id', async () => {
    const run = await ratifying()
    run.chain.mine()
    await published(run)
    const earlier = Object.values(run.kernel().entries).map(entry => entry.intentId)
    await run.engine.abandon()
    running = []
    const sentBefore = run.chain.sent.length

    const held: { cashReads?: number } = {}
    const submitted: string[] = []
    const restarting = quoter({
      store: run.store,
      chain: run.chain,
      clock: run.clock,
      held,
      onEvent: event => {
        if (event.type === 'submitted') submitted.push(event.intentId)
      }
    })
    await until(() => run.chain.sent.length === sentBefore + 1, 'the startup withdrawal')
    const reads = held.cashReads ?? 0
    for (let poll = 0; poll < 3; poll++) {
      run.chain.finalize()
      await sleep(1_100)
    }
    expect(held.cashReads ?? 0).toBeGreaterThan(reads)
    expect(submitted).toHaveLength(0)
    expect(run.chain.sentTo(getChainAddress(CHAIN_ID, 'midnight'))).toHaveLength(1)
    expect(run.chain.sentTo(setter)).toHaveLength(1)

    run.chain.mine()
    run.chain.finalize()
    const restarted = await restarting
    running.push(restarted.engine)
    await until(() => submitted.length === 1, 'the first act after the gate')
    await until(() => restarted.notices.length === 3, 'its answer')
    expect(restarted.notices.map(n => [n.intentId.split('#')[0], n.notice])).toEqual([
      ['startup', 'admitted'],
      ['startup', 'settled'],
      [KEY, 'admitted']
    ])
    expect(earlier).not.toContain(submitted[0])
  }, 20_000)
})

describe('a published book', () => {
  /** A market whose tree is ratified and published, with its book live. */
  const live = async (
    held: { gate?: Promise<void>; cashFails?: boolean; referenceFails?: boolean } = {}
  ) => {
    const run = await ratifying({ held })
    run.chain.mine()
    await published(run)
    const cancels = () => run.chain.sentTo(getChainAddress(CHAIN_ID, 'midnight'))
    expect(cancels()).toHaveLength(0)
    return { ...run, cancels }
  }

  test('is withdrawn once its market can no longer be read', async () => {
    const held: { cashFails?: boolean } = {}
    const run = await live(held)
    held.cashFails = true
    run.chain.mine()
    run.chain.finalize()
    await until(() => run.cancels().length === 1, 'the withdrawal')
  })

  test('is withdrawn in-process once a bot effect throws, and the kernel stops cleanly', async () => {
    const run = await ratifying({
      onEvent: event => {
        if (event.type === 'ended') throw new Error('the hook failed')
      }
    })
    run.chain.mine()
    await published(run)
    const cancels = () => run.chain.sentTo(getChainAddress(CHAIN_ID, 'midnight'))
    await until(() => cancels().length === 1, 'the withdrawal')
    const finality = setInterval(() => {
      run.chain.mine()
      run.chain.finalize()
    }, 20)
    const stopped = await run.engine.stopped.finally(() => clearInterval(finality))
    expect(stopped).toMatchObject({
      outcome: 'clean',
      halt: 'quoter.report failed: Error',
      error: new Error('the hook failed')
    })
    expect(run.engine.held()).toStrictEqual([])
  })

  test('withdraws its live book on a requested stop, and stops cleanly with nothing held', async () => {
    const run = await live()
    expect(run.engine.held()).toHaveLength(1)
    run.engine.stop()
    const finality = setInterval(() => {
      run.chain.mine()
      run.chain.finalize()
    }, 20)
    const stopped = await run.engine.stopped.finally(() => clearInterval(finality))
    expect(stopped).toEqual({ outcome: 'clean', reason: 'stop requested' })
    expect(run.cancels()).toHaveLength(1)
    expect(run.engine.held()).toStrictEqual([])
  })

  test('halts on the first reference read that throws, withdrawing its book', async () => {
    const held: { referenceFails?: boolean } = {}
    const run = await live(held)
    held.referenceFails = true
    const finality = setInterval(() => {
      run.chain.mine()
      run.chain.finalize()
    }, 20)
    const stopped = await run.engine.stopped.finally(() => clearInterval(finality))
    expect(stopped).toMatchObject({ outcome: 'clean', halt: 'reference-read-failed' })
    expect(run.cancels()).toHaveLength(1)
  })

  test('keeps quoting while the head stays within a second of the wall clock, and halts once it outruns it', async () => {
    const FORK = 1_784_589_348n
    const WALL = FORK + 150n
    /** The wall clock: `offset` seconds after the head, or frozen at `WALL`. */
    const run = async (clock: Readonly<{ offset: bigint }> | 'frozen') => {
      const head = { timestamp: WALL - 2n }
      const reader: BlueReferenceReader = {
        readLatest: async () => ({
          blockNumber: head.timestamp,
          timestamp: head.timestamp,
          supplyAssetsPerWadShares: 10n ** 18n + (10n ** 18n * 34n) / 1_000_000n
        }),
        readAtOrBefore: async target => ({
          blockNumber: target,
          timestamp: target,
          supplyAssetsPerWadShares: 10n ** 18n
        })
      }
      const rates = createReferenceRates({
        targets: {
          ladder: new Map([[marketId, { strategy: 'variable_rate_avg' } as const]]),
          bootstrap: new Map()
        },
        reader,
        lookbackSeconds: 21_600n,
        nowSeconds: () => (clock === 'frozen' ? WALL : head.timestamp + clock.offset)
      })
      const quoted = await ratifying({ held: {}, references: rates })
      quoted.chain.mine()
      await published(quoted)
      const cancels = () => quoted.chain.sentTo(getChainAddress(CHAIN_ID, 'midnight'))
      expect(cancels()).toHaveLength(0)
      const miner = setInterval(() => {
        head.timestamp += 1n
        quoted.chain.mine()
        quoted.chain.finalize()
      }, 20)
      try {
        const stopped = await Promise.race([
          quoted.engine.stopped,
          sleep(1_500).then(() => 'running' as const)
        ])
        return { stopped, cancels: cancels().length, head: head.timestamp }
      } finally {
        clearInterval(miner)
      }
    }
    for (const offset of [1n, -1n]) {
      const moving = await run({ offset })
      expect(moving.stopped, `wall clock ${offset} s from the head`).toBe('running')
      expect(moving.cancels).toBe(0)
    }
    const frozen = await run('frozen')
    expect(frozen.stopped).toMatchObject({ outcome: 'clean', halt: 'reference-read-failed' })
    expect(frozen.cancels).toBe(1)
    expect(frozen.head).toBeGreaterThan(WALL + 1n)
  }, 30_000)

  test('halts on a thrown reference read even while its market cannot be read', async () => {
    const run = await quoter({ held: { cashFails: true, referenceFails: true } })
    running.push(run.engine)
    expect(await run.engine.stopped).toMatchObject({
      outcome: 'clean',
      halt: 'reference-read-failed'
    })
  })

  test('is withdrawn once its reading outlives its validity', async () => {
    const run = await live()
    await sleep(50)
    run.clock.at += PAST_A_READ
    await until(() => run.cancels().length === 1, 'the withdrawal')
  })

  test('halts the bot through its monitor once a market fails five polls in a row', async () => {
    const clock = { at: Date.now() }
    const ticking = setInterval(() => (clock.at += 100), 100)
    const run = await quoter({ held: { cashFails: true }, clock })
    running.push(run.engine)
    const stopped = await run.engine.stopped
    clearInterval(ticking)
    expect(stopped).toMatchObject({ outcome: 'clean', halt: 'market-failure-budget: ladder' })
  })

  test('stays affirmed while each read still desires it', async () => {
    const run = await live()
    const affirmed = () =>
      Object.values(run.engine.kernelState()!.entries).map(entry => entry.affirmedAt)
    const before = affirmed()
    run.clock.at += 1_000
    run.chain.mine()
    run.chain.finalize()
    await until(() => affirmed().every((at, i) => at > before[i]!), 'the affirmation')
    expect(run.cancels()).toHaveLength(0)
  })
})

/** Waits for the publication to be sent, then includes it. */
const published = async (run: Awaited<ReturnType<typeof ratifying>>) => {
  await until(
    () => run.chain.sentTo(getChainAddress(CHAIN_ID, 'midnightMempool')).length === 1,
    'the publication to be sent'
  )
  run.chain.mine()
  await until(() => noticesOf(run, run.advances[0]!.intentId).includes('settled'), 'the settlement')
}

/** The group the workflow ratified, from its ratification step's tree. */
const groupOf = (plan: KernelState['plans'][string]) =>
  Tree.create(plan.steps[0]!.witness as never).offers[0]!.group

describe('the holdings a sizing decision reads', () => {
  test('reserve cash for revoking and adopted groups, but never count an adopted one as live', () => {
    const tree = setterTree(9n)
    const offer = tree.offers[0]!
    const state = createKernel({
      validators: [],
      caps: {},
      maxEvidenceAgeBlocks: 0
    } as never).initialState()
    const entry = (
      id: string,
      intentId: string,
      entryState: 'revoking' | 'live',
      adopted: boolean
    ) => ({
      spec: {
        id,
        exposure: 'inclusion' as const,
        resources: { [`loan:${loanAsset.toLowerCase()}`]: 10n },
        expiry: market.maturity,
        cap: 10n,
        neutralizer: { kind: 'tx' as const, to: '0x', data: '0x', value: 0n }
      },
      state: entryState,
      intentId,
      validator: 'midnight-offers@2',
      creators: [],
      deadCreators: [],
      origin: {
        payload: { kind: 'tx' as const, to: setter, data: '0x', value: 0n },
        witness: midnightTreeWitness(tree)
      },
      consumedFinal: 0n,
      recoveryAttempts: 0,
      stuck: false,
      compensate: false,
      affirmedAt: 0,
      ...(adopted ? { adopted: true as const } : {})
    })
    const id = midnightCommitmentId(offer.group)
    for (const [entryState, adopted] of [
      ['revoking', false],
      ['live', true]
    ] as const) {
      const held = {
        ...state,
        entries: { [id]: entry(id, `${KEY}#earlier.0`, entryState, adopted) }
      }
      const ownership = holdingsOf(held, [], [])
      expect(ownership.heldBuyGroups.map(g => g.groupId)).toEqual([offer.group.toLowerCase()])
      const snapshot = exposureSnapshot(
        {
          strategy: 'ladder',
          marketId,
          block: 1,
          timestamp: NOW,
          ownership,
          view: liveViewOf(held, KEY),
          groups: { ok: true, value: [] },
          positions: {
            [marketId]: {
              ok: true,
              value: {
                marketId,
                credit: 0n,
                debt: 0n,
                lossFactor: 0n,
                maturity: market.maturity,
                tickSpacing: 4,
                continuousFee: 0
              }
            }
          },
          cash: { ok: true, value: { cashBalance: 100n, allowance: 100n } },
          consumed: { ok: true, value: { [offer.group.toLowerCase()]: 0n } }
        },
        { marketIds: [marketId] },
        LadderAdapterError
      )
      expect(snapshot.groups).toMatchObject([
        { groupId: offer.group.toLowerCase(), remainingAssets: 10n }
      ])
      expect(liveViewOf(held, KEY).live).toHaveLength(0)
    }
  })
})

describe('readiness monitoring', () => {
  const unreadyCheck = {
    name: 'ratifier',
    status: 'failed',
    observed: 'other',
    required: 'setter'
  } as const
  /** Monitoring whose timer the test releases, on the run's fake clock. */
  const monitored = () => {
    const waits: { ms: number; release: () => void }[] = []
    return {
      waits,
      wait: (ms: number, signal: AbortSignal) =>
        new Promise<void>(resolve => {
          signal.addEventListener('abort', () => resolve(), { once: true })
          waits.push({ ms, release: resolve })
        })
    }
  }

  test('runs in the graph against the holdings it publishes, and halts the kernel on a halting report', async () => {
    const unready: SetupCheckReport = {
      ready: false,
      checks: [{ name: 'ratifier', status: 'failed', observed: 'other', required: 'setter' }]
    }
    expect(readinessVerdict(0, unready).halting).toBe(true)
    let next: SetupCheckReport = { ready: true, checks: [] }
    const seen: WorldOwnership[] = []
    const timer = monitored()
    const run = await ratifying({
      setup: {
        monitor: true,
        wait: timer.wait,
        create: ownership =>
          ({
            assertReady: async () => ({ ready: true, checks: [] }),
            cycle: async () => {
              seen.push(ownership.current())
              return next
            }
          }) as never
      }
    })
    await until(() => timer.waits.length === 1, 'the wake at the gate')
    timer.waits[0]!.release()
    await until(() => seen.length === 1, 'the first cycle at the gate')
    run.chain.mine()
    await published(run)
    next = unready
    await until(() => timer.waits.length === 2, 'the wait for the second cycle')
    run.clock.at += timer.waits[1]!.ms
    timer.waits[1]!.release()
    const finality = setInterval(() => {
      run.chain.mine()
      run.chain.finalize()
    }, 20)
    const stopped = await run.engine.stopped.finally(() => clearInterval(finality))
    expect(stopped).toMatchObject({ outcome: 'clean', halt: 'readiness: setup-failed' })
    expect(seen).toHaveLength(2)
    expect(seen[1]!.ladderPublications).toHaveLength(1)
  })

  test.each([
    {
      name: 'a failed check',
      cycle: async () => ({ ready: false, checks: [unreadyCheck] }),
      reported: { setup: 'setup.check-failed', cycleErrorName: undefined }
    },
    {
      name: 'a cycle that throws',
      cycle: async (): Promise<SetupCheckReport> => {
        throw new TypeError('provider shape')
      },
      reported: { setup: undefined, cycleErrorName: 'TypeError' }
    }
  ])('reports $name that halts the kernel holding nothing', async ({ cycle, reported }) => {
    const timer = monitored()
    const run = await quoter({
      held: { cashFails: true },
      setup: {
        monitor: true,
        wait: timer.wait,
        create: () => ({ assertReady: async () => ({ ready: true, checks: [] }), cycle }) as never
      }
    })
    running.push(run.engine)
    await until(() => timer.waits.length === 1, 'the wake at the gate')
    timer.waits[0]!.release()
    const stopped = await run.engine.stopped
    expect(stopped).toMatchObject({ outcome: 'clean', halt: 'readiness: setup-failed' })
    expect(run.stops).toMatchObject([{ event: 'kernel.stopped', openEntries: 0 }])
    expect(run.setups.find(event => event.event === 'setup.check-failed')?.event).toBe(
      reported.setup
    )
    expect(run.engine.reports.cycleErrorName()).toBe(reported.cycleErrorName)
  })

  test('starts each cycle exactly the monitor interval after the last one ended', async () => {
    const cycles: { started: number; ended: number }[] = []
    const timer = monitored()
    const run = await quoter({
      setup: {
        monitor: true,
        wait: timer.wait,
        create: () =>
          ({
            assertReady: async () => ({ ready: true, checks: [] }),
            cycle: async () => {
              const started = run.clock.at
              await sleep(5)
              run.clock.at += 7
              cycles.push({ started, ended: run.clock.at })
              return { ready: true, checks: [] }
            }
          }) as never
      }
    })
    running.push(run.engine)
    await until(() => timer.waits.length === 1, 'the wake at the gate')
    expect(timer.waits[0]!.ms).toBe(0)
    timer.waits[0]!.release()
    await until(() => timer.waits.length === 2, 'the wake after the first cycle')
    expect(timer.waits[1]!.ms).toBe(SETUP_CHECK_MONITOR_INTERVAL_MS)
    expect(cycles).toHaveLength(1)
    run.clock.at += timer.waits[1]!.ms
    timer.waits[1]!.release()
    await until(() => cycles.length === 2, 'the second cycle')
    expect(cycles[1]!.started - cycles[0]!.ended).toBe(SETUP_CHECK_MONITOR_INTERVAL_MS)
  })

  test('halts on a cycle that throws, naming its error, and records how the kernel stopped', async () => {
    let cycles = 0
    const timer = monitored()
    const run = await ratifying({
      setup: {
        monitor: true,
        wait: timer.wait,
        create: () =>
          ({
            assertReady: async () => ({ ready: true, checks: [] }),
            cycle: async () => {
              if (++cycles > 1) throw new TypeError('provider shape')
              return { ready: true, checks: [] }
            }
          }) as never
      }
    })
    await until(() => timer.waits.length === 1, 'the wake at the gate')
    timer.waits[0]!.release()
    run.chain.mine()
    await published(run)
    await until(() => timer.waits.length === 2, 'the wait for the second cycle')
    run.clock.at += timer.waits[1]!.ms
    timer.waits[1]!.release()
    const finality = setInterval(() => {
      run.chain.mine()
      run.chain.finalize()
    }, 20)
    const stopped = await run.engine.stopped.finally(() => clearInterval(finality))
    expect(stopped).toMatchObject({ outcome: 'clean', halt: 'readiness: setup-failed' })
    expect(run.engine.reports.cycleErrorName()).toBe('TypeError')
    expect(run.stops).toEqual([
      {
        event: 'kernel.stopped',
        outcome: 'clean',
        reason: 'readiness: setup-failed',
        openEntries: 0,
        openNonces: 0
      }
    ])
  })
})

describe('a preparation and the world reads around it', () => {
  /** Preparations that answer only once the test releases them, in the order they were asked. */
  const held = () => {
    const waiting: (() => void)[] = []
    const inFlight = new Map<Hex, number>()
    let most = 0
    return {
      waiting,
      /** The most preparations any one market had in flight at once. */
      most: () => most,
      preparing: (id: Hex) =>
        new Promise<void>(resolve => {
          const count = (inFlight.get(id) ?? 0) + 1
          inFlight.set(id, count)
          most = Math.max(most, count)
          waiting.push(() => {
            inFlight.set(id, inFlight.get(id)! - 1)
            resolve()
          })
        }),
      release: () => waiting.shift()!()
    }
  }
  const POLL_SECONDS = 60

  test('lands while the chain moves on, when no world read was asked for meanwhile', async () => {
    const preparations = held()
    const run = await quoter({ pollSeconds: POLL_SECONDS, preparing: preparations.preparing })
    running.push(run.engine)
    await until(() => preparations.waiting.length === 1, 'the preparation')
    for (let i = 0; i < 3; i++) {
      run.chain.mine()
      await sleep(30)
    }
    preparations.release()
    await until(() => run.chain.sentTo(setter).length === 1, 'the ratification')
    expect(run.prepare).toHaveBeenCalledTimes(1)
  })

  test('refuses a replacement whose read a same-height reorg orphaned while it prepared', async () => {
    const preparations = held()
    const run = await quoter({ pollSeconds: POLL_SECONDS, preparing: preparations.preparing })
    running.push(run.engine)
    await until(() => preparations.waiting.length === 1, 'the preparation')
    const readFrom = run.engine.kernelState()!.head!
    run.chain.reorgHead()
    await until(
      () => run.engine.kernelState()!.head!.hash !== readFrom.hash,
      'the kernel to follow the reorg'
    )
    expect(run.engine.kernelState()!.head!.number).toBe(readFrom.number)
    preparations.release()
    await until(() => run.notices.some(n => n.notice === 'refused'), 'the refusal')
    const refused = run.notices.find(n => n.notice === 'refused')!
    expect(run.notices.filter(n => n.intentId === refused.intentId).map(n => n.notice)).toEqual([
      'refused'
    ])
    expect(run.chain.sentTo(setter)).toHaveLength(0)
    while (preparations.waiting.length > 0) preparations.release()
  })

  test('is set aside once a world read is asked for while it prepares', async () => {
    const preparations = held()
    const run = await quoter({ pollSeconds: POLL_SECONDS, preparing: preparations.preparing })
    running.push(run.engine)
    await until(() => preparations.waiting.length === 1, 'the first preparation')
    run.engine.refresh()
    preparations.release()
    await until(() => preparations.waiting.length === 1, 'the preparation from the new read')
    await sleep(100)
    expect(run.chain.sentTo(setter)).toHaveLength(0)
    preparations.release()
    await until(() => run.chain.sentTo(setter).length === 1, 'the ratification')
    expect(run.prepare).toHaveBeenCalledTimes(2)
  })

  test('waits for a world read asked for before it, even one still queued behind another', async () => {
    const preparations = held()
    const world: { gate?: Promise<void>; positionsRead?: number } = {}
    const run = await quoter({
      pollSeconds: POLL_SECONDS,
      preparing: preparations.preparing,
      held: world
    })
    running.push(run.engine)
    await until(() => preparations.waiting.length === 1, 'the first preparation')
    let open = () => {}
    world.gate = new Promise(resolve => {
      open = resolve
    })
    run.engine.refresh()
    run.engine.refresh()
    preparations.release()
    await sleep(100)
    expect(run.chain.sentTo(setter)).toHaveLength(0)
    expect(world.positionsRead).toBe(1)

    open()
    const landed = () => world.positionsRead ?? 0
    const releasing = setInterval(() => {
      while (preparations.waiting.length > 0) {
        expect(landed()).toBeGreaterThanOrEqual(2)
        preparations.release()
      }
    }, 5)
    await until(() => run.chain.sentTo(setter).length === 1, 'the ratification').finally(() =>
      clearInterval(releasing)
    )
    expect(landed()).toBe(3)
  })

  test('asks no preparation for a world read already overtaken, across markets', async () => {
    const preparations = held()
    const world: { gate?: Promise<void>; positionsRead?: number } = {}
    const others = [`0x${'22'.repeat(32)}`, `0x${'33'.repeat(32)}`] as const
    const run = await quoter({
      pollSeconds: POLL_SECONDS,
      preparing: preparations.preparing,
      held: world,
      others
    })
    running.push(run.engine)
    await until(() => preparations.waiting.length === 3, 'one preparation per market')
    const markets = () => new Set(run.prepare.mock.calls.map(([{ marketId: id }]) => id)).size
    expect(markets()).toBe(3)
    let open = () => {}
    world.gate = new Promise(resolve => {
      open = resolve
    })
    for (let i = 0; i < 4; i++) run.engine.refresh()
    while (preparations.waiting.length > 0) preparations.release()
    const before = run.prepare.mock.calls.length
    const readsBefore = world.positionsRead ?? 0
    open()
    await until(
      () => (world.positionsRead ?? 0) - readsBefore === 4 * 3,
      'every overtaken read and the current one, for each market'
    )
    await until(() => run.prepare.mock.calls.length === before + 3, 'the current batch')
    await sleep(200)
    expect(run.prepare.mock.calls.length).toBe(before + 3)
    expect(new Set(run.prepare.mock.calls.slice(before).map(([{ marketId: id }]) => id)).size).toBe(
      3
    )
    while (preparations.waiting.length > 0) preparations.release()
  })

  test('keeps one preparation per market in flight while current reads keep landing', async () => {
    const preparations = held()
    const world: { positionsRead?: number } = {}
    const others = [`0x${'22'.repeat(32)}`, `0x${'33'.repeat(32)}`] as const
    const run = await quoter({
      pollSeconds: POLL_SECONDS,
      preparing: preparations.preparing,
      held: world,
      others
    })
    running.push(run.engine)
    await until(() => preparations.waiting.length === 3, 'one preparation per market')
    for (let read = 0; read < 4; read++) {
      const landed = world.positionsRead ?? 0
      run.engine.refresh()
      await until(() => (world.positionsRead ?? 0) - landed === 3, 'a current read')
      await sleep(20)
    }
    expect(run.prepare).toHaveBeenCalledTimes(3)
    expect(preparations.most()).toBe(1)

    while (preparations.waiting.length > 0) preparations.release()
    await until(() => preparations.waiting.length === 3, 'one preparation per market, current')
    expect(run.prepare).toHaveBeenCalledTimes(6)
    expect(preparations.most()).toBe(1)
    preparations.release()
    await until(() => run.chain.sentTo(setter).length === 1, 'the ratification')
    while (preparations.waiting.length > 0) preparations.release()
  })

  test('asks nothing from a read the gate’s own read overtakes', async () => {
    const world: { gate?: Promise<void>; positionsRead?: number } = {}
    let ready = () => {}
    const readiness = new Promise<void>(resolve => {
      ready = resolve
    })
    const starting = quoter({
      pollSeconds: 2,
      held: world,
      setup: {
        monitor: false,
        create: () =>
          ({
            assertReady: async () => {
              await readiness
              return { ready: true, checks: [] }
            }
          }) as never
      }
    })
    await until(() => (world.positionsRead ?? 0) === 1, 'a world read before the gate')
    let open = () => {}
    world.gate = new Promise(resolve => {
      open = resolve
    })
    ready()
    const run = await starting
    running.push(run.engine)
    await sleep(200)
    expect(run.prepare).not.toHaveBeenCalled()
    open()
    await until(() => run.prepare.mock.calls.length === 1, 'the preparation from the gate’s read')
  })

  test('that hangs past a poll frees its lane slot, and its market prepares again', async () => {
    const asked = new Set<Hex>()
    const run = await quoter({
      others: [
        `0x${'22'.repeat(32)}`,
        `0x${'33'.repeat(32)}`,
        `0x${'44'.repeat(32)}`,
        `0x${'55'.repeat(32)}`
      ],
      preparing: id => {
        if (asked.has(id)) return Promise.resolve()
        asked.add(id)
        return new Promise(() => {})
      }
    })
    running.push(run.engine)
    await until(() => asked.size === 5, 'the market queued behind four hung preparations')
    await until(() => run.chain.sentTo(setter).length > 0, 'a ratification')
  })

  test('that hangs poll after poll counts as a failure until the budget halts', async () => {
    const clock = { at: Date.now() }
    const ticking = setInterval(() => (clock.at += 100), 100)
    const run = await quoter({ clock, preparing: () => new Promise(() => {}) })
    running.push(run.engine)
    const stop = await run.engine.stopped.finally(() => clearInterval(ticking))
    expect(stop.reason).toContain('market-failure-budget')
    expect(run.engine.reports.lastFailed()).toContainEqual(
      expect.objectContaining({ status: 'failed', stage: 'prepare', errorName: 'TimeoutError' })
    )
  })

  test('counts no timeout while startup holds the gate', async () => {
    const world: { positionsRead?: number } = {}
    let ready = () => {}
    const readiness = new Promise<void>(resolve => {
      ready = resolve
    })
    const starting = quoter({
      held: world,
      preparing: () => new Promise(() => {}),
      setup: {
        monitor: false,
        create: () =>
          ({
            assertReady: async () => {
              await readiness
              return { ready: true, checks: [] }
            }
          }) as never
      }
    })
    await until(
      () => (world.positionsRead ?? 0) > MARKET_FAILURE_BUDGET_CYCLES + 1,
      'more reads before the gate than the failure budget allows'
    )
    ready()
    const run = await starting
    running.push(run.engine)
    await until(() => run.prepare.mock.calls.length === 1, 'the preparation from the gate’s read')
  })

  test('that hangs never holds a clean stop', async () => {
    const run = await quoter({ pollSeconds: 60, preparing: () => new Promise(() => {}) })
    running.push(run.engine)
    await until(() => run.prepare.mock.calls.length === 1, 'the preparation')
    run.engine.stop()
    expect(await run.engine.stopped).toEqual({ outcome: 'clean', reason: 'stop requested' })
  })
})

describe('the decisions of a world read', () => {
  /** The quoter's graph over a dry kernel, journaled, every poll `everyMs` apart. */
  const declared = async (world: WorldReads) => {
    const config = await ConfigService.load(environment)
    const reports: { at: number; report: QuoterReport }[] = []
    const declare = () => {
      const g = createGraph('quoter')
      const graph = declareQuoter(g, {
        runId: 'run',
        ladder: config.ladder,
        bootstrap: [],
        accounting: {
          maker,
          marketIds: config.setup.marketIds,
          v0OfferGroupIds: config.v0OfferGroupIds
        },
        signing: { chainId: CHAIN_ID, maker, signer: maker, ratifier: () => 'setter' },
        kernel: dryHosting(config),
        dry: true,
        reads: world,
        rates: async markets =>
          markets.map(() => ({
            ok: true,
            value: { mode: 'static', rateBps: 500n, observationId: 'hour:1' }
          })),
        prepare: async () => ({ ok: false, errorName: 'PreparedNothing' }),
        validate: async () => {},
        timing: { everyMs: 50, bootstrapEveryMs: 60_000, receiptTimeoutMs: 900_000 },
        now: Date.now,
        onReport: report => reports.push({ at: Date.now(), report })
      })
      return { g, graph }
    }
    const { g, graph } = declare()
    const journal: JournalEntry[] = []
    const runner = createRunner(g.build(), {
      journal: {
        sink: { append: async entry => void journal.push(entry), finalize: async () => {} },
        capacityBytes: 100_000_000
      }
    })
    return {
      graph,
      runner,
      journal,
      reports,
      decision: () => {
        const decisions = runner.read(graph.decisions)
        return decisions && { coverage: decisions.coverage, fact: keyRecord(decisions, KEY) }
      },
      replayed: () => replay(declare().g.build(), journal),
      start: async () => {
        await graph.kernel.start(runner)
        runner.push(graph.gate, true)
      }
    }
  }

  const decided = (reports: readonly { report: QuoterReport }[]) =>
    reports.flatMap(({ report }) => (report.type === 'decided' ? report.decided : []))

  test('knows nothing of a market before its first world read, and reports it unavailable', async () => {
    const held = { gate: new Promise<void>(() => {}) }
    const run = await declared(reads(held))
    await run.start()
    await until(() => run.decision() !== undefined, 'the first decision')
    expect(run.decision()).toStrictEqual({
      coverage: { status: 'unknown' },
      fact: { status: 'unknown' }
    })
    expect(decided(run.reports).at(-1)).toMatchObject({
      workflow: 'ladder',
      status: 'failed',
      errorName: 'QuoterReadingUnavailableError'
    })
    await run.runner.abandon()
    expect(run.replayed()).toMatchObject({ ok: true, steps: expect.any(Number) })
  })

  test('keeps a world read that throws failed, and reports its market unavailable', async () => {
    const run = await declared({ ...reads(), readGroups: async () => undefined as never })
    await run.start()
    await until(() => run.decision()?.coverage.status === 'failed', 'the failed read')
    expect(run.decision()!.fact).toStrictEqual({ status: 'unknown' })
    await until(() => decided(run.reports).at(-1)?.status === 'failed', 'the unavailable report')
    expect(decided(run.reports).at(-1)).toMatchObject({ errorName: 'TypeError' })
    await run.runner.abandon()
    expect(run.replayed()).toMatchObject({ ok: true, steps: expect.any(Number) })
  })

  test('decides each market at its read, and wakes its watchers when that read expires', async () => {
    const held: { gate?: Promise<void>; positionsRead?: number } = {}
    const run = await declared(reads(held))
    await run.start()
    await until(() => run.decision()?.fact.status === 'present', 'the first decision')
    let release = () => {}
    held.gate = new Promise<void>(resolve => {
      release = resolve
    })
    await sleep(100)
    const fact = run.decision()!.fact as Extract<KeyRecord<Decided>, { status: 'present' }>
    expect(fact.basis).toMatchObject({ generation: expect.any(Number), readAt: expect.any(Number) })
    expect(fact.expiry).toBe((fact.basis as { readAt: number }).readAt + VALID_FOR_READS * 50)
    const expiry = fact.expiry!
    const wokenAtExpiry = () =>
      run.journal.some(
        entry =>
          entry.kind === 'step' &&
          entry.stamp.at >= expiry &&
          entry.wakes?.includes('markets.decision') === true
      )
    await until(wokenAtExpiry, 'the decision to wake its watchers at its expiry')
    expect(run.decision()!.fact).toStrictEqual(fact)
    release()
    await run.runner.abandon()
    expect(run.replayed()).toMatchObject({ ok: true, steps: expect.any(Number) })
  })
})

describe('borrowing books across cancellation and publication', () => {
  const liveBorrowing = async () => {
    const held = { debt: 0n, collateral: 10n }
    const run = await ratifying({ borrowing: true, held })
    run.chain.mine()
    await published(run)
    run.chain.finalize()
    await until(
      () => Object.values(run.kernel().nonces).every(n => n.resolution !== undefined),
      'first book finality'
    )
    const debtResource = `debt:${marketId.toLowerCase()}`
    expect(
      Object.values(run.kernel().entries).filter(e => e.spec.resources[debtResource] === 10n)
    ).toHaveLength(1)
    run.setRate(600n)
    const midnight = getChainAddress(CHAIN_ID, 'midnight')
    await until(() => run.chain.sentTo(midnight).length === 1, 'replacement cancellation')
    const replacement = Object.values(run.kernel().plans).find(
      p =>
        p.status === 'executing' &&
        !p.recovery &&
        p.steps[0]?.payload?.kind === 'tx' &&
        p.steps[0].payload.to === midnight
    )!
    return { ...run, held, replacement, midnight, debtResource }
  }

  test('admits replacement at the full debt cap and advances only after cancellation', async () => {
    const run = await liveBorrowing()
    expect(run.replacement.status).toBe('executing')
    expect(run.notices.find(n => n.intentId === run.replacement.intentId)?.notice).toBe('admitted')
    expect(run.chain.sentTo(setter)).toHaveLength(1)
    run.chain.mine()
    await until(() => run.chain.sentTo(setter).length === 2, 'new borrowing ratification')
    expect(run.advances.find(a => a.intentId === run.replacement.intentId)).toMatchObject({
      stage: 1
    })
    const witness = run.kernel().plans[run.replacement.intentId]!.steps[1]!.witness
    expect(Tree.create(witness as never).offers.find(o => !o.buy)).toMatchObject({
      maxUnits: 10n,
      reduceOnly: false
    })
  })

  test.each(['fill', 'withdrawal'] as const)(
    'never advances the old tree after a %s reduces headroom during cancellation',
    async change => {
      const run = await liveBorrowing()
      if (change === 'fill') run.held.debt = 6n
      else run.held.collateral = 4n
      run.chain.mine()
      run.chain.finalize()
      await until(
        () =>
          run.notices.some(
            n =>
              n.intentId === run.replacement.intentId &&
              ['abandoned', 'compensated', 'failed'].includes(n.notice)
          ),
        'obsolete tree retirement'
      )
      expect(run.advances.filter(a => a.intentId === run.replacement.intentId)).toEqual([])
      await until(() => run.chain.sentTo(setter).length === 2, 'resized borrowing ratification')
      const ratified = Object.values(run.kernel().plans).find(
        p => p.status === 'executing' && !p.recovery && p.intentId !== run.replacement.intentId
      )!
      const index = ratified.steps.findIndex(step => step.witness !== undefined)
      expect(
        Tree.create(ratified.steps[index]!.witness as never).offers.find(o => !o.buy)
      ).toMatchObject({ maxUnits: 4n, reduceOnly: false })
    }
  )

  test('restart with debt mode removed still withdraws the prior borrowing tree', async () => {
    const run = await ratifying({ borrowing: true })
    run.chain.mine()
    await published(run)
    run.chain.finalize()
    await until(
      () => Object.values(run.kernel().nonces).every(n => n.resolution !== undefined),
      'publication finality'
    )
    await run.engine.abandon()
    running = []
    const restart = quoter({ store: run.store, chain: run.chain, clock: run.clock })
    const midnight = getChainAddress(CHAIN_ID, 'midnight')
    await until(() => run.chain.sentTo(midnight).length > 0, 'borrow-group recovery')
    run.chain.mine()
    run.chain.finalize()
    const restarted = await restart
    running.push(restarted.engine)
    const adopted = Object.values(restarted.engine.kernelState()!.entries).filter(e => e.adopted)
    expect(adopted.some(e => Object.keys(e.spec.resources).some(r => r.startsWith('debt:')))).toBe(
      true
    )
    expect(adopted.every(e => e.state === 'retired' || e.state === 'revoking')).toBe(true)
    expect(restarted.engine.kernelState()!.lifecycle.kind).toBe('running')
  })
})
