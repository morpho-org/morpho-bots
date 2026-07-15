import type { Logger } from '@repo/evm-kit'
import type { CooldownStore, TransactionRecord } from '@repo/pipeline'
import type { QuoteOutcome, Swap } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import { createCooldownStore } from '@repo/pipeline'
import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { LensOut } from '../../src/lens.sol'

import { loadLiquidateConfig } from '../../src/config'
import { lensKey } from '../../src/lens.sol'
import { prepareLiquidations } from '../../src/ops/liquidate'
import { formatPositionId } from '../../src/position-id'

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
const TOKEN: Address = getAddress('0x3333333333333333333333333333333333333333')
const ORACLE: Address = getAddress('0x4444444444444444444444444444444444444444')
const ROUTER: Address = getAddress('0x5555555555555555555555555555555555555555')
const EXECUTOR: Address = getAddress('0x7777777777777777777777777777777777777777')
const ZERO = '0x0000000000000000000000000000000000000000' as const
const MARKET: Hex = `0x${'a'.repeat(64)}`
const ID = formatPositionId(CHAIN_ID, MARKET, BORROWER)

const SWAP: Swap = {
  spender: ROUTER,
  target: ROUTER,
  value: 0n,
  callData: '0xabcdef',
  amountIn: { source: 'balance', offset: 132n },
  expectedAmountOut: 2000n,
  amountOutMinimum: 1n
}

