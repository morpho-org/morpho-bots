import { describe, expect, test } from 'vitest'

import {
  DEFAULT_REFERENCE_RATE_BPS,
  resolveCreditHeldAssets,
  resolveReferenceRateBps
} from '../../playground/reference-rate.utils'

describe('resolveReferenceRateBps', () => {
  test('resolves a positive integer entry to BPS', () => {
    expect(resolveReferenceRateBps('1')).toBe(1n)
    expect(resolveReferenceRateBps('500')).toBe(500n)
    expect(resolveReferenceRateBps(' 650 ')).toBe(650n)
    expect(resolveReferenceRateBps('100000000000000000000')).toBe(100000000000000000000n)
  })

  test('leaves an unusable entry unresolved rather than assuming a rate', () => {
    for (const entry of ['', '   ', '-50', '5.5', '5e2', '0x1f4', 'abc', '5,0']) {
      expect(resolveReferenceRateBps(entry)).toBeUndefined()
    }
  })

  test('rejects zero, which the runtime reference read throws on before it quotes', () => {
    expect(resolveReferenceRateBps('0')).toBeUndefined()
    expect(resolveReferenceRateBps('00')).toBeUndefined()
  })

  test('starts empty so the preview never presents a guessed market rate', () => {
    expect(DEFAULT_REFERENCE_RATE_BPS).toBe('')
    expect(resolveReferenceRateBps(DEFAULT_REFERENCE_RATE_BPS)).toBeUndefined()
  })
})

describe('resolveCreditHeldAssets', () => {
  test('resolves a non-negative integer entry, including zero', () => {
    expect(resolveCreditHeldAssets('0')).toBe(0n)
    expect(resolveCreditHeldAssets(' 1500 ')).toBe(1500n)
  })

  test('leaves an empty or unusable entry unresolved', () => {
    for (const entry of ['', '  ', '-1', '1.5', '1e3', 'abc']) {
      expect(resolveCreditHeldAssets(entry)).toBeUndefined()
    }
  })
})
