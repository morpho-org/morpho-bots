import { describe, expect, test } from 'bun:test'

import type { TargetRateInput } from '../../playground/model'

import { visibleFields } from '../../playground/field-visibility.utils'

const fields = [
  ['targetRate.strategy', 'Strategy', 'Rate strategy', 'select'],
  ['targetRate.hardcodedRateBps', 'Hardcoded rate', 'Static rate', 'number'],
  ['spreadBps', 'Spread', 'Ladder spread', 'number']
] as const

const keysFor = (targetRate: TargetRateInput) =>
  visibleFields(fields, targetRate).map(([key]) => key)

describe('playground field visibility', () => {
  test('shows the hardcoded rate only for hardcoded target-rate strategies', () => {
    expect(keysFor({ strategy: 'variable_rate_avg' })).toEqual(['targetRate.strategy', 'spreadBps'])
    expect(keysFor({ strategy: 'hardcoded', hardcodedRateBps: '500' })).toEqual([
      'targetRate.strategy',
      'targetRate.hardcodedRateBps',
      'spreadBps'
    ])
  })
})
