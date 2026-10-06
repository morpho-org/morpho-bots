import type { Hex } from 'viem'

import { bytesToHex, getAddress, hexToBytes } from 'viem'
import { describe, expect, test } from 'vitest'

import {
  acceptedLossFactorValue,
  parseAddress,
  parseBytes32,
  referenceLookbackSecondsValue
} from '../../src/config/config.utils'
import { MAX_LOSS_FACTOR } from '../../src/domain/loss-factor'

describe('config viem parsing utilities', () => {
  test('normalizes lowercase and valid mixed-case addresses to checksum form', () => {
    const lower = '0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a'
    expect(parseAddress(lower, 'ADDRESS')).toBe(getAddress(lower))
    expect(parseAddress(getAddress(lower), 'ADDRESS')).toBe(getAddress(lower))
  })

  test('normalizes arbitrary mixed case and rejects malformed addresses', () => {
    expect(() => parseAddress('0x1234', 'ADDRESS')).toThrow('ADDRESS must be an EVM address')
    expect(parseAddress('0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2b', 'ADDRESS')).toBe(
      getAddress('0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2b')
    )
    expect(() => parseAddress('0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2z', 'ADDRESS')).toThrow(
      'ADDRESS must be an EVM address'
    )
  })

  test('accepts exactly 32 bytes and rejects adjacent size boundaries', () => {
    expect(parseBytes32(`0x${'11'.repeat(32)}`, 'ID')).toBe(`0x${'11'.repeat(32)}`)
    expect(() => parseBytes32(`0x${'11'.repeat(31)}`, 'ID')).toThrow('32-byte')
    expect(() => parseBytes32(`0x${'11'.repeat(33)}`, 'ID')).toThrow('32-byte')
    expect(() => parseBytes32('0xzz', 'ID')).toThrow('32-byte')
  })

  test('canonicalizes mixed-case bytes32 values through viem', () => {
    const mixedCase: Hex = `0x${'aB'.repeat(32)}`

    expect(parseBytes32(mixedCase, 'ID')).toBe(bytesToHex(hexToBytes(mixedCase)))
  })
})

describe('referenceLookbackSecondsValue', () => {
  test('defaults to three days when absent or blank', () => {
    expect(referenceLookbackSecondsValue({})).toBe(259_200n)
    expect(referenceLookbackSecondsValue({ REFERENCE_LOOKBACK_SECONDS: '   ' })).toBe(259_200n)
  })

  test('accepts an explicit window inside the supported range', () => {
    expect(referenceLookbackSecondsValue({ REFERENCE_LOOKBACK_SECONDS: '21600' })).toBe(21_600n)
    expect(referenceLookbackSecondsValue({ REFERENCE_LOOKBACK_SECONDS: ' 3600 ' })).toBe(3_600n)
    expect(referenceLookbackSecondsValue({ REFERENCE_LOOKBACK_SECONDS: '2592000' })).toBe(
      2_592_000n
    )
  })

  test('rejects windows outside one hour through thirty days', () => {
    for (const value of ['0', '3599', '2592001']) {
      expect(() => referenceLookbackSecondsValue({ REFERENCE_LOOKBACK_SECONDS: value })).toThrow(
        'REFERENCE_LOOKBACK_SECONDS must be between 3600 and 2592000'
      )
    }
  })

  test('rejects non-decimal notation rather than coercing it', () => {
    for (const value of ['2.592e5', '+259200', '259200.0', '0x3f480', 'three days']) {
      expect(() => referenceLookbackSecondsValue({ REFERENCE_LOOKBACK_SECONDS: value })).toThrow(
        'REFERENCE_LOOKBACK_SECONDS must be a decimal integer'
      )
    }
  })
})

describe('acceptedLossFactorValue', () => {
  const marketId: Hex = `0x${'55'.repeat(32)}`
  const otherMarketId: Hex = `0x${'ab'.repeat(32)}`
  const otherMarketIdUpper = `0x${'AB'.repeat(32)}`
  const reason = (input: unknown) => {
    try {
      acceptedLossFactorValue(input, [marketId, otherMarketId])
    } catch (error) {
      return (error as { reason?: string }).reason
    }
    return undefined
  }

  test('defaults to no accepted markets, so every market accepts zero', () => {
    expect(acceptedLossFactorValue(undefined, [marketId])).toEqual(new Map())
  })

  test('canonicalizes market ids and parses exact decimal values up to the maximum minus one', () => {
    expect(
      acceptedLossFactorValue(
        { [marketId]: '0', [otherMarketIdUpper]: String(MAX_LOSS_FACTOR - 1n) },
        [marketId, otherMarketId]
      )
    ).toEqual(
      new Map([
        [marketId, 0n],
        [otherMarketId, MAX_LOSS_FACTOR - 1n]
      ])
    )
  })

  test.each([
    [
      'the maximum, which would disable the guard',
      { [marketId]: String(MAX_LOSS_FACTOR) },
      'out-of-range'
    ],
    ['a value above the maximum', { [marketId]: String(MAX_LOSS_FACTOR + 1n) }, 'out-of-range'],
    ['an unknown market', { [`0x${'77'.repeat(32)}`]: '1' }, 'unknown-market'],
    [
      'a market repeated in another case',
      { [otherMarketId]: '1', [otherMarketIdUpper]: '2' },
      'duplicate'
    ],
    ['a non-canonical decimal', { [marketId]: '01' }, 'invalid-unsigned-integer'],
    ['a negative value', { [marketId]: '-1' }, 'invalid-unsigned-integer'],
    ['a number rather than a string', { [marketId]: 1n }, 'invalid-unsigned-integer'],
    ['a malformed market id', { '0x1234': '1' }, 'invalid-bytes32'],
    ['a list', [marketId], 'wrong-type'],
    ['a scalar', '1', 'wrong-type']
  ])('rejects %s', (_name, input, expected) => {
    expect(reason(input)).toBe(expected)
  })
})
