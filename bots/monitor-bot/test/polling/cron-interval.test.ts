import { describe, expect, it } from 'vitest'

import { intervalToCron } from '../../src/polling/cron-interval'

describe('intervalToCron', () => {
  it('maps sub-minute divisors of 60 to a seconds-step cron', () => {
    expect(intervalToCron(1)).toBe('*/1 * * * * *')
    expect(intervalToCron(5)).toBe('*/5 * * * * *')
    expect(intervalToCron(15)).toBe('*/15 * * * * *')
    expect(intervalToCron(30)).toBe('*/30 * * * * *')
  })

  it('maps exactly a minute to a once-per-minute cron', () => {
    expect(intervalToCron(60)).toBe('0 * * * * *')
  })

  it('maps whole-minute multiples that divide 60 to a minute-step cron', () => {
    expect(intervalToCron(120)).toBe('0 */2 * * * *')
    expect(intervalToCron(300)).toBe('0 */5 * * * *')
    expect(intervalToCron(1800)).toBe('0 */30 * * * *')
  })

  it('rejects sub-minute values that would drift within each minute', () => {
    expect(() => intervalToCron(45)).toThrow(/drift within each minute/)
    expect(() => intervalToCron(7)).toThrow(/divisor of 60/)
  })

  it('rejects over-a-minute values that are not whole-minute multiples', () => {
    expect(() => intervalToCron(90)).toThrow(/whole-minute multiple/)
  })

  it('rejects whole-minute multiples that would drift across the hour', () => {
    // 420s = 7m; 7 does not divide 60, so `0 */7 * * * *` drifts at the hour boundary.
    expect(() => intervalToCron(420)).toThrow(/drift across the hour/)
  })

  it('rejects non-positive and non-integer inputs', () => {
    expect(() => intervalToCron(0)).toThrow(/positive integer/)
    expect(() => intervalToCron(-30)).toThrow(/positive integer/)
    expect(() => intervalToCron(1.5)).toThrow(/positive integer/)
  })
})
