import type { BackoffState, Logger, OutcomeRecord, TxRecord } from '@repo/bot-kit'
import type { QuoteOutcome, Swap } from '@repo/swaps'
import type { Address, Hex } from 'viem'

import { describe, expect, it } from 'bun:test'
import { getAddress } from 'viem'

import type { LensOut } from '../../src/state/lens.sol'
import type { ParsedOpportunityId } from '../../src/wire'

import { runAct } from '../../src/act/act'
import { loadActConfig } from '../../src/config'
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
const TOKEN: Address = getAddress('0x3333333333333333333333333333333333333333')
const ORACLE: Address = getAddress('0x4444444444444444444444444444444444444444')
const ROUTER: Address = getAddress('0x5555555555555555555555555555555555555555')
const EXECUTOR: Address = getAddress('0x7777777777777777777777777777777777777777')
const ZERO = '0x0000000000000000000000000000000000000000' as const
const MARKET: Hex = `0x${'a'.repeat(64)}`
const ID = formatOpportunityId(CHAIN_ID, MARKET, BORROWER)

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
  ids?: string[]
  out?: LensOut | null
  quoteOutcome?: QuoteOutcome
  simRevert?: string | null
  inflight?: readonly string[]
  backoff?: BackoffState | null
  head?: bigint
}) {
  const { logger, events } = spyLogger()
  const emitted: (TxRecord | OutcomeRecord)[] = []
  let quoteCalls = 0
  let simCalls = 0
  const head = opts.head ?? 100n
  const promise = runAct({
    ids: opts.ids ?? [ID],
    chainId: CHAIN_ID,
    head,
    seizeCapMarginBps: 0,
    advisory: { backoff: opts.backoff ?? null, inflightLabels: opts.inflight ?? [] },
    backoffConfig: { baseBlocks: 2n, maxBlocks: 64n },
    readLensForIds: async (evaluands: readonly (ParsedOpportunityId & { id: string })[]) => {
      const map = new Map<string, LensOut>()
      const out = opts.out === undefined ? lensOut() : opts.out
      if (out) for (const e of evaluands) map.set(e.id, out)
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
    quoteCalls: () => quoteCalls,
    simCalls: () => simCalls
  }))
}

const outcomes = (records: (TxRecord | OutcomeRecord)[]) =>
  records.filter((r): r is OutcomeRecord => r.kind === 'outcome')
const txs = (records: (TxRecord | OutcomeRecord)[]) =>
  records.filter((r): r is TxRecord => r.kind === 'tx')

describe('runAct', () => {
  it('emits a TxRecord for a liquidatable position whose sim succeeds', async () => {
    const { counters, emitted, quoteCalls, simCalls } = await runWith({ simRevert: null })
    expect(counters.ok).toBe(1)
    const tx = txs(emitted)
    expect(tx).toHaveLength(1)
    expect(tx[0]!).toMatchObject({
      kind: 'tx',
      id: ID,
      domain: 'midnight',
      to: EXECUTOR,
      data: '0xdeadbeef',
      simulated: { status: 'ok', block: 100 }
    })
    expect(quoteCalls()).toBe(1)
    expect(simCalls()).toBe(1)
  })

  it('emits a TxRecord for a bad-debt realization without quoting', async () => {
    const { counters, emitted, quoteCalls, simCalls } = await runWith({
      out: lensOut({ healthy: true, blockTimestamp: 3000n, debt: 1000n, badDebt: 1000n })
    })
    expect(counters.ok).toBe(1)
    expect(txs(emitted)).toHaveLength(1)
    expect(quoteCalls()).toBe(0) // bad-debt realization never quotes
    expect(simCalls()).toBe(1)
  })

  it('emits bad_id for a malformed id', async () => {
    const { counters, emitted } = await runWith({ ids: ['not-an-id'] })
    expect(counters.badId).toBe(1)
    expect(outcomes(emitted)[0]!.status).toBe('bad_id')
  })

  it('emits skipped_inflight and does not re-derive an in-flight id', async () => {
    const { counters, emitted, quoteCalls } = await runWith({ inflight: [ID] })
    expect(counters.skippedInflight).toBe(1)
    expect(outcomes(emitted)[0]!.status).toBe('skipped_inflight')
    expect(quoteCalls()).toBe(0)
  })

  it('emits backoff_skipped for a backed-off id without quoting', async () => {
    const { counters, emitted, quoteCalls } = await runWith({
      backoff: [[ID, { attempts: 1, until: 200n }]],
      head: 100n
    })
    expect(counters.backoffSkipped).toBe(1)
    expect(outcomes(emitted)[0]!.status).toBe('backoff_skipped')
    expect(quoteCalls()).toBe(0)
  })

  it('does not mutate the caller-supplied backoff snapshot', async () => {
    const backoff: BackoffState = [[ID, { attempts: 1, until: 200n }]]
    const before = structuredClone(backoff)
    await runWith({ backoff, head: 100n })
    expect(backoff).toEqual(before)
  })

  it('emits not_liquidatable when the lens says healthy (pre-maturity)', async () => {
    const { counters, emitted, quoteCalls } = await runWith({ out: lensOut({ healthy: true }) })
    expect(counters.notLiquidatable).toBe(1)
    expect(outcomes(emitted)[0]!.status).toBe('not_liquidatable')
    expect(quoteCalls()).toBe(0)
  })

  it('emits not_liquidatable when the lens did not return the id', async () => {
    const { counters, emitted } = await runWith({ out: null })
    expect(counters.notLiquidatable).toBe(1)
    expect(outcomes(emitted)[0]!.status).toBe('not_liquidatable')
  })

  it('emits no_swap_path when no venue covers the collateral (no sim)', async () => {
    const { counters, emitted, simCalls } = await runWith({ quoteOutcome: { kind: 'no_config' } })
    expect(counters.noSwapPath).toBe(1)
    expect(outcomes(emitted)[0]!.status).toBe('no_swap_path')
    expect(simCalls()).toBe(0)
  })

  it('emits quote_failed with the reason and never simulates', async () => {
    const { counters, emitted, simCalls } = await runWith({
      quoteOutcome: { kind: 'failed', reason: 'no_route' }
    })
    expect(counters.quoteFailed).toBe(1)
    const outcome = outcomes(emitted)[0]!
    expect(outcome.status).toBe('quote_failed')
    expect(outcome.reason).toBe('no_route')
    expect(simCalls()).toBe(0)
  })

  it('emits sim_reverted with the revert reason and no TxRecord', async () => {
    const { counters, emitted } = await runWith({ simRevert: 'amountOutMinimum not met' })
    expect(counters.reverted).toBe(1)
    expect(txs(emitted)).toHaveLength(0)
    const outcome = outcomes(emitted)[0]!
    expect(outcome.status).toBe('sim_reverted')
    expect(outcome.reason).toBe('amountOutMinimum not met')
  })
})

describe('loadActConfig', () => {
  // An `undefined` override models the var being absent — `required()` treats both the same.
  const actEnv = (overrides: Record<string, string | undefined> = {}) => ({
    CHAIN_ID: String(CHAIN_ID),
    RPC_URL: 'https://base.example',
    LIQUIDATOR_ADDRESS: BORROWER as string, // any valid EOA; reused constant
    ZEROX_API_KEY: 'zerox-key',
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
