import { describe, expect, it } from 'vitest'

import { liquidationPlan } from './fixtures'
import { Harness } from './harness'

describe('state bounded by live work, not by history', () => {
  it('drops a settled plan once its nonce resolves, and keeps it while the record is open', () => {
    const h = new Harness().start()
    for (let i = 0; i < 30; i++) {
      h.send({ type: 'Submit', plan: liquidationPlan(`liq:${i}`) })
      h.drive()
      h.head()
      const candidate = h.candidates().find(c => c.intentId === `liq:${i}`)!
      h.mine(candidate.hash)
      expect(h.state.plans[`liq:${i}`]).toBeDefined()
      h.finalize(h.block)
    }
    expect(h.notices('liq:29')).toEqual(['admitted', 'settled'])
    expect(Object.keys(h.state.plans)).toEqual([])
    expect(h.state.planOrder).toEqual([])
  })
})
