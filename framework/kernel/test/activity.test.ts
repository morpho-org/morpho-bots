import { describe, expect, it } from 'vitest'

import type { KernelActivity, ReleasePayload } from '../src'

import {
  ecrecoverPlan,
  liquidationPlan,
  offer,
  publish,
  setterPlan,
  signTree,
  T,
  tree,
  W
} from './fixtures'
import { Harness } from './harness'
import { treeRoot } from './validators'

const shape = (activity: readonly KernelActivity[]) =>
  activity.map((a): string => {
    switch (a.type) {
      case 'sent':
        return `sent ${a.intentId}#${a.step} ${a.kind} ${a.status}`
      case 'released':
        return `released ${a.intentId}#${a.step} ${a.outcome}`
      case 'included':
        return `included ${a.intentId}#${a.step}`
      case 'entry':
        return `entry ${a.from ?? '-'}>${a.to}`
      case 'notice':
        return `notice ${a.intentId} ${a.notice}`
      case 'alarm':
        return `alarm ${a.reason}`
      case 'final':
        return `final ${a.nonce}`
      case 'running':
        return 'running'
      default: {
        const unhandled: never = a
        throw new Error(`unhandled activity ${JSON.stringify(unhandled)}`)
      }
    }
  })

describe('activity', () => {
  it('names a fresh enrollment running once its nonce at safe matches latest and its first flush lands', () => {
    const h = new Harness()
    h.boot('enrolling', null)
    h.head(1)
    const nonceAt = (safe: number) =>
      h.send({ type: 'NonceAt', block: 1, blockHash: h.hash(1), latest: 3, pending: 3, safe })
    nonceAt(2)
    expect(shape(h.activity)).toEqual([])
    const commands = nonceAt(3)
    expect(shape(h.activity)).toEqual([])
    expect(commands.filter(c => c.type === 'flush').length).toBe(1)
    h.flush()
    expect(shape(h.activity)).toEqual(['running'])
    h.crash()
    h.boot()
    h.head(2)
    h.send({ type: 'NonceAt', block: 2, blockHash: h.hash(2), latest: 3, pending: 3, safe: 2 })
    expect(shape(h.activity)).toEqual(['running', 'running'])
  })

  it('a liquidation names its send, then its inclusion, then its settlement', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.drive()
    h.head()
    h.mine(h.candidate('0xexec').hash)
    expect(shape(h.activity)).toEqual([
      'running',
      'notice liq admitted',
      'sent liq#0 step accepted',
      'included liq#0',
      'notice liq settled'
    ])
  })

  it('names a step mined and pruned before a later step settles the plan', () => {
    const h = new Harness().start()
    h.send({
      type: 'Submit',
      plan: setterPlan('q', tree(offer('g1', 100n, { ratifier: W.setter })))
    })
    h.drive()
    h.head(5)
    h.mine(h.candidate('0xsetIsRootRatified').hash)
    h.finalize(h.block)
    h.advance('q')
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    expect(h.activity.filter(a => a.type === 'included').map(a => a.step)).toEqual([0, 1])
    expect(shape(h.activity).at(-1)).toBe('notice q settled')
  })

  it('names only the canonical inclusion of a step a reorg orphaned after its plan moved on', () => {
    const h = new Harness().start()
    h.send({
      type: 'Submit',
      plan: setterPlan('q', tree(offer('g1', 100n, { ratifier: W.setter })))
    })
    h.drive()
    h.head(5)
    const ratified = h.candidate('0xsetIsRootRatified').hash
    h.mine(ratified)
    h.reorg(4)
    expect(h.state.plans.q?.included).toEqual([])
    h.head()
    h.head()
    h.mine(ratified)
    h.finalize(h.block)
    h.advance('q')
    h.drive()
    h.head()
    const published = h.candidate('0xpublish').hash
    h.mine(published)
    const settled = h.commands('notify').find(c => c.notice === 'settled')
    expect(settled?.included).toEqual([
      { step: 0, hash: ratified, block: 6, success: true },
      { step: 1, hash: published, block: h.block, success: true }
    ])
    expect(
      h.activity.flatMap(a => (a.type === 'included' ? [`${a.step}@${a.block}`] : []))
    ).toEqual(['0@5', '0@6', `1@${h.block}`])
  })

  it('reports no send or entry a restart restores, but still reports what happens to them next', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n))
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', t) })
    h.sign()
    h.materialize(signatures => publish(t, signatures[0]), t)
    h.drive()
    h.head()
    const published = h.candidate('0xpublish').hash
    h.redeploy(h.config)
    h.activity.length = 0
    h.boot()
    expect(h.activity).toEqual([])
    h.head()
    h.nonceAt(h.state.nextNonce!)
    h.send({ type: 'Seen', hash: published })
    h.mine(published)
    expect(shape(h.activity)).toEqual(['sent q#1 step accepted', 'entry exposed>live'])
  })

  it("surfaces the neutralizer a stop sends on its own, which no bot's plan names", () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n))
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', t) })
    h.sign()
    h.materialize(signatures => publish(t, signatures[0]), t)
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    h.activity.length = 0
    h.send({ type: 'Stop' })
    h.drive()
    h.head()
    h.mine(h.candidate('0xsetConsumed').hash)
    h.finalize(h.block)
    expect(shape(h.activity)).toEqual([
      'alarm stop requested',
      'entry live>revoking',
      expect.stringMatching(/^sent recovery:neutralizer:\S+#0 neutralizer accepted$/),
      expect.stringMatching(/^included recovery:neutralizer:/),
      'final 0',
      'final 1',
      'entry revoking>retired'
    ])
  })

  it('names a send whose nonce record the same transition prunes', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.simulate()
    h.sign()
    h.flush()
    h.head()
    h.mine(h.candidate('0xexec').hash)
    h.finalize(h.block)
    h.broadcast()
    expect(h.state.nonces).toEqual({})
    expect(shape(h.activity)).toContain('sent liq#0 step accepted')
  })

  it('names the inclusion of a neutralizer first seen at finality', () => {
    const h = new Harness().start()
    const t = tree(offer('g1', 300n))
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', t) })
    h.sign()
    h.materialize(signatures => publish(t, signatures[0]), t)
    h.drive()
    h.head()
    h.mine(h.candidate('0xpublish').hash)
    h.send({ type: 'Stop' })
    h.drive()
    h.head(h.block + 1, h.block + 1)
    h.mine(h.candidate('0xsetConsumed').hash)
    expect(Object.keys(h.state.plans)).toEqual([])
    expect(shape(h.activity)).toContainEqual(
      expect.stringMatching(/^included recovery:neutralizer:/)
    )
  })

  it('names the inclusion of a reverted step that compensates and prunes at once', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: liquidationPlan('liq') })
    h.drive()
    h.head(h.block + 1, h.block + 1)
    h.mine(h.candidate('0xexec').hash, { status: 'reverted' })
    expect(shape(h.activity).slice(-4)).toEqual([
      'included liq#0',
      'final 0',
      'notice liq compensating',
      'notice liq compensated'
    ])
  })

  it('names an entry dropped when its plan fails before exposure', () => {
    const h = new Harness().start()
    h.send({ type: 'Submit', plan: ecrecoverPlan('q', tree(offer('g1', 300n))) })
    h.sign()
    h.send({ type: 'EffectFailed', request: h.pending('materialize')[0]!.request })
    expect(shape(h.activity)).toEqual([
      'running',
      'entry ->intended',
      'notice q admitted',
      'entry intended>signed',
      'entry signed>dropped',
      'notice q abandoned'
    ])
  })

  it('reports a release whose outcome is unknown', () => {
    const h = new Harness().start()
    const release: ReleasePayload = {
      kind: 'release',
      channel: 'midnight-api',
      message: { root: treeRoot(T), signature: `sig(${treeRoot(T)})` }
    }
    h.send({
      type: 'Submit',
      plan: {
        intentId: 'q',
        steps: [
          { kind: 'sign', payload: signTree(T), witness: T },
          { kind: 'release', payload: release, witness: T }
        ],
        notAfter: 1_000_000,
        basisBlock: 0
      }
    })
    h.sign()
    h.flush()
    h.release('unknown')
    expect(shape(h.activity)).toEqual([
      'running',
      'entry ->intended',
      'notice q admitted',
      'entry intended>exposed',
      'released q#1 unknown',
      'notice q settled'
    ])
  })
})
