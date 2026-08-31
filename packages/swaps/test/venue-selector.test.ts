import type { Address } from 'viem'

import { getAddress, parseUnits } from 'viem'
import { describe, expect, it } from 'vitest'

import type { QuoteLogger } from '../src/quoting'
import type { PriceParameters, Venue } from '../src/types'
import type { VenuePair } from '../src/venue-selector'

import { QuoteError } from '../src/types'
import { createVenueSelector, USD_LADDER_PRICE_DECIMALS } from '../src/venue-selector'

const NOOP_LOGGER: QuoteLogger = { info: () => {}, warn: () => {} }

const COLLATERAL = getAddress('0x7777777777777777777777777777777777777777')
const LOAN = getAddress('0x6666666666666666666666666666666666666666')
const PAIR: VenuePair = { collateral: COLLATERAL, loan: LOAN }
const OTHER_PAIR: VenuePair = {
  collateral: getAddress('0x9999999999999999999999999999999999999999'),
  loan: LOAN
}

const SMALL = parseUnits('1', 18) // ladder point "1"
const MID = parseUnits('10', 18) // geometric midpoint of the "1"/"100" rungs
const LARGE = parseUnits('100', 18) // ladder point "100"

const usdPrice = (whole: string) => async () => parseUnits(whole, USD_LADDER_PRICE_DECIMALS)

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

// A single-venue curve coarse enough to read an interpolated value off: rate 1e6 at the "1" rung,
// 8e5 at the "100" rung, so the log-midpoint "10" must land on 9e5.
const CURVE: Record<string, bigint> = {
  [`0x:${SMALL}`]: 1_000_000n,
  [`0x:${LARGE}`]: 80_000_000n
}

function make(
  probe: ReturnType<typeof fakeProbe>,
  opts: {
    now?: () => number
    staleMs?: number
    decimals?: number
    ladderSizes?: readonly string[]
    usdPriceOf?: (token: Address) => Promise<bigint | null>
  } = {}
) {
  return createVenueSelector({
    venues: ['0x', '1inch'],
    chainId: 8453,
    ladderSizes: opts.ladderSizes ?? ['1', '100'],
    getDecimals: async () => opts.decimals ?? 18,
    usdPriceOf: opts.usdPriceOf,
    indicativeQuote: probe.indicativeQuote,
    staleMs: opts.staleMs ?? 1000,
    logger: NOOP_LOGGER,
    now: opts.now
  })
}

