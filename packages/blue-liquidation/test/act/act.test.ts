import type { Logger, TransactionRecord } from '@repo/bot-kit'
import type { QuoteOutcome, Swap } from '@repo/swaps'
import type { Address } from 'viem'

import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { MarketParams } from '../../src/market'
import type { LensOut } from '../../src/state/lens.sol'

import { runAct } from '../../src/act/act'
import { loadActConfig } from '../../src/config'
import { ORACLE_PRICE_SCALE, WAD } from '../../src/constants'
import { marketId } from '../../src/market'
import { lensKey } from '../../src/state/lens.sol'
import { formatOpportunityId } from '../../src/wire'

function spyLogger() {
  const events: { level: string; event: string; fields?: Record<string, unknown> }[] = []
  const make = (level: string) => (event: string, fields?: Record<string, unknown>) =>
    events.push({ level, event, fields })
  const logger: Logger = {
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error')
  }
  return { logger, events }
}

const CHAIN_ID = 8453
const BORROWER: Address = getAddress('0x1111111111111111111111111111111111111111')
const LOAN: Address = getAddress('0x3333333333333333333333333333333333333333')
const COLL: Address = getAddress('0x4444444444444444444444444444444444444444')
const ORACLE: Address = getAddress('0x5555555555555555555555555555555555555555')
const IRM: Address = getAddress('0x46415998764C29aB2a25CbeA6254146D50D22687')
const EXECUTOR: Address = getAddress('0x7777777777777777777777777777777777777777')
const ROUTER: Address = getAddress('0x6666666666666666666666666666666666666666')

const PARAMS: MarketParams = {
  loanToken: LOAN,
  collateralToken: COLL,
  oracle: ORACLE,
  irm: IRM,
  lltv: 86n * 10n ** 16n
}
const ID = formatOpportunityId(CHAIN_ID, marketId(PARAMS), BORROWER)

const SWAP: Swap = {
  spender: ROUTER,
  target: ROUTER,
  value: 0n,
  callData: '0xabcdef',
  amountIn: { source: 'balance', offset: 132n },
  expectedAmountOut: 2000n * WAD,
  amountOutMinimum: 1n
}

function lensOut(overrides: Partial<LensOut> = {}): LensOut {
  return {
    params: PARAMS,
    valid: true,
    hasDebt: true,
    healthy: false,
    blockTimestamp: 1000n,
    borrowShares: 1000n * WAD * 10n ** 6n,
    collateral: 5000n * WAD,
    accruedTotalBorrowAssets: 5000n * WAD,
    totalBorrowShares: 5000n * WAD * 10n ** 6n,
    collateralPrice: ORACLE_PRICE_SCALE,
    lltv: PARAMS.lltv,
    ...overrides
  }
}

function runWith(opts: {
  records?: unknown[]
  out?: LensOut | null
  quoteOutcome?: QuoteOutcome
  simRevert?: string | null
  head?: bigint
  outByKey?: Map<string, LensOut>
}) {
  const { logger, events } = spyLogger()
  const emitted: TransactionRecord[] = []
  let lensReads = 0
  let quoteCalls = 0
  let simCalls = 0
  const head = opts.head ?? 100n
  const promise = runAct({
    records: opts.records ?? [
      {
        kind: 'position',
        chainId: CHAIN_ID,
        id: ID,
        marketId: marketId(PARAMS),
        borrower: BORROWER,
        market: { ...PARAMS, lltv: PARAMS.lltv.toString() }
      }
    ],
    chainId: CHAIN_ID,
    head,
    readLensForPositions: async evaluands => {
      lensReads += 1
      if (opts.outByKey) return opts.outByKey
      const map = new Map<string, LensOut>()
      const out = opts.out === undefined ? lensOut() : opts.out
      if (out) for (const e of evaluands) map.set(lensKey(e.marketId, e.borrower), out)
      return map
    },
    quoteFor: async () => {
      quoteCalls += 1
      return opts.quoteOutcome ?? { kind: 'swap', swap: SWAP }
    },
    simulate: async () => {
      simCalls += 1
      return opts.simRevert ?? null
    },
    encodeExec: () => '0xdeadbeef',
    executor: EXECUTOR,
    emit: record => emitted.push(record),
    logger
  })
  return promise.then(counters => ({
    counters,
    emitted,
    events,
    lensReads: () => lensReads,
    quoteCalls: () => quoteCalls,
    simCalls: () => simCalls
  }))
}

