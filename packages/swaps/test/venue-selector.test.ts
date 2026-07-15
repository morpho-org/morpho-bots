import { parse, stringify } from '@repo/utils'
import { describe, expect, it } from 'bun:test'
import { getAddress, parseUnits } from 'viem'

import type { QuoteLogger } from '../src/quoting'
import type { PriceParameters, Venue } from '../src/types'
import type { VenuePair, VenueSelectorState } from '../src/venue-selector'

import { QuoteError } from '../src/types'
import { createVenueSelector } from '../src/venue-selector'

const NOOP_LOGGER: QuoteLogger = { info: () => {}, warn: () => {} }

const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const PAIR: VenuePair = { collateral: COLLATERAL, loan: LOAN }
const OTHER_PAIR: VenuePair = {
  collateral: getAddress('0x9999999999999999999999999999999999999999'),
  loan: LOAN
}

const SMALL = parseUnits('1', 18) // ladder point "1"
const LARGE = parseUnits('100', 18) // ladder point "100"

// A fake probe returning a fixed indicative output per `${venue}:${amountIn}`, recording every call.
function fakeProbe(
  outputs: Record<string, bigint>,
  opts: { throwFor?: (venue: Venue, amountIn: bigint) => boolean } = {}
) {
  const calls: { venue: Venue; amountIn: bigint; tokenInDecimals?: number }[] = []
  const indicativeQuote = async (venue: Venue, params: PriceParameters) => {
    calls.push({ venue, amountIn: params.amountIn, tokenInDecimals: params.tokenInDecimals })
    if (opts.throwFor?.(venue, params.amountIn)) throw new QuoteError('no_route', 'probe boom')
    const out = outputs[`${venue}:${params.amountIn}`]
    if (out === undefined) throw new QuoteError('no_route', 'no output stubbed')
    return { expectedAmountOut: out }
  }
  return { indicativeQuote, calls }
}

// 0x wins the small bucket; 1inch wins the large bucket (rankings genuinely shift with size).
const OUTPUTS: Record<string, bigint> = {
  [`0x:${SMALL}`]: 100n,
  [`1inch:${SMALL}`]: 90n,
  [`0x:${LARGE}`]: 8000n,
  [`1inch:${LARGE}`]: 9000n
}

function make(
  probe: ReturnType<typeof fakeProbe>,
  opts: { now?: () => number; staleMs?: number; decimals?: number } = {}
) {
  return createVenueSelector({
    venues: ['0x', '1inch'],
    chainId: 8453,
    ladderWholeTokens: ['1', '100'],
    getDecimals: async () => opts.decimals ?? 18,
    indicativeQuote: probe.indicativeQuote,
    staleMs: opts.staleMs ?? 1000,
    logger: NOOP_LOGGER,
    now: opts.now
  })
}

describe('createVenueSelector', () => {
  it('returns [] for a pair that has not been probed', () => {
    const selector = make(fakeProbe(OUTPUTS))
    expect(selector.select(PAIR, SMALL)).toEqual([])
  })

  it('passes the collateral decimals to every probe (for decimal-denominated venues)', async () => {
    const probe = fakeProbe(OUTPUTS)
    const selector = make(probe, { decimals: 8 })
    await selector.refresh(PAIR)
    expect(probe.calls.length).toBeGreaterThan(0)
    expect(probe.calls.every(call => call.tokenInDecimals === 8)).toBe(true)
  })

  it('ranks venues best-first per size bucket after a refresh', async () => {
    const probe = fakeProbe(OUTPUTS)
    const selector = make(probe)
    await selector.refresh(PAIR)

    // One probe per venue per ladder point.
    expect(probe.calls).toHaveLength(4)

    const small = selector.select(PAIR, SMALL)
    expect(small.map(estimate => estimate.venue)).toEqual(['0x', '1inch'])
    expect(small[0]?.expectedOut).toBe(100n)

    const large = selector.select(PAIR, LARGE)
    expect(large.map(estimate => estimate.venue)).toEqual(['1inch', '0x'])
    expect(large[0]?.expectedOut).toBe(9000n)
  })

  it('does not re-probe within staleMs, and re-probes once stale', async () => {
    let clock = 0
    const probe = fakeProbe(OUTPUTS)
    const selector = make(probe, { now: () => clock, staleMs: 1000 })

    await selector.refresh(PAIR)
    expect(probe.calls).toHaveLength(4)

    clock = 999 // still fresh
    await selector.refresh(PAIR)
    expect(probe.calls).toHaveLength(4)

    clock = 1000 // now stale (>= staleMs elapsed)
    await selector.refresh(PAIR)
    expect(probe.calls).toHaveLength(8)
  })

  it('skips a venue whose probe throws, still ranking the others', async () => {
    const probe = fakeProbe(OUTPUTS, { throwFor: venue => venue === '0x' })
    const selector = make(probe)
    await selector.refresh(PAIR)

    const small = selector.select(PAIR, SMALL)
    expect(small.map(estimate => estimate.venue)).toEqual(['1inch'])
  })

  it('keeps caches isolated per pair', async () => {
    const probe = fakeProbe(OUTPUTS)
    const selector = make(probe)
    await selector.refresh(PAIR)
    expect(selector.select(OTHER_PAIR, SMALL)).toEqual([])
  })

  it('fails loud on a non-positive ladder size', async () => {
    const probe = fakeProbe(OUTPUTS)
    const selector = createVenueSelector({
      venues: ['0x'],
      chainId: 8453,
      ladderWholeTokens: ['0'],
      getDecimals: async () => 18,
      indicativeQuote: probe.indicativeQuote,
      staleMs: 1000,
      logger: NOOP_LOGGER
    })
    await expect(selector.refresh(PAIR)).rejects.toThrow(/invalid probe ladder size/)
  })

  it('restores dumped state without re-probing while fresh, and re-probes once stale', async () => {
    let t = 0
    const probeA = fakeProbe(OUTPUTS)
    const a = make(probeA, { now: () => t, staleMs: 1000 })
    await a.refresh(PAIR)

    const state = parse<VenueSelectorState>(stringify(a.dump()), 'throw')
    expect(state).toEqual(a.dump()) // bigint ladder/expectedOut survive the JSON round trip

    const probeB = fakeProbe(OUTPUTS)
    let decimalsCalls = 0
    const b = createVenueSelector({
      venues: ['0x', '1inch'],
      chainId: 8453,
      ladderWholeTokens: ['1', '100'],
      getDecimals: async () => {
        decimalsCalls += 1
        return 18
      },
      indicativeQuote: probeB.indicativeQuote,
      staleMs: 1000,
      logger: NOOP_LOGGER,
      now: () => t,
      initialState: state
    })

    await b.refresh(PAIR) // fresh restored entry → no venue calls
    expect(probeB.calls).toHaveLength(0)
    expect(b.select(PAIR, SMALL)[0]?.venue).toBe('0x')
    expect(b.select(PAIR, LARGE)[0]?.venue).toBe('1inch')

    t = 2000 // past staleMs: a restored entry must NOT pin an outdated ranking
    await b.refresh(PAIR)
    expect(probeB.calls.length).toBeGreaterThan(0)
    expect(decimalsCalls).toBe(0) // the decimals cache was restored too
  })
})
