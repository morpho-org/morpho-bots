import { describe, expect, it } from 'vitest'

import { ecrecoverPlan, liquidationPlan, makeConfig, publish, T } from './fixtures'
import { Harness } from './harness'
import { midnightId } from './validators'

const LIQ = 'liq:K1'

/** Holds headers for simulation alone, so only a pin keeps an older one. */
const SIMULATION_WINDOW_ONLY = makeConfig({ maxEvidenceAgeBlocks: 0 })

/** The lowest block whose header the kernel must still hold. */
const windowFloor = (h: Harness) =>
  Math.min(h.state.finalized.number, h.block - h.config.maxEvidenceAgeBlocks)

describe('headers the kernel checks evidence against', () => {
  it('a restart resolves a transaction mined before it, once the block is vouched for', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan(LIQ) })
    h.drive()
    const { hash } = h.candidate('0xexec')
    h.head()
    const minedAt = h.block
    for (let i = 0; i < 20; i++) h.head()
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(1)
    h.mine(hash, { block: minedAt })
    expect(h.state.nonces[0]?.resolution).toBeUndefined()

    h.send({ type: 'Header', number: minedAt, hash: h.hash(minedAt) })
    h.mine(hash, { block: minedAt })
    expect(h.state.nonces[0]).toBeUndefined()
  })

  it('a vouched header that contradicts a known one is a reorg below finality', () => {
    const h = new Harness().start()
    h.finalize(10)
    h.send({ type: 'Header', number: h.state.finalized.number, hash: '0xother' })
    expect(h.alarms()).toContain('finality violated')
  })

  it('a header from beyond the head is ignored', () => {
    const h = new Harness().start()
    h.send({ type: 'Header', number: h.block + 5, hash: '0xfuture' })
    expect(h.state.headers[h.block + 5]).toBeUndefined()
  })

  it('keeps the header a resolution names until the resolution is consumed', () => {
    const h = new Harness(SIMULATION_WINDOW_ONLY).start()
    h.send({ type: 'Submit', plan: liquidationPlan(LIQ) })
    h.simulate()
    h.sign()
    h.flush()
    h.head()
    h.mine(h.candidate('0xexec').hash)
    for (let i = 0; i < 5; i++) h.head()
    h.broadcast()
    expect(h.notices(LIQ)).toEqual(['admitted', 'settled'])
    expect(h.state.nonces).toEqual({})
  })

  it('keeps the header a waiting commit simulated at, so its dispatch is not mistaken for a reorg', () => {
    const h = new Harness(SIMULATION_WINDOW_ONLY).start()
    h.send({ type: 'Submit', plan: liquidationPlan(LIQ) })
    h.simulate()
    h.sign()
    h.head(h.block + 1, h.block + 1)
    h.head(h.block + 1, h.block + 1)
    h.flush()
    expect(h.commands('broadcast')).toHaveLength(1)
    expect(h.notices(LIQ)).toEqual(['admitted'])
  })

  it('releases the headers a retired entry named, so completed offers do not grow the window', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', T) })
    h.sign()
    h.materialize(signatures => publish(T, signatures[0]), T)
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    h.observe(midnightId('g1'), 300n)
    h.finalize(h.block)
    expect(h.entry(midnightId('g1'))?.state).toBe('retired')
    for (let i = 0; i < h.config.maxEvidenceAgeBlocks + 20; i++) h.head()
    const kept = Object.keys(h.state.headers).map(Number)
    expect(Math.min(...kept)).toBeGreaterThanOrEqual(windowFloor(h) - 1)
  })

  it('keeps only the headers above finality or the evidence age bound, so a long run holds a bounded window', () => {
    const h = new Harness().start()
    for (let i = 0; i < 500; i++) h.head()
    const kept = Object.keys(h.state.headers).map(Number)
    expect(Math.min(...kept)).toBeGreaterThanOrEqual(windowFloor(h) - 1)
    expect(kept.length).toBeLessThanOrEqual(h.block - windowFloor(h) + 2)
  })

  it('holds every header the evidence age bound admits a fact at, below finality too', () => {
    const h = new Harness().start()
    for (let i = 0; i < 500; i++) h.head()
    const oldest = h.block - h.config.maxEvidenceAgeBlocks
    expect(oldest).toBeLessThan(h.state.finalized.number)
    expect(h.state.headers[oldest]).toBe(h.hash(oldest))
  })
})

describe('finality', () => {
  it('takes a finality time only with a newly final block, never at the same height', () => {
    const h = new Harness().start()
    h.send({
      type: 'Head',
      number: 5,
      hash: h.hash(5),
      timestamp: 10n,
      finalized: -1,
      finalizedTimestamp: 99n
    })
    expect(h.state.finalized).toStrictEqual({ number: -1, timestamp: 0n })
  })
})
