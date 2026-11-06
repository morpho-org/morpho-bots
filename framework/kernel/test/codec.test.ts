import { afterEach, describe, expect, it } from 'vitest'

import { asStored, storedText } from '../src/durable'

const removeToJson = () => {
  delete (BigInt.prototype as { toJSON?: unknown }).toJSON
}

describe('the durable codec', () => {
  afterEach(removeToJson)

  it('keeps a bigint a bigint when a host installs BigInt.prototype.toJSON', () => {
    // oxlint-disable-next-line eslint/no-extend-native -- the host polyfill this test guards against
    Object.defineProperty(BigInt.prototype, 'toJSON', {
      configurable: true,
      value(this: bigint) {
        return this.toString()
      }
    })
    const payload = { kind: 'tx', to: '0x01', data: '0x', value: 0n, nested: [{ cap: 7n }] }

    expect(asStored(payload)?.value).toStrictEqual(payload)
    expect(storedText(payload)).toBe(
      '{"kind":"tx","to":"0x01","data":"0x","value":{"$bigint":"0"},"nested":[{"cap":{"$bigint":"7"}}]}'
    )
  })

  it('keeps a bigint a bigint when the host polyfill returns a number', () => {
    // oxlint-disable-next-line eslint/no-extend-native -- the host polyfill this test guards against
    Object.defineProperty(BigInt.prototype, 'toJSON', {
      configurable: true,
      value(this: bigint) {
        return Number(this)
      }
    })
    const payload = { value: 2n ** 60n }

    expect(asStored(payload)?.value).toStrictEqual(payload)
  })

  it('still tags a bigint returned by a value’s own toJSON', () => {
    expect(storedText({ toJSON: () => 7n })).toBe('{"$bigint":"7"}')
  })
})
