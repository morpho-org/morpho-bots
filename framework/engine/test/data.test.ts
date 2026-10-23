import { describe, expect, it } from 'vitest'

import { createGraph, createRunner, decode, encode, every, NotDataError } from '../src/index'

describe('encode', () => {
  it('encodes equal data identically whatever the field order', () => {
    expect(encode({ b: 1, a: [true, null, 'x'] })).toBe(encode({ a: [true, null, 'x'], b: 1 }))
  })

  it('drops undefined fields', () => {
    expect(encode({ a: 1, b: undefined })).toBe(encode({ a: 1 }))
  })

  it('round-trips bigints', () => {
    const value = { amount: 12345678901234567890123n, nested: [-1n] }
    expect(decode(encode(value))).toStrictEqual(value)
  })

  it('tells a bigint from the same digits as a number or string', () => {
    expect(encode(5n)).not.toBe(encode(5))
    expect(encode(5n)).not.toBe(encode('5'))
  })

  it.each([
    ['a Map', new Map()],
    ['a Date', new Date(0)],
    ['NaN', Number.NaN],
    ['a function', () => 1],
    ['undefined in a list', [1, undefined]],
    ['the reserved bigint field', { $bigint: '1' }]
  ])('refuses %s', (_, value) => {
    expect(() => encode(value)).toThrow(NotDataError)
  })
})

class Position {
  constructor(readonly debt: number) {}
}

describe('fold state', () => {
  it.each([
    ['a Map', new Map([['a', 1]])],
    ['a Set', new Set([1])],
    ['a class instance', new Position(1)]
  ])('refuses %s, stopping the runner and keeping the state it had', async (_, held) => {
    const g = createGraph('fold-state')
    const ticks = g.occurrences<number>('ticks')
    const state = g.fold('state', {
      reads: { tick: every(ticks) },
      initial: {} as Readonly<{ held?: unknown }>,
      applyInput: () => ({ state: { held } })
    })
    const runner = createRunner(g.build())
    runner.push(ticks, 1)
    await expect(runner.stopped).rejects.toBeInstanceOf(NotDataError)
    expect(runner.read(state)).toStrictEqual({})
  })
})