function lensOut(overrides: Partial<LensOut> = {}): LensOut {
  return {
    valid: true,
    hasDebt: true,
    healthy: false,
    locked: false,
    gateAllows: true,
    blockTimestamp: 1000n,
    debt: 1000n,
    maxDebt: 900n,
    badDebt: 0n,
    activatedBitmap: 1n,
    bestCollateralIdx: 0,
    bestCollateralAmt: 5000n,
    bestCollateralPrice: 10n ** 36n,
    bestCollateralMaxLif: 1100000000000000000n,
    bestCollateralLltv: 860000000000000000n,
    market: {
      chainId: 8453n,
      midnight: ZERO,
      loanToken: TOKEN,
      collateralParams: [
        {
          token: TOKEN,
          lltv: 860000000000000000n,
          liquidationCursor: 250000000000000000n,
          oracle: ORACLE
        }
      ],
      maturity: 2000n,
      rcfThreshold: 10n ** 30n,
      enterGate: ZERO,
      liquidatorGate: ZERO
    },
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
  cooldown?: CooldownStore
}) {
  const { logger, events } = spyLogger()
  const emitted: TransactionRecord[] = []
  let quoteCalls = 0
  let simCalls = 0
  const head = opts.head ?? 100n
  const promise = prepareLiquidations({
    records: opts.records ?? [
      { kind: 'position', chainId: CHAIN_ID, id: ID, marketId: MARKET, borrower: BORROWER }
    ],
    chainId: CHAIN_ID,
    head,
    seizeCapMarginBps: 0,
    readLensForPositions: async evaluands => {
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
    // Default to a disabled store so pre-existing cases are unaffected; cooldown cases inject one.
    cooldown: opts.cooldown ?? createCooldownStore({ cooldownMs: 0 }),
    emit: record => emitted.push(record),
    logger
  })
  return promise.then(counters => ({
    counters,
    emitted,
    events,
    quoteCalls: () => quoteCalls,
    simCalls: () => simCalls
  }))
}

describe('prepareLiquidations', () => {
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

  it('emits a transaction for a bad-debt realization without quoting', async () => {
    const { counters, emitted, quoteCalls, simCalls } = await runWith({
      out: lensOut({ healthy: true, blockTimestamp: 3000n, debt: 1000n, badDebt: 1000n })
    })
    expect(counters.ok).toBe(1)
    expect(emitted).toHaveLength(1)
    expect(quoteCalls()).toBe(0) // bad-debt realization never quotes
    expect(simCalls()).toBe(1)
  })

  it('logs and skips a malformed position with its best-effort id', async () => {
    const { counters, emitted, events } = await runWith({ records: [{ id: 'not-enough' }] })
    expect(counters.invalid).toBe(1)
    expect(emitted).toHaveLength(0)
    const skip = events.find(
      e => e.event === 'transform.skip' && e.fields?.status === 'invalid_record'
    )
    expect(skip?.fields?.id).toBe('not-enough')
  })

  it('omits id on an invalid_record that carries no usable id', async () => {
    const { counters, events } = await runWith({
      records: [{ kind: 'position', chainId: CHAIN_ID }]
    })
    expect(counters.invalid).toBe(1)
    const skip = events.find(
      e => e.event === 'transform.skip' && e.fields?.status === 'invalid_record'
    )
    expect(skip).toBeDefined()
    expect(skip!.fields && 'id' in skip!.fields).toBe(false)
  })

  it('rejects an empty correlation id', async () => {
    const { counters, emitted } = await runWith({
      records: [
        { kind: 'position', chainId: CHAIN_ID, id: '\t', marketId: MARKET, borrower: BORROWER }
      ]
    })
    expect(counters.invalid).toBe(1)
    expect(emitted).toHaveLength(0)
  })

  it('joins fresh state by market and borrower when correlation ids collide', async () => {
    const otherBorrower = getAddress('0x2222222222222222222222222222222222222222')
    const position = (borrower: Address) => ({
      kind: 'position',
      chainId: CHAIN_ID,
      id: 'same-correlation-id',
      marketId: MARKET,
      borrower
    })
    const outByKey = new Map([
      [lensKey(MARKET, BORROWER), lensOut({ healthy: true })],
      [lensKey(MARKET, otherBorrower), lensOut()]
    ])

    const { counters, emitted } = await runWith({
      records: [position(BORROWER), position(otherBorrower)],
      outByKey
    })
    expect(counters.notLiquidatable).toBe(1)
    expect(counters.ok).toBe(1)
    expect(emitted).toHaveLength(1)
  })

  it('emits not_liquidatable when the lens says healthy (pre-maturity)', async () => {
    const { counters, emitted, quoteCalls } = await runWith({ out: lensOut({ healthy: true }) })
    expect(counters.notLiquidatable).toBe(1)
    expect(emitted).toHaveLength(0)
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

  it('skips a position still within its cooldown window and never quotes', async () => {
    const cooldown = createCooldownStore({
      cooldownMs: 60_000,
      now: () => 1_000_000,
      initial: [[ID, 1_000_000 - 30_000]] // attempted 30s ago, window is 60s
    })
    const { counters, emitted, quoteCalls, events } = await runWith({ cooldown })
    expect(counters.cooledDown).toBe(1)
    expect(emitted).toHaveLength(0)
    expect(quoteCalls()).toBe(0)
    expect(events.some(e => e.fields?.status === 'cooldown')).toBe(true)
  })

  it('marks a quote_failed attempt for backoff and skips it on the next pass', async () => {
    const cooldown = createCooldownStore({ cooldownMs: 60_000, now: () => 1_000_000 })
    const first = await runWith({ cooldown, quoteOutcome: { kind: 'failed', reason: 'no_route' } })
    expect(first.counters.quoteFailed).toBe(1)
    expect(cooldown.dump().map(([id]) => id)).toContain(ID)

    const second = await runWith({ cooldown })
    expect(second.counters.cooledDown).toBe(1)
    expect(second.quoteCalls()).toBe(0)
  })

  it('backs off a reverting bad-debt realization (no quote, shared revert branch)', async () => {
    const cooldown = createCooldownStore({ cooldownMs: 60_000, now: () => 1_000_000 })
    const { counters, quoteCalls } = await runWith({
      cooldown,
      out: lensOut({ healthy: true, blockTimestamp: 3000n, debt: 1000n, badDebt: 1000n }),
      simRevert: 'realize failed'
    })
    expect(counters.reverted).toBe(1)
    expect(quoteCalls()).toBe(0) // bad-debt realization never quotes
    expect(cooldown.dump().map(([id]) => id)).toContain(ID)
  })

  it('never marks a successful liquidation (so a dropped tx retries next tick)', async () => {
    const cooldown = createCooldownStore({ cooldownMs: 60_000, now: () => 1_000_000 })
    const { counters } = await runWith({ cooldown })
    expect(counters.ok).toBe(1)
    expect(cooldown.dump()).toHaveLength(0)
  })
})

describe('loadLiquidateConfig', () => {
  // An `undefined` override models the var being absent — `required()` treats both the same.
  const actEnv = (overrides: Record<string, string | undefined> = {}) => ({
    CHAIN_ID: String(CHAIN_ID),
    RPC_URL: 'https://base.example',
    LIQUIDATOR_ADDRESS: BORROWER as string, // any valid EOA; reused constant
    ZEROX_API_KEY: 'zerox-key',
    ...overrides
  })

  it('fails loud without LIQUIDATOR_ADDRESS (the skim recipient / simulate from)', () => {
    expect(() => loadLiquidateConfig(actEnv({ LIQUIDATOR_ADDRESS: undefined }))).toThrow(
      /LIQUIDATOR_ADDRESS/
    )
  })

  it('rejects a malformed LIQUIDATOR_ADDRESS', () => {
    expect(() => loadLiquidateConfig(actEnv({ LIQUIDATOR_ADDRESS: 'nope' }))).toThrow(
      /LIQUIDATOR_ADDRESS is not a valid address/
    )
  })

  it('checksums LIQUIDATOR_ADDRESS and never requires the private key', () => {
    const config = loadLiquidateConfig(actEnv({ LIQUIDATOR_ADDRESS: BORROWER.toLowerCase() }))
    expect(config.liquidatorAddress).toBe(BORROWER)
    expect('liquidatorPrivateKey' in config).toBe(false)
  })

  it('defaults positionCooldownMs to 0 (disabled) and parses an override', () => {
    expect(loadLiquidateConfig(actEnv()).positionCooldownMs).toBe(0)
    expect(
      loadLiquidateConfig(actEnv({ POSITION_LIQUIDATION_COOLDOWN_MS: '3600000' }))
        .positionCooldownMs
    ).toBe(3_600_000)
  })
})
