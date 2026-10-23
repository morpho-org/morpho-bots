import { describe, expect, it } from 'vitest'

import type { DurableLedger, Validator } from '../src'

import { decodeLedger, LEDGER_FORMAT } from '../src'
import { encodeLedger } from '../src/testing'
import { encodeCall } from './codec'
import { ecrecoverPlan, liquidationPlan, makeConfig, offer, publish, T, tree, W } from './fixtures'
import { Harness } from './harness'
import { midnightId } from './validators'

const G1 = midnightId('g1')
const withLiveOffer = () => {
  const h = new Harness().start().liveOffer()
  h.finalize(h.block)
  h.flush()
  return h
}

const refusal = (h: Harness) => h.commands('report').at(-1)

describe('the durable ledger', () => {
  it('a missing ledger for an enrolled account refuses to start rather than assuming no history', () => {
    const h = new Harness()
    h.boot('enrolled', null)
    expect(h.state.lifecycle).toMatchObject({ kind: 'stopped', outcome: 'refused' })
    expect(refusal(h)?.reason).toMatch(/ledger missing/)
  })

  it.each([
    ['account', { account: '0xOther' }],
    ['chain', { chainId: 1 }]
  ])('a ledger bound to another %s refuses to start', (_, header) => {
    const h = withLiveOffer()
    const foreign = decodeLedger(h.disk!)
    expect(foreign.header).not.toMatchObject(header)
    Object.assign(foreign.header, header)
    h.crash()
    h.boot('enrolled', foreign)
    expect(h.state.lifecycle).toMatchObject({ kind: 'stopped', outcome: 'refused' })
    expect(refusal(h)?.reason).toMatch(/another chain or account/)
  })

  it('a ledger naming the account in another letter case still starts', () => {
    const h = withLiveOffer()
    const stored = decodeLedger(h.disk!)
    h.crash()
    h.boot('enrolled', {
      ...stored,
      header: { ...stored.header, account: W.account.toUpperCase() }
    })
    expect(h.state.lifecycle.kind).not.toBe('stopped')
  })

  it.each([
    [1, 'unknown format'],
    [LEDGER_FORMAT + 1, 'unknown format'],
    [String(LEDGER_FORMAT), 'unknown format'],
    [undefined, 'unknown format']
  ])('a ledger in format %j refuses to start', (format, reason) => {
    const h = withLiveOffer()
    const stored = decodeLedger(h.disk!)
    expect(stored.header.format).toBe(LEDGER_FORMAT)
    h.crash()
    h.boot('enrolled', { ...stored, header: { ...stored.header, format } })
    expect(h.state.lifecycle).toMatchObject({ kind: 'stopped', outcome: 'refused' })
    expect(refusal(h)?.reason).toBe(`malformed ledger: ${reason}`)
  })

  it('a rolled-back ledger is caught when the chain nonce is ahead of it', () => {
    const h = withLiveOffer()
    const snapshot = h.disk
    h.send({
      type: 'Submit',
      plan: {
        intentId: 'liq',
        steps: [{ kind: 'tx', payload: encodeCall(W.executor, 'exec') }],
        notAfter: 1_000_000,
        basisBlock: 0
      }
    })
    h.drive()
    h.disk = snapshot
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(2)
    expect(refusal(h)?.reason).toMatch(/nonce ahead of the ledger/)
  })

  it('a rolled-back ledger is caught when only the pending nonce is ahead of it', () => {
    const h = withLiveOffer()
    h.crash()
    h.boot()
    h.head()
    h.nonceAt(1, 2)
    expect(refusal(h)?.reason).toBe('chain nonce ahead of the ledger')
  })

  it('a fresh enrollment over an unrecorded pending transaction refuses to start', () => {
    const h = new Harness()
    h.boot('enrolling', null)
    h.head(1)
    h.nonceAt(3, 4)
    expect(h.state.lifecycle).toMatchObject({ kind: 'stopped', outcome: 'refused' })
    expect(refusal(h)?.reason).toBe('unrecorded pending transaction')
  })

  it('a fresh enrollment adopts the chain nonce when nothing is pending', () => {
    const h = new Harness()
    h.boot('enrolling', null)
    h.head(1)
    h.nonceAt(3, 3)
    expect(h.state.nextNonce).toBe(3)
    expect(h.state.lifecycle.kind).not.toBe('stopped')
  })

  it('an enrollment against an account that already has a ledger refuses', () => {
    const h = withLiveOffer()
    h.crash()
    h.boot('enrolling')
    expect(refusal(h)?.reason).toMatch(/already has a ledger/)
  })

  it('the codec round-trips bigints exactly', () => {
    const h = withLiveOffer()
    const ledger = decodeLedger(h.disk!)
    expect(ledger.entries[G1]?.spec.resources[W.loan]).toBe(300n)
    expect(encodeLedger(ledger)).toBe(h.disk)
  })

  it('recovery after a config change removed the market cancels from the stored neutralizer', () => {
    const h = withLiveOffer()
    h.redeploy(makeConfig({ markets: [] }))
    h.boot()
    h.head()
    h.nonceAt(1)
    h.observe(G1)
    expect(h.state.lifecycle.kind).toBe('running')
    h.send({ type: 'Submit', plan: ecrecoverPlan('q:again', tree(offer('g9', 10n))) })
    expect(h.commands('notify').at(-1)).toMatchObject({
      notice: 'refused',
      code: 'unauthorized',
      reason: 'market M1 not allowlisted'
    })
    h.send({ type: 'Stop' })
    h.drive()
    h.head()
    h.mine(h.candidate('0xsetConsumed').hash)
    h.finalize(h.block)
    expect(h.reports()).toHaveLength(0)
    h.flush()
    expect(h.state.lifecycle).toMatchObject({ kind: 'stopped', outcome: 'clean' })
  })

  it('a config whose recovery policy can no longer neutralize an owned entry refuses to start', () => {
    const h = withLiveOffer()
    const config = makeConfig()
    h.redeploy({ ...config, policy: { ...config.policy, recoveryTargets: [W.account] } })
    h.boot()
    expect(refusal(h)?.reason).toMatch(/cannot neutralize midnight:g1/)
  })

  it('the recovery policy refuses a stored neutralizer whose reading also creates exposure', () => {
    const h = withLiveOffer()
    const config = makeConfig()
    const honest = config.validators[0]!
    const extra = { ...h.entry(G1)!.spec, id: midnightId('g-extra') }
    const greedy: Validator = {
      ...honest,
      read: (payload, evidence, context) => {
        const reading = honest.read(payload, evidence, context)
        if (!reading.ok || reading.retires.length === 0) return reading
        return { ...reading, creates: [extra] }
      }
    }
    h.redeploy({ ...config, validators: [greedy, config.validators[1]!] })
    h.boot()
    expect(refusal(h)?.reason).toMatch(/cannot neutralize midnight:g1/)
  })

  it('a stored neutralizer that calls the account with calldata is refused at start', () => {
    const h = withLiveOffer()
    const ledger = h.ledger()!
    ledger.entries[G1]!.spec.neutralizer = { kind: 'tx', to: W.account, data: '0x01', value: 0n }
    h.crash()
    h.boot('enrolled', ledger)
    expect(refusal(h)?.reason).toMatch(/cannot neutralize midnight:g1/)
  })

  it('a stored payload whose calldata is not hex makes the ledger malformed', () => {
    const h = withLiveOffer()
    const ledger = h.ledger()!
    ledger.entries[G1]!.spec.neutralizer = { kind: 'tx', to: W.midnight, data: '0xzz', value: 0n }
    h.crash()
    h.boot('enrolled', ledger)
    expect(refusal(h)?.reason).toMatch(/^malformed ledger/)
  })

  it('a validator that throws is a refusal, not a crash', () => {
    const config = makeConfig()
    const throwing: Validator = {
      ...config.validators[0]!,
      read: () => {
        throw new Error('decoder bug')
      }
    }
    const h = new Harness({ ...config, validators: [throwing, config.validators[1]!] }).start()
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', T) })
    expect(h.commands('notify').at(-1)).toMatchObject({
      notice: 'refused',
      code: 'unauthorized',
      reason: 'validator midnight-offers threw'
    })
  })

  it('an upgrade that still accepts the recorded validator version starts and can neutralize', () => {
    const h = withLiveOffer()
    const config = makeConfig()
    const upgraded: Validator = { ...config.validators[0]!, version: 2, accepts: [1] }
    h.redeploy({ ...config, validators: [upgraded, ...config.validators.slice(1)] })
    h.boot()
    h.head()
    h.nonceAt(1)
    h.observe(G1)
    expect(h.state.lifecycle.kind).toBe('running')
    h.send({ type: 'Stop' })
    h.drive()
    expect(h.candidate('0xsetConsumed').retires).toEqual([G1])
  })

  it('an upgrade that drops the validator version an entry was recorded under refuses to start', () => {
    const h = withLiveOffer()
    const config = makeConfig()
    const upgraded: Validator = { ...config.validators[0]!, version: 2 }
    h.redeploy({ ...config, validators: [upgraded, config.validators[1]!] })
    h.boot()
    expect(refusal(h)?.reason).toMatch(/cannot neutralize/)
  })

  it('refuses a ledger whose conflict marks are missing or malformed', () => {
    const h = new Harness().start()
    const { conflictMarks: _, ...without } = decodeLedger(h.disk!)
    const printable = 'is not a short printable name'
    for (const [conflictMarks, reason] of [
      [undefined, 'missing sections'],
      [{ book: 1 }, 'missing sections'],
      [[['book', -1]], 'malformed conflict marks'],
      [[['book', 2 ** 53]], 'malformed conflict marks'],
      [[['book']], 'malformed conflict marks'],
      [[['', 1]], `malformed conflict marks: conflict id "" ${printable}`],
      [[['constructor', 1]], `malformed conflict marks: conflict id "constructor" ${printable}`],
      [
        [
          ['book', 1],
          ['book', 2]
        ],
        'malformed conflict marks: a conflict id recorded twice'
      ]
    ] as const) {
      h.crash()
      h.boot('enrolled', { ...without, conflictMarks })
      expect(refusal(h)?.reason).toBe(`malformed ledger: ${reason}`)
    }
  })

  it('refuses a ledger whose owed conflict writes are missing or malformed', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('q') })
    h.simulate()
    h.sign()
    h.flush()
    const stored = decodeLedger(h.disk!)
    const withWrites = (writes: unknown): DurableLedger => {
      const ledger = structuredClone(stored)
      Object.assign(Object.values(ledger.nonces)[0]!.candidates[0]!, { writes })
      return ledger
    }
    const { releases: _, ...without } = stored
    const printable = 'is not a short printable name'
    for (const [ledger, reason] of [
      [without, 'missing sections'],
      [{ ...stored, releases: { q: ['book'] } }, 'release q is malformed'],
      [{ ...stored, releases: { q: { writes: ['book'], after: -1 } } }, 'release q is malformed'],
      [
        { ...stored, releases: { q: { writes: 'book', after: 1 } } },
        'release q has malformed conflict writes: not a list'
      ],
      [
        { ...stored, releases: { q: { writes: ['constructor'], after: 1 } } },
        `release q has malformed conflict writes: conflict id "constructor" ${printable}`
      ],
      [withWrites(undefined), 'candidate 0.0 has malformed conflict writes: not a list'],
      [withWrites(['']), `candidate 0.0 has malformed conflict writes: conflict id "" ${printable}`]
    ] as const) {
      h.crash()
      h.boot('enrolled', ledger)
      expect(refusal(h)?.reason).toBe(`malformed ledger: ${reason}`)
    }
  })

  it('reads back a key that looks like a codec tag as the key it was', () => {
    const value = {
      $bigint: 'not a number',
      $$escaped: 1n,
      $: { $bigint: '5' },
      plain: { nested: [{ $x: 2n, y: -3n }] },
      tagged: 7n
    }
    expect(decodeLedger(encodeLedger(value as never))).toStrictEqual(value)
    expect(() => decodeLedger('{"$unknown":1}')).toThrow('unknown codec tag')
  })

  it('restarts on a ledger whose submission and commitment are both named $bigint', () => {
    const base = makeConfig().validators[0]!
    const rename = (id: string) => (id === G1 ? '$bigint' : id)
    const renamed: Validator = {
      ...base,
      read: (payload, evidence, context) => {
        const reading = base.read(payload, evidence, context)
        if (!reading.ok) return reading
        return {
          ...reading,
          creates: reading.creates.map(c => ({ ...c, id: rename(c.id) })),
          exposes: reading.exposes.map(rename),
          retires: reading.retires.map(rename)
        }
      }
    }
    const config = makeConfig({ validators: [renamed, ...makeConfig().validators.slice(1)] })
    const h = new Harness(config).start()
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', T, { submissionId: '$bigint' }) })
    h.sign()
    h.materialize(signatures => publish(T, signatures[0]), T)
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    h.flush()
    expect(h.entry('$bigint')?.state).toBe('live')
    h.crash()
    h.boot()
    expect(h.state.lifecycle.kind).toBe('starting')
    expect(h.entry('$bigint')).toMatchObject({ state: 'live', adopted: true })
    expect(h.state.submissions.$bigint).toMatchObject({ intentId: 'q', status: 'settled' })
  })

  const damage: [string, (ledger: DurableLedger) => void][] = [
    [
      'an entry in a state the ledger never persists',
      l => void Object.assign(l.entries[G1]!, { state: 'retired' })
    ],
    [
      'an amount that is not a bigint',
      l => void Object.assign(l.entries[G1]!, { consumedFinal: '0' })
    ],
    [
      'an entry without its neutralizer',
      l => void Object.assign(l.entries[G1]!.spec, { neutralizer: undefined })
    ],
    [
      'an entry without its creating payload',
      l => void Object.assign(l.entries[G1]!, { origin: undefined })
    ],
    [
      'an entry whose creating payload is of no known kind',
      l => void Object.assign(l.entries[G1]!, { origin: { payload: { kind: 'blob' } } })
    ],
    [
      'a revoking entry whose neutralizing candidate is not recorded',
      l =>
        void Object.assign(l.entries[G1]!, {
          state: 'revoking',
          neutralizing: { nonce: 7, hash: '0xgone' }
        })
    ],
    [
      'a nonce record stored under another nonce',
      l => void (l.nonces[5] = { nonce: 6, candidates: [] })
    ],
    ['a record at or above the next nonce', l => void (l.nonces[9] = { nonce: 9, candidates: [] })]
  ]

  it.each(damage)('a ledger with %s refuses to start', (_name, corrupt) => {
    const h = withLiveOffer()
    const ledger = h.ledger()!
    corrupt(ledger)
    h.crash()
    h.boot('enrolled', ledger)
    expect(h.reports().at(-1)).toMatchObject({ outcome: 'refused' })
    expect(h.reports().at(-1)?.reason).toMatch(/^malformed ledger/)
  })

  it('keeps no reference to the ledger it started from, so changing it afterwards frees nothing', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n))
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', t) })
    h.sign()
    h.materialize(signatures => publish(t, signatures[0]), t)
    h.drive()
    const ledger = h.ledger()!
    h.crash()
    h.boot('enrolled', ledger)
    ;(ledger.entries['midnight:g1']!.spec.resources as Record<string, bigint>)[W.loan] = 0n
    expect(h.state.entries['midnight:g1']?.spec.resources[W.loan]).toBe(300n)
  })

  it('refuses to start on a stored ledger whose record names an inherited property', () => {
    const h = new Harness().start()
    h.flush()
    const ledger = h.ledger()!
    Object.defineProperty(ledger.submissions, '__proto__', {
      value: { intentId: 'liq', status: 'settled', digest: 'd' },
      enumerable: true
    })
    h.crash()
    h.boot('enrolled', ledger)
    expect(h.reports().at(-1)).toMatchObject({ outcome: 'refused' })
    expect(h.reports().at(-1)?.reason).toBe(
      'malformed ledger: record __proto__ names an inherited property'
    )
  })
})