const probedSizes = (probe: ReturnType<typeof fakeProbe>) => [
  ...new Set(probe.calls.map(call => call.amountIn))
]

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
    expect(small[0]?.estimatedOut).toBe(100n)

    const large = selector.select(PAIR, LARGE)
    expect(large.map(estimate => estimate.venue)).toEqual(['1inch', '0x'])
    expect(large[0]?.estimatedOut).toBe(9000n)
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
      ladderSizes: ['0'],
      getDecimals: async () => 18,
      indicativeQuote: probe.indicativeQuote,
      staleMs: 1000,
      logger: NOOP_LOGGER
    })
    await expect(selector.refresh(PAIR)).rejects.toThrow(/invalid probe ladder size/)
  })

  describe('USD ladder', () => {
    it('converts USD rungs to base units for an 8-decimal collateral', async () => {
      const probe = fakeProbe({})
      const selector = make(probe, {
        decimals: 8,
        ladderSizes: ['0.01', '1', '100'],
        usdPriceOf: usdPrice('80000')
      })
      await selector.refresh(PAIR)
      // $0.01 / $80k = 1.25e-7 BTC = 12 base units (floored); then $1 and $100.
      expect(probedSizes(probe)).toEqual([12n, 1250n, 125_000n])
    })

    it('converts USD rungs to base units for an 18-decimal collateral', async () => {
      const probe = fakeProbe({})
      const selector = make(probe, {
        decimals: 18,
        ladderSizes: ['1', '100'],
        usdPriceOf: usdPrice('2')
      })
      await selector.refresh(PAIR)
      expect(probedSizes(probe)).toEqual([parseUnits('0.5', 18), parseUnits('50', 18)])
    })

    it('falls back to the whole-token ladder when no price source is wired', async () => {
      const probe = fakeProbe({})
      const selector = make(probe, { decimals: 18, ladderSizes: ['1', '100'] })
      await selector.refresh(PAIR)
      expect(probedSizes(probe)).toEqual([SMALL, LARGE])
    })

    it('falls back to the whole-token ladder when the price source returns null', async () => {
      const probe = fakeProbe({})
      const selector = make(probe, {
        decimals: 18,
        ladderSizes: ['1', '100'],
        usdPriceOf: async () => null
      })
      await selector.refresh(PAIR)
      expect(probedSizes(probe)).toEqual([SMALL, LARGE])
    })
  })

  describe('interpolation', () => {
    it('interpolates the rate log-linearly between two rungs', async () => {
      const probe = fakeProbe(CURVE)
      const selector = make(probe)
      await selector.refresh(PAIR)

      // Rates 1e6 → 8e5 across a 100x span; "10" is the log midpoint, so the rate is 9e5.
      const [estimate] = selector.select(PAIR, MID)
      expect(estimate?.venue).toBe('0x')
      expect(estimate?.estimatedOut).toBe(9_000_000n)
      expect(estimate?.clamped).toBe(false)
    })

    it('clamps below the bottom rung rather than extrapolating', async () => {
      const probe = fakeProbe(CURVE)
      const selector = make(probe)
      await selector.refresh(PAIR)

      const [estimate] = selector.select(PAIR, parseUnits('0.1', 18))
      expect(estimate?.estimatedOut).toBe(100_000n) // the "1" rung's rate, not an extrapolated one
      expect(estimate?.clamped).toBe(true)
    })

    it('clamps above the top rung rather than extrapolating', async () => {
      const probe = fakeProbe(CURVE)
      const selector = make(probe)
      await selector.refresh(PAIR)

      const [estimate] = selector.select(PAIR, parseUnits('1000', 18))
      expect(estimate?.estimatedOut).toBe(800_000_000n) // the "100" rung's rate
      expect(estimate?.clamped).toBe(true)
    })

    it('clamps inside the ladder when the bracketing end rungs failed to probe', async () => {
      const probe = fakeProbe({ [`0x:${MID}`]: 8_000_000n })
      const selector = make(probe, { ladderSizes: ['1', '10', '100'] })
      await selector.refresh(PAIR)

      const [atHole] = selector.select(PAIR, MID)
      expect(atHole?.estimatedOut).toBe(8_000_000n)
      expect(atHole?.clamped).toBe(true)

      const [belowHole] = selector.select(PAIR, SMALL)
      expect(belowHole?.estimatedOut).toBe(800_000n)
      expect(belowHole?.clamped).toBe(true)
    })
  })

  describe('cost against the caller oracle', () => {
    it('derives different costs for two markets sharing one cached curve', async () => {
      const probe = fakeProbe(OUTPUTS)
      const selector = make(probe)
      await selector.refresh(PAIR)

      const lenient = selector.select(PAIR, SMALL, 110n)
      const strict = selector.select(PAIR, SMALL, 200n)

      expect(probe.calls).toHaveLength(4) // one shared refresh, two oracles
      expect(lenient[0]?.estimatedOut).toBe(strict[0]?.estimatedOut)
      expect(lenient[0]?.costBps).toBeCloseTo(909.09, 2)
      expect(strict[0]?.costBps).toBe(5000)
    })

    it('reports null rather than dividing by a zero or dust-quantized reference', async () => {
      const probe = fakeProbe(OUTPUTS)
      const selector = make(probe)
      await selector.refresh(PAIR)

      expect(selector.select(PAIR, SMALL)[0]?.costBps).toBeNull()
      expect(selector.select(PAIR, SMALL, 0n)[0]?.costBps).toBeNull()
    })

    it('floors a venue that beats the oracle at zero rather than scoring it as a bonus', async () => {
      const probe = fakeProbe(OUTPUTS)
      const selector = make(probe)
      await selector.refresh(PAIR)

      const [best] = selector.select(PAIR, SMALL, 80n) // estimatedOut 100 > reference 80
      expect(best?.costBps).toBe(0)
    })

    it('keeps the unfloored cost on costBpsRaw so a stale oracle stays visible', async () => {
      const probe = fakeProbe(OUTPUTS)
      const selector = make(probe)
      await selector.refresh(PAIR)

      // estimatedOut 100 against a reference of 80 is -2500 bps: the signature of a stale oracle,
      // which the floored `costBps` deliberately hides from scorers and must not lose entirely.
      const [best] = selector.select(PAIR, SMALL, 80n)
      expect(best?.costBpsRaw).toBe(-2500)
      expect(best?.costBps).toBe(0)
    })
  })

  describe('degradation', () => {
    it('keeps venue ordering under a uniform price drift, while the cost level moves', async () => {
      const drifted = Object.fromEntries(
        Object.entries(OUTPUTS).map(([key, out]) => [key, (out * 97n) / 100n])
      )
      const fresh = make(fakeProbe(OUTPUTS))
      let clock = 0
      const stale = make(fakeProbe(drifted), { now: () => clock, staleMs: 1000 })
      await fresh.refresh(PAIR)
      await stale.refresh(PAIR)
      clock = 10_000_000 // far beyond staleMs, and never re-probed

      const order = (estimates: { venue: Venue }[]) => estimates.map(estimate => estimate.venue)
      expect(order(stale.select(PAIR, SMALL))).toEqual(order(fresh.select(PAIR, SMALL)))
      expect(order(stale.select(PAIR, LARGE))).toEqual(order(fresh.select(PAIR, LARGE)))
      expect(stale.select(PAIR, SMALL, 120n)[0]?.costBps).not.toBe(
        fresh.select(PAIR, SMALL, 120n)[0]?.costBps
      )
    })

    it('marks a venue with one-sided data clamped instead of reporting a confident cost', async () => {
      const probe = fakeProbe({
        [`0x:${LARGE}`]: 8000n,
        [`1inch:${SMALL}`]: 90n,
        [`1inch:${LARGE}`]: 9000n
      })
      const selector = make(probe)
      await selector.refresh(PAIR)

      const small = selector.select(PAIR, SMALL, 100n)
      expect(small.map(estimate => [estimate.venue, estimate.clamped])).toEqual([
        ['1inch', false],
        ['0x', true]
      ])
    })

    it('reports a wholly failed refresh as cold rather than as a zero-cost curve', async () => {
      const probe = fakeProbe({}) // every rung throws
      const selector = make(probe)
      await selector.refresh(PAIR)

      expect(probe.calls).toHaveLength(4)
      expect(selector.select(PAIR, SMALL, 100n)).toEqual([])
    })
  })
})
