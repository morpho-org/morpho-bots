import { describe, expect, it } from 'bun:test'

import { delay } from '../src/delay'

describe('delay', () => {
  it('resolves after at least the specified duration', async () => {
    const start = performance.now()
    await delay(50)
    const elapsed = performance.now() - start

    expect(elapsed).toBeGreaterThanOrEqual(45)
  })

  it('resolves immediately with 0ms', async () => {
    let resolved = false
    await delay(0).then(() => {
      resolved = true
    })

    expect(resolved).toBe(true)
  })
})