describe('runAct', () => {
  it('emits a transaction for a liquidatable position whose sim succeeds', async () => {
    const { counters, emitted, quoteCalls, simCalls } = await runWith({ simRevert: null })
    expect(counters.ok).toBe(1)
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!).toEqual({
      kind: 'transaction',
      id: ID,
      chainId: CHAIN_ID,
      to: EXECUTOR,
      data: '0xdeadbeef',
      value: '0',
      simulatedAtBlock: 100
    })
    expect(quoteCalls()).toBe(1)
    expect(simCalls()).toBe(1)
  })

  it('logs a malformed position and never reads the lens', async () => {
    const { counters, emitted, lensReads, events } = await runWith({
      records: [{ id: 'not-enough' }]
    })
    expect(counters.invalid).toBe(1)
    expect(emitted).toHaveLength(0)
    expect(events.some(e => e.event === 'act.skip' && e.fields?.status === 'invalid_record')).toBe(
      true
    )
    expect(lensReads()).toBe(0)
  })

  it('rejects an empty correlation id before reading the lens', async () => {
    const { counters, lensReads } = await runWith({
      records: [
        {
          kind: 'position',
          chainId: CHAIN_ID,
          id: '  ',
          marketId: marketId(PARAMS),
          borrower: BORROWER,
          market: { ...PARAMS, lltv: PARAMS.lltv.toString() }
        }
      ]
    })
    expect(counters.invalid).toBe(1)
    expect(lensReads()).toBe(0)
  })

  it('joins fresh state by market and borrower when correlation ids collide', async () => {
    const otherBorrower = getAddress('0x2222222222222222222222222222222222222222')
    const position = (borrower: Address) => ({
      kind: 'position',
      chainId: CHAIN_ID,
      id: 'same-correlation-id',
      marketId: marketId(PARAMS),
      borrower,
      market: { ...PARAMS, lltv: PARAMS.lltv.toString() }
    })
    const outByKey = new Map([
      [lensKey(marketId(PARAMS), BORROWER), lensOut({ healthy: true })],
      [lensKey(marketId(PARAMS), otherBorrower), lensOut()]
    ])

    const { counters, emitted } = await runWith({
      records: [position(BORROWER), position(otherBorrower)],
      outByKey
    })
    expect(counters.notLiquidatable).toBe(1)
    expect(counters.ok).toBe(1)
    expect(emitted).toHaveLength(1)
  })

  it('rejects supplied market params that do not commit to marketId', async () => {
    const { counters, emitted } = await runWith({
      records: [
        {
          kind: 'position',
          chainId: CHAIN_ID,
          id: ID,
          marketId: marketId(PARAMS),
          borrower: BORROWER,
          market: { ...PARAMS, loanToken: COLL, lltv: PARAMS.lltv.toString() }
        }
      ]
    })
    expect(counters.invalid).toBe(1)
    expect(emitted).toHaveLength(0)
  })

  it('emits not_liquidatable when the lens says healthy', async () => {
    const { counters, emitted, quoteCalls, events } = await runWith({
      out: lensOut({ healthy: true })
    })
    expect(counters.notLiquidatable).toBe(1)
    expect(emitted).toHaveLength(0)
    expect(events.some(e => e.fields?.status === 'not_liquidatable')).toBe(true)
    expect(quoteCalls()).toBe(0)
  })

  it('emits not_liquidatable when the lens did not return the id', async () => {
    const { counters, emitted } = await runWith({ out: null })
    expect(counters.notLiquidatable).toBe(1)
    expect(emitted).toHaveLength(0)
  })

  it('emits no_swap_path when no venue covers the collateral (no sim)', async () => {
    const { counters, emitted, simCalls } = await runWith({ quoteOutcome: { kind: 'no_config' } })
    expect(counters.noSwapPath).toBe(1)
    expect(emitted).toHaveLength(0)
    expect(simCalls()).toBe(0)
  })

  it('emits quote_failed with the reason and never simulates', async () => {
    const { counters, emitted, simCalls } = await runWith({
      quoteOutcome: { kind: 'failed', reason: 'no_route' }
    })
    expect(counters.quoteFailed).toBe(1)
    expect(emitted).toHaveLength(0)
    expect(simCalls()).toBe(0)
  })

  it('logs sim_reverted with the revert reason and emits no transaction', async () => {
    const { counters, emitted } = await runWith({ simRevert: 'amountOutMinimum not met' })
    expect(counters.reverted).toBe(1)
    expect(emitted).toHaveLength(0)
  })
})

describe('loadActConfig', () => {
  // An `undefined` override models the var being absent — `required()` treats both the same.
  const actEnv = (overrides: Record<string, string | undefined> = {}) => ({
    CHAIN_ID: String(CHAIN_ID),
    RPC_URL: 'https://base.example',
    LIQUIDATOR_ADDRESS: BORROWER as string, // any valid EOA; reused constant
    ...overrides
  })

  it('fails loud without LIQUIDATOR_ADDRESS (the skim recipient / simulate from)', () => {
    expect(() => loadActConfig(actEnv({ LIQUIDATOR_ADDRESS: undefined }))).toThrow(
      /LIQUIDATOR_ADDRESS/
    )
  })

  it('rejects a malformed LIQUIDATOR_ADDRESS', () => {
    expect(() => loadActConfig(actEnv({ LIQUIDATOR_ADDRESS: 'nope' }))).toThrow(
      /LIQUIDATOR_ADDRESS is not a valid address/
    )
  })

  it('checksums LIQUIDATOR_ADDRESS and never requires the private key', () => {
    const config = loadActConfig(actEnv({ LIQUIDATOR_ADDRESS: BORROWER.toLowerCase() }))
    expect(config.liquidatorAddress).toBe(BORROWER)
    expect('liquidatorPrivateKey' in config).toBe(false)
  })
})
